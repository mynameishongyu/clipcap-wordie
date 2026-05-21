import { NextResponse } from 'next/server';
import {
  buildErrorLogPayload,
  logErrorEvent,
  logEvent,
} from '@/src/lib/logging/log-event';
import {
  collectGeminiFilesFromVisionPages,
  loadVisionPagesFromStoredAssets,
  type PdfPageImageAsset,
  uploadStoredPageImagesToGeminiFileApi,
} from '@/src/lib/generation-task-items/runtime';
import { cleanupGeminiUploadedFiles } from '@/src/lib/llm/gemini-file-api';
import type { PdfVisionPageInput } from '@/src/lib/llm/fill-template-from-pdf';
import { extractTemplateSlotsFromDocx } from '@/src/lib/llm/extract-template-slots';
import { buildTemplatePdfEvidence } from '@/src/lib/llm/template-pdf-evidence';
import { getLlmRuntimeConfig } from '@/src/lib/llm/provider';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

async function appendProcessingTrace(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  taskId: string,
  message: string,
) {
  await admin.rpc('append_template_extraction_task_processing_trace', {
    p_task_id: taskId,
    p_entry: `[${new Date().toISOString()}] ${message}`,
  });
}

function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: '请先登录后再继续。',
    },
    { status: 401 },
  );
}

function formatDurationMs(durationMs: number) {
  if (durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }

  return `${(durationMs / 1000).toFixed(2)}s`;
}

function getVercelMemoryUsageSnapshot(stage: string) {
  const memory = process.memoryUsage();

  return {
    stage,
    rss_bytes: memory.rss,
    heap_total_bytes: memory.heapTotal,
    heap_used_bytes: memory.heapUsed,
    external_bytes: memory.external,
    array_buffers_bytes: memory.arrayBuffers,
  };
}

async function appendMemoryTrace(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  taskId: string,
  stage: string,
  details?: Record<string, unknown>,
) {
  await appendProcessingTrace(
    admin,
    taskId,
    `[Vercel Memory][Template Extract] ${JSON.stringify({
      ...getVercelMemoryUsageSnapshot(stage),
      ...(details ?? {}),
    })}`,
  );
}

function normalizePdfVisionPages(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as PdfVisionPageInput[];
  }

  return value
    .map((item) => {
      const record =
        item && typeof item === 'object'
          ? (item as Record<string, unknown>)
          : {};
      const pageNumber = Number(record.page_number);
      const imageDataUrl = String(record.image_data_url ?? '');

      if (
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        !imageDataUrl.startsWith('data:image/')
      ) {
        return null;
      }

      return {
        page_number: pageNumber,
        image_data_url: imageDataUrl,
      };
    })
    .filter((item): item is PdfVisionPageInput => Boolean(item));
}

function normalizePdfVisionPageAssets(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as PdfPageImageAsset[];
  }

  return value
    .map((item) => {
      const record =
        item && typeof item === 'object'
          ? (item as Record<string, unknown>)
          : {};
      const uploadedPageNumber = Number(record.uploaded_page_number);
      const originalPageNumber = Number(record.original_page_number);
      const storagePath = String(record.storage_path ?? '').trim();
      const contentType = String(record.content_type ?? '').trim();
      const size = Number(record.size);
      const rotationApplied = Number(record.rotation_applied);

      if (
        !Number.isInteger(uploadedPageNumber) ||
        uploadedPageNumber < 1 ||
        !Number.isInteger(originalPageNumber) ||
        originalPageNumber < 1 ||
        !storagePath
      ) {
        return null;
      }

      const asset: PdfPageImageAsset = {
        uploaded_page_number: uploadedPageNumber,
        original_page_number: originalPageNumber,
        storage_path: storagePath,
        ...(contentType ? { content_type: contentType } : {}),
        ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
        ...(Number.isFinite(rotationApplied)
          ? {
              rotation_applied:
                rotationApplied as PdfPageImageAsset['rotation_applied'],
            }
          : {}),
      };

      return asset;
    })
    .filter((item): item is PdfPageImageAsset => Boolean(item));
}

async function resolvePdfVisionPages(input: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  sourcePdfVisionPages: unknown;
  taskId: string;
  pdfFileName: string | null;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  const storedAssets = normalizePdfVisionPageAssets(input.sourcePdfVisionPages);

  if (storedAssets.length > 0) {
    const llmConfig = getLlmRuntimeConfig('vision');

    if (llmConfig.provider === 'gemini') {
      return uploadStoredPageImagesToGeminiFileApi({
        admin: input.admin,
        pageImageAssets: storedAssets,
        config: llmConfig,
        requestLabel: `template pdf evidence ${input.taskId} ${
          input.pdfFileName ?? 'unknown-pdf'
        }`,
        onTrace: input.onTrace,
      });
    }

    await input.onTrace?.({
      message: `[Template PDF Evidence] Downloading ${storedAssets.length} page image(s) from Supabase Storage.`,
    });

    return loadVisionPagesFromStoredAssets({
      admin: input.admin,
      pageImageAssets: storedAssets,
    });
  }

  return normalizePdfVisionPages(input.sourcePdfVisionPages);
}

async function cleanupTemplatePdfEvidenceGeminiFiles(input: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  taskId: string;
  visionPages: PdfVisionPageInput[];
}) {
  const files = collectGeminiFilesFromVisionPages(input.visionPages);

  if (files.length === 0) {
    return;
  }

  const llmConfig = getLlmRuntimeConfig('vision');

  if (llmConfig.provider !== 'gemini') {
    return;
  }

  await appendProcessingTrace(
    input.admin,
    input.taskId,
    `[Gemini File API][TemplatePdfEvidenceCleanupStart] ${JSON.stringify({
      uploaded_file_count: files.length,
    })}`,
  );
  const cleanupResults = await cleanupGeminiUploadedFiles({
    config: llmConfig,
    files,
  });
  await appendProcessingTrace(
    input.admin,
    input.taskId,
    `[Gemini File API][TemplatePdfEvidenceCleanupComplete] ${JSON.stringify({
      cleanup_results: cleanupResults.map((result) =>
        result.status === 'fulfilled'
          ? result.value
          : {
              deleted: false,
              reason: 'cleanup_rejected',
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            },
      ),
    })}`,
  );
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await context.params;
  let ownerId: string | null = null;
  let actorEmail: string | null = null;
  let admin: ReturnType<typeof createSupabaseAdminClient> | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return createUnauthorizedResponse();
    }

    ownerId = user.id;
    actorEmail = user.email ?? null;
    admin = createSupabaseAdminClient();
    const routeAdmin = admin;

    const { data: task, error } = await supabase
      .from('template_extraction_tasks')
      .select(
        'id, owner_id, source_docx_name, source_docx_base64, source_pdf_name, source_pdf_vision_pages, prompt, status, total_paragraphs, completed_paragraphs, processing_trace',
      )
      .eq('id', taskId)
      .eq('owner_id', ownerId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!task) {
      return NextResponse.json(
        {
          code: 'TEMPLATE_EXTRACTION_TASK_NOT_FOUND',
          message: '未找到该槽位抽取任务。',
        },
        { status: 404 },
      );
    }

    if (task.status === 'completed') {
      return NextResponse.json({
        data: {
          id: task.id,
          status: task.status,
        },
      });
    }

    if (task.status === 'running') {
      return NextResponse.json({
        data: {
          id: task.id,
          status: task.status,
        },
      });
    }

    await routeAdmin
      .from('template_extraction_tasks')
      .update({
        status: 'running',
        completed_paragraphs: 0,
        processing_trace: '',
        error_message: null,
        started_at: new Date().toISOString(),
        finished_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);

    await appendProcessingTrace(
      routeAdmin,
      task.id,
      `槽位抽取路由：/api/template-extraction-tasks/${task.id}/process`,
    );

    await appendMemoryTrace(routeAdmin, task.id, 'route_started', {
      source_docx_name: task.source_docx_name,
      source_pdf_name: task.source_pdf_name ?? null,
    });

    await logEvent({
      ownerId,
      actorEmail,
      level: 'info',
      eventType: 'template_extraction_task_started',
      message: `Started template extraction task for ${task.source_docx_name}.`,
      route: '/api/template-extraction-tasks/[taskId]/process',
      payload: {
        taskId: task.id,
        totalParagraphs: task.total_paragraphs,
      },
    });

    const buffer = Buffer.from(task.source_docx_base64, 'base64');
    let lastPersistedCompletedParagraphs = 0;
    let lastLoggedCompletedParagraphs = 0;

    const textExtractionStartedAt = Date.now();
    await appendMemoryTrace(routeAdmin, task.id, 'text_slot_extraction_start', {
      total_paragraphs: task.total_paragraphs,
    });
    const result = await extractTemplateSlotsFromDocx({
      buffer,
      fileName: task.source_docx_name,
      prompt: task.prompt ?? '',
      onTrace: async (entry) => {
        await appendProcessingTrace(routeAdmin, task.id, entry.message);
      },
      onParagraphComplete: async ({ completedParagraphs, totalParagraphs }) => {
        if (completedParagraphs === lastPersistedCompletedParagraphs) {
          return;
        }

        lastPersistedCompletedParagraphs = completedParagraphs;

        await routeAdmin
          .from('template_extraction_tasks')
          .update({
            total_paragraphs: totalParagraphs,
            completed_paragraphs: completedParagraphs,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);

        const shouldLogProgress =
          completedParagraphs === totalParagraphs ||
          completedParagraphs - lastLoggedCompletedParagraphs >= 5;

        if (shouldLogProgress) {
          lastLoggedCompletedParagraphs = completedParagraphs;

          await logEvent({
            ownerId,
            actorEmail,
            level: 'info',
            eventType: 'template_extraction_task_progress',
            message: `Template extraction task progressed to ${completedParagraphs}/${totalParagraphs} paragraphs.`,
            route: '/api/template-extraction-tasks/[taskId]/process',
            payload: {
              taskId: task.id,
              completedParagraphs,
              totalParagraphs,
              remainingParagraphs: Math.max(
                0,
                totalParagraphs - completedParagraphs,
              ),
            },
          });
        }
      },
    });
    const textExtractionFinishedAt = Date.now();
    await appendMemoryTrace(routeAdmin, task.id, 'text_slot_extraction_done', {
      total_paragraphs: result.totalParagraphs,
      extracted_paragraphs: result.extraction_result.length,
    });
    await appendProcessingTrace(
      routeAdmin,
      task.id,
      `[Template Extract][Timing] ${JSON.stringify({
        stage: 'text_slot_extraction',
        document_name: task.source_docx_name,
        started_at: new Date(textExtractionStartedAt).toISOString(),
        finished_at: new Date(textExtractionFinishedAt).toISOString(),
        duration_ms: textExtractionFinishedAt - textExtractionStartedAt,
        duration_text: formatDurationMs(
          textExtractionFinishedAt - textExtractionStartedAt,
        ),
        total_paragraphs: result.totalParagraphs,
        succeeded_paragraphs: result.succeededParagraphs,
        failed_paragraphs: result.failedParagraphs,
        extracted_paragraphs: result.extraction_result.length,
      })}`,
    );

    await appendMemoryTrace(routeAdmin, task.id, 'pdf_page_url_prepare_start', {
      pdf_file_name: task.source_pdf_name ?? null,
    });
    const pdfVisionPages = await resolvePdfVisionPages({
      admin: routeAdmin,
      sourcePdfVisionPages: task.source_pdf_vision_pages,
      taskId: task.id,
      pdfFileName: task.source_pdf_name,
      onTrace: async (entry) => {
        await appendProcessingTrace(routeAdmin, task.id, entry.message);
      },
    });
    await appendMemoryTrace(routeAdmin, task.id, 'pdf_page_url_prepare_done', {
      pdf_page_image_count: pdfVisionPages.length,
    });
    const pdfMappingStartedAt = Date.now();
    await appendMemoryTrace(routeAdmin, task.id, 'slot_pdf_page_mapping_start', {
      pdf_page_image_count: pdfVisionPages.length,
    });
    let pdfEvidence = null as Awaited<
      ReturnType<typeof buildTemplatePdfEvidence>
    > | null;

    try {
      pdfEvidence =
        task.source_pdf_name && pdfVisionPages.length > 0
          ? await buildTemplatePdfEvidence({
              pdfFileName: task.source_pdf_name,
              extractionResult: result.extraction_result,
              visionPages: pdfVisionPages,
              onTrace: async (entry) => {
                await appendProcessingTrace(routeAdmin, task.id, entry.message);
              },
            })
          : null;
    } finally {
      await cleanupTemplatePdfEvidenceGeminiFiles({
        admin: routeAdmin,
        taskId: task.id,
        visionPages: pdfVisionPages,
      });
    }
    const pdfMappingFinishedAt = Date.now();
    await appendMemoryTrace(routeAdmin, task.id, 'slot_pdf_page_mapping_done', {
      pdf_page_image_count: pdfVisionPages.length,
      matched_slot_count: pdfEvidence?.matches.length ?? 0,
    });
    await appendProcessingTrace(
      routeAdmin,
      task.id,
      `[Template Extract][Timing] ${JSON.stringify({
        stage: 'slot_pdf_page_mapping',
        document_name: task.source_docx_name,
        pdf_file_name: task.source_pdf_name ?? null,
        started_at: new Date(pdfMappingStartedAt).toISOString(),
        finished_at: new Date(pdfMappingFinishedAt).toISOString(),
        duration_ms: pdfMappingFinishedAt - pdfMappingStartedAt,
        duration_text: formatDurationMs(
          pdfMappingFinishedAt - pdfMappingStartedAt,
        ),
        pdf_page_image_count: pdfVisionPages.length,
        slot_count: result.extraction_result.reduce(
          (sum, paragraph) => sum + paragraph.items.length,
          0,
        ),
        matched_slot_count: pdfEvidence?.matches.length ?? 0,
      })}`,
    );

    const partialCompletionMessage =
      result.failedParagraphs > 0
        ? `部分段落槽位抽取未返回：已成功抽取 ${result.succeededParagraphs}/${result.totalParagraphs} 段，其余内容请在槽位核查页手动补充。`
        : null;

    if (partialCompletionMessage) {
      await appendProcessingTrace(
        routeAdmin,
        task.id,
        partialCompletionMessage,
      );
    }

    await appendMemoryTrace(routeAdmin, task.id, 'task_persist_start', {
      status: 'completed',
    });
    await routeAdmin
      .from('template_extraction_tasks')
      .update({
        status: 'completed',
        total_paragraphs: result.totalParagraphs,
        completed_paragraphs: result.totalParagraphs,
        upload_text: result.uploadText,
        upload_html: result.uploadHtml,
        result: {
          document_info: result.document_info,
          extraction_result: result.extraction_result,
        },
        pdf_evidence: pdfEvidence,
        error_message: partialCompletionMessage,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);
    await appendMemoryTrace(routeAdmin, task.id, 'task_persisted', {
      status: 'completed',
    });

    await logEvent({
      ownerId,
      actorEmail,
      level: 'info',
      eventType: 'template_extraction_task_completed',
      message: `Completed template extraction task for ${task.source_docx_name}.`,
      route: '/api/template-extraction-tasks/[taskId]/process',
      payload: {
        taskId: task.id,
        totalParagraphs: result.totalParagraphs,
        extractedParagraphs: result.extraction_result.length,
        succeededParagraphs: result.succeededParagraphs,
        failedParagraphs: result.failedParagraphs,
        pdfEvidenceMatchCount: pdfEvidence?.matches.length ?? 0,
        pdfEvidencePageCount: pdfEvidence?.pdf_pages.length ?? 0,
        uploadTextLength: result.uploadText.length,
      },
    });

    return NextResponse.json({
      data: {
        id: task.id,
        status: 'completed',
      },
    });
  } catch (error) {
    if (admin) {
      try {
        await appendProcessingTrace(
          admin,
          taskId,
          `槽位抽取失败：${error instanceof Error ? error.message : String(error)}`,
        );
        await appendMemoryTrace(admin, taskId, 'route_failed', {
          error_message: error instanceof Error ? error.message : String(error),
        });
        await appendProcessingTrace(
          admin,
          taskId,
          `[RouteErrorDetails][TemplateExtraction] ${JSON.stringify(
            buildErrorLogPayload(error, {
              taskId,
            }),
          )}`,
        );
      } catch (traceError) {
        await logErrorEvent({
          ownerId,
          actorEmail,
          eventType: 'template_extraction_task_trace_write_failed',
          error: traceError,
          route: '/api/template-extraction-tasks/[taskId]/process',
          payload: {
            taskId,
            originalError: buildErrorLogPayload(error),
          },
        });
      }

      try {
        await admin
          .from('template_extraction_tasks')
          .update({
            status: 'failed',
            error_message:
              error instanceof Error
                ? error.message
                : '槽位抽取失败，请稍后重试。',
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', taskId);
      } catch (updateError) {
        await logErrorEvent({
          ownerId,
          actorEmail,
          eventType: 'template_extraction_task_failed_status_update_failed',
          error: updateError,
          route: '/api/template-extraction-tasks/[taskId]/process',
          payload: {
            taskId,
            originalError: buildErrorLogPayload(error),
          },
        });
      }
    }

    await logErrorEvent({
      ownerId,
      actorEmail,
      eventType: 'template_extraction_task_failed',
      error,
      route: '/api/template-extraction-tasks/[taskId]/process',
      payload: {
        taskId,
      },
    });

    return NextResponse.json(
      {
        code: 'TEMPLATE_EXTRACTION_TASK_PROCESS_FAILED',
        message:
          error instanceof Error ? error.message : '槽位抽取失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}
