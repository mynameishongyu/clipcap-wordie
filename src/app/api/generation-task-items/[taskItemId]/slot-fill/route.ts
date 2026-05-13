import { after, NextResponse } from 'next/server';
import {
  fillSlotsFromVisionPages,
  type GenerationSlotSchemaItem,
  type ReferencePdfVisionPageInput,
} from '@/src/lib/llm/fill-template-from-pdf';
import {
  appendProcessingTrace,
  buildFallbackReviewPayload,
  createUnauthorizedResponse,
  generationTaskItemSelect,
  type GenerationTaskItemRecord,
  getErrorMessage,
  loadVisionPagesFromStoredAssets,
  normalizeOcrImageAssets,
  normalizeVisionPages,
  recalculateTaskSummary,
  updateSlotProgress,
} from '@/src/lib/generation-task-items/runtime';
import { buildErrorLogPayload, logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

const PROCESS_HARD_TIMEOUT_MS = maxDuration * 1000;

function getMimeTypeFromStoragePath(storagePath: string) {
  const normalized = storagePath.toLowerCase();

  if (normalized.endsWith('.png')) {
    return 'image/png';
  }

  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
    return 'image/jpeg';
  }

  if (normalized.endsWith('.webp')) {
    return 'image/webp';
  }

  return 'application/octet-stream';
}

function hasUsableReferenceBbox(slot: GenerationSlotSchemaItem) {
  const bbox = slot.reference_pdf_evidence?.example_bbox;

  return (
    Boolean(bbox) &&
    typeof bbox?.x === 'number' &&
    typeof bbox?.y === 'number' &&
    typeof bbox?.width === 'number' &&
    typeof bbox?.height === 'number' &&
    bbox.width > 0 &&
    bbox.height > 0
  );
}

async function loadReferenceExamplePagesWithBbox(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  slots: GenerationSlotSchemaItem[];
}) {
  const pageAssetsByKey = new Map<
    string,
    {
      pageNumber: number;
      storagePath: string;
      examplePdfFileName?: string;
    }
  >();
  let skippedSlotsWithoutBbox = 0;
  let skippedSlotsWithoutPageImage = 0;

  for (const slot of params.slots) {
    const reference = slot.reference_pdf_evidence;

    if (!reference || !hasUsableReferenceBbox(slot)) {
      skippedSlotsWithoutBbox += 1;
      continue;
    }

    const pageNumber = reference.example_page_number;
    const storagePath = reference.example_page_storage_path?.trim();

    if (!pageNumber || !storagePath) {
      skippedSlotsWithoutPageImage += 1;
      continue;
    }

    pageAssetsByKey.set(`${pageNumber}:${storagePath}`, {
      pageNumber,
      storagePath,
      examplePdfFileName: reference.example_pdf_file_name,
    });
  }

  const pages = await Promise.all(
    [...pageAssetsByKey.values()]
      .sort((left, right) => left.pageNumber - right.pageNumber)
      .map(async (asset) => {
        const { data: fileBlob, error } = await params.admin.storage
          .from('generation-pdfs')
          .download(asset.storagePath);

        if (error || !fileBlob) {
          throw error ?? new Error(`无法下载示例 PDF 页图: ${asset.storagePath}`);
        }

        const buffer = Buffer.from(await fileBlob.arrayBuffer());
        const mimeType =
          fileBlob.type || getMimeTypeFromStoragePath(asset.storagePath);

        return {
          page_number: asset.pageNumber,
          original_page_number: asset.pageNumber,
          image_data_url: `data:${mimeType};base64,${buffer.toString('base64')}`,
          example_pdf_file_name: asset.examplePdfFileName,
        } satisfies ReferencePdfVisionPageInput;
      }),
  );

  return {
    pages,
    skippedSlotsWithoutBbox,
    skippedSlotsWithoutPageImage,
  };
}

async function runGenerationTaskItemSlotFill(params: {
  item: GenerationTaskItemRecord;
  actorEmail: string | null;
}) {
  const admin = createSupabaseAdminClient();
  const startedAt = new Date();
  const processStartedAtMs = startedAt.getTime();
  const slotSchema = Array.isArray(params.item.llm_input?.slot_schema)
    ? params.item.llm_input.slot_schema
    : [];
  const precomputedVisionPages = normalizeVisionPages(
    params.item.llm_input?.vision_pages,
  );
  const ocrImageAssets = normalizeOcrImageAssets(
    params.item.llm_input?.ocr_image_assets,
  );
  const pipelineStartedAt = params.item.started_at
    ? new Date(params.item.started_at)
    : startedAt;

  try {
    if (slotSchema.length === 0) {
      throw new Error('当前模板缺少槽位定义，请重新保存模板后再试。');
    }

    if (precomputedVisionPages.length === 0 && ocrImageAssets.length === 0) {
      throw new Error('当前任务缺少可用于视觉回填的新 PDF 页面图片，请重新创建批量任务。');
    }

    const visionPages =
      precomputedVisionPages.length > 0
        ? precomputedVisionPages
        : await loadVisionPagesFromStoredAssets({
            admin,
            ocrImageAssets,
          });

    if (visionPages.length === 0) {
      throw new Error('当前任务没有可读取的新 PDF 页面图片。');
    }

    const referenceExamplePages = await loadReferenceExamplePagesWithBbox({
      admin,
      slots: slotSchema,
    });

    await admin
      .from('generation_task_items')
      .update({
        status: 'slot_filling',
        error_message: null,
        started_at: pipelineStartedAt.toISOString(),
        finished_at: null,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
      })
      .eq('id', params.item.id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `槽位回填路由：/api/generation-task-items/${params.item.id}/slot-fill`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `即将开始 VISION_LLM 视觉槽位回填：PDF=${params.item.source_pdf_name}，槽位数=${slotSchema.length}，页面图片=${visionPages.length}。`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      '槽位回填阶段：跳过新 PDF OCR，直接使用槽位来源、示例 PDF 定位信息和新 PDF 页面图片调用 VISION_LLM。',
    );

    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][ReferenceExample] Using ${referenceExamplePages.pages.length} example PDF page image(s) with bbox for slot fill; skipped ${referenceExamplePages.skippedSlotsWithoutBbox} slot(s) without bbox and ${referenceExamplePages.skippedSlotsWithoutPageImage} slot(s) without stored example page image.`,
    );

    console.log('[Generation Task Item] Direct visual slot fill starting', {
      taskItemId: params.item.id,
      taskId: params.item.task_id,
      sourcePdfName: params.item.source_pdf_name,
      slotCount: slotSchema.length,
      visionPageCount: visionPages.length,
      referenceExamplePageCount: referenceExamplePages.pages.length,
    });

    let lastLoggedCompletedSlots = -1;
    const llmOutput = await fillSlotsFromVisionPages({
      pdfFileName: params.item.source_pdf_name,
      slots: slotSchema,
      visionPages,
      referenceExamplePages: referenceExamplePages.pages,
      processStartedAtMs,
      processHardTimeoutMs: PROCESS_HARD_TIMEOUT_MS,
      onTrace: async ({ message }) => {
        await appendProcessingTrace(admin, params.item.id, message);
      },
      onProgress: async ({ completedSlots, totalSlots }) => {
        await updateSlotProgress(admin, params.item.id, {
          completedSlots,
          totalSlots,
        });

        if (
          completedSlots === totalSlots ||
          completedSlots === 0 ||
          completedSlots !== lastLoggedCompletedSlots
        ) {
          lastLoggedCompletedSlots = completedSlots;
          await appendProcessingTrace(
            admin,
            params.item.id,
            `槽位回填进度：已完成 ${completedSlots}/${totalSlots}，待抽取 ${Math.max(0, totalSlots - completedSlots)}。`,
          );

          await logEvent({
            ownerId: params.item.owner_id,
            actorEmail: params.actorEmail,
            level: 'info',
            eventType: 'generation_task_item_progress',
            message: `Generation task item progressed to ${completedSlots}/${totalSlots} filled slots.`,
            route: '/api/generation-task-items/[taskItemId]/slot-fill',
            templateId: params.item.template_id,
            taskId: params.item.task_id,
            taskItemId: params.item.id,
            payload: {
              completedSlots,
              totalSlots,
              pendingSlots: Math.max(0, totalSlots - completedSlots),
            },
          });
        }
      },
    });

    const finishedAt = new Date();
    const elapsedSeconds = Math.max(
      1,
      Math.round((finishedAt.getTime() - pipelineStartedAt.getTime()) / 1000),
    );
    const completedSlots = llmOutput.extracted_items.filter((item) =>
      Boolean(item.original_value.trim()),
    ).length;

    const { error: updateError } = await admin
      .from('generation_task_items')
      .update({
        status: 'review_pending',
        elapsed_seconds: elapsedSeconds,
        llm_output: llmOutput,
        slot_total_count: slotSchema.length,
        slot_completed_count: completedSlots,
        finished_at: finishedAt.toISOString(),
      })
      .eq('id', params.item.id);

    if (updateError) {
      throw updateError;
    }

    await recalculateTaskSummary(admin, params.item.task_id);
    await appendProcessingTrace(
      admin,
      params.item.id,
      `槽位回填完成，用时 ${elapsedSeconds} 秒；已回填 ${completedSlots}/${slotSchema.length} 个槽位。`,
    );

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'info',
      eventType: 'generation_task_item_processed',
      message: 'Generation task item processed successfully.',
      route: '/api/generation-task-items/[taskItemId]/slot-fill',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: {
        sourcePdfName: params.item.source_pdf_name,
        elapsedSeconds,
        slotCount: slotSchema.length,
        completedSlots,
        pendingSlots: Math.max(0, slotSchema.length - completedSlots),
        visionPageCount: visionPages.length,
      },
    });
  } catch (error) {
    const fallbackReviewPayload = buildFallbackReviewPayload(slotSchema);

    await admin
      .from('generation_task_items')
      .update({
        status: 'review_pending',
        error_message: null,
        llm_output: fallbackReviewPayload,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
        finished_at: new Date().toISOString(),
      })
      .eq('id', params.item.id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `模型自动回填失败，已转为人工核查：${getErrorMessage(error)}`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[RouteErrorDetails][SlotFill] ${JSON.stringify(
        buildErrorLogPayload(error, {
          sourcePdfName: params.item.source_pdf_name,
          slotCount: slotSchema.length,
          visionPageCount: precomputedVisionPages.length,
          ocrImageAssetCount: ocrImageAssets.length,
        }),
      )}`,
    );

    await recalculateTaskSummary(admin, params.item.task_id);

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'error',
      eventType: 'generation_task_item_slot_fill_failed',
      message: getErrorMessage(error),
      route: '/api/generation-task-items/[taskItemId]/slot-fill',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: buildErrorLogPayload(error, {
        sourcePdfName: params.item.source_pdf_name,
        slotCount: slotSchema.length,
        visionPageCount: precomputedVisionPages.length,
        ocrImageAssetCount: ocrImageAssets.length,
      }),
    });
  }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ taskItemId: string }> },
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  const admin = createSupabaseAdminClient();

  try {
    const { taskItemId } = await context.params;
    const { data: item, error: itemError } = await admin
      .from('generation_task_items')
      .select(generationTaskItemSelect)
      .eq('id', taskItemId)
      .single<GenerationTaskItemRecord>();

    if (itemError || !item) {
      return NextResponse.json(
        {
          code: 'GENERATION_TASK_ITEM_NOT_FOUND',
          message: '未找到该任务项。',
        },
        { status: 404 },
      );
    }

    if (item.owner_id !== user.id) {
      return createUnauthorizedResponse();
    }

    if (['review_pending', 'reviewed', 'succeeded'].includes(item.status)) {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    if (item.status === 'slot_filling') {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    if (item.status !== 'pdf_pages_ready') {
      return NextResponse.json(
        {
          code: 'GENERATION_TASK_ITEM_PDF_PAGES_NOT_READY',
          message: '当前任务的新 PDF 页面图片尚未准备完成，暂时不能开始槽位回填。',
        },
        { status: 409 },
      );
    }

    after(async () => {
      await runGenerationTaskItemSlotFill({
        item,
        actorEmail: user.email ?? null,
      });
    });

    return NextResponse.json(
      {
        data: {
          item: {
            ...item,
            status: 'slot_filling',
            error_message: null,
          },
        },
      },
      { status: 202 },
    );
  } catch (error) {
    const { taskItemId } = await context.params;
    const message = getErrorMessage(error);

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'generation_task_item_slot_fill_request_failed',
      message,
      route: '/api/generation-task-items/[taskItemId]/slot-fill',
      taskItemId,
      payload: buildErrorLogPayload(error),
    });

    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_SLOT_FILL_FAILED',
        message,
      },
      { status: 500 },
    );
  }
}
