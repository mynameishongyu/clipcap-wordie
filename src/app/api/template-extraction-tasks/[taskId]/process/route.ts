import { NextResponse } from 'next/server';
import { buildErrorLogPayload, logEvent } from '@/src/lib/logging/log-event';
import type { PdfVisionPageInput } from '@/src/lib/llm/fill-template-from-pdf';
import { extractTemplateSlotsFromDocx } from '@/src/lib/llm/extract-template-slots';
import { buildTemplatePdfEvidence } from '@/src/lib/llm/template-pdf-evidence';
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

export async function POST(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await context.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  const admin = createSupabaseAdminClient();

  try {
    const { data: task, error } = await supabase
      .from('template_extraction_tasks')
      .select(
        'id, owner_id, source_docx_name, source_docx_base64, source_pdf_name, source_pdf_vision_pages, prompt, status, total_paragraphs, completed_paragraphs, processing_trace',
      )
      .eq('id', taskId)
      .eq('owner_id', user.id)
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

    await admin
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
      admin,
      task.id,
      `槽位抽取路由：/api/template-extraction-tasks/${task.id}/process`,
    );

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
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

    const result = await extractTemplateSlotsFromDocx({
      buffer,
      fileName: task.source_docx_name,
      prompt: task.prompt ?? '',
      onTrace: async (entry) => {
        await appendProcessingTrace(admin, task.id, entry.message);
      },
      onParagraphComplete: async ({ completedParagraphs, totalParagraphs }) => {
        if (completedParagraphs === lastPersistedCompletedParagraphs) {
          return;
        }

        lastPersistedCompletedParagraphs = completedParagraphs;

        await admin
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
            ownerId: user.id,
            actorEmail: user.email ?? null,
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

    const pdfVisionPages = normalizePdfVisionPages(
      task.source_pdf_vision_pages,
    );
    const pdfEvidence =
      task.source_pdf_name && pdfVisionPages.length > 0
        ? await buildTemplatePdfEvidence({
            pdfFileName: task.source_pdf_name,
            extractionResult: result.extraction_result,
            visionPages: pdfVisionPages,
            onTrace: async (entry) => {
              await appendProcessingTrace(admin, task.id, entry.message);
            },
          })
        : null;

    const partialCompletionMessage =
      result.failedParagraphs > 0
        ? `部分段落槽位抽取未返回：已成功抽取 ${result.succeededParagraphs}/${result.totalParagraphs} 段，其余内容请在槽位核查页手动补充。`
        : null;

    if (partialCompletionMessage) {
      await appendProcessingTrace(admin, task.id, partialCompletionMessage);
    }

    await admin
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

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
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
        pdfEvidenceOcrPageCount: pdfEvidence?.ocr_pages.length ?? 0,
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
    await appendProcessingTrace(
      admin,
      taskId,
      `槽位抽取失败：${error instanceof Error ? error.message : String(error)}`,
    );
    await appendProcessingTrace(
      admin,
      taskId,
      `[RouteErrorDetails][TemplateExtraction] ${JSON.stringify(
        buildErrorLogPayload(error, {
          taskId,
        }),
      )}`,
    );
    await admin
      .from('template_extraction_tasks')
      .update({
        status: 'failed',
        error_message:
          error instanceof Error ? error.message : '槽位抽取失败，请稍后重试。',
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', taskId);

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'template_extraction_task_failed',
      message:
        error instanceof Error
          ? error.message
          : 'Failed to process template extraction task.',
      route: '/api/template-extraction-tasks/[taskId]/process',
      payload: buildErrorLogPayload(error, {
        taskId,
      }),
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
