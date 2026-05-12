import { after, NextResponse } from 'next/server';
import {
  appendProcessingTrace,
  buildFallbackReviewPayload,
  createUnauthorizedResponse,
  generationTaskItemSelect,
  type GenerationTaskItemRecord,
  getErrorMessage,
  normalizeOcrImageAssets,
  normalizeSelectedOriginalPageNumbers,
  normalizeVisionPages,
  recalculateTaskSummary,
} from '@/src/lib/generation-task-items/runtime';
import { buildErrorLogPayload, logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

async function runGenerationTaskItemPagePreparation(params: {
  item: GenerationTaskItemRecord;
  actorEmail: string | null;
}) {
  const admin = createSupabaseAdminClient();
  const startedAt = new Date();
  const slotSchema = Array.isArray(params.item.llm_input?.slot_schema)
    ? params.item.llm_input.slot_schema
    : [];
  const precomputedVisionPages = normalizeVisionPages(params.item.llm_input?.vision_pages);
  const ocrImageAssets = normalizeOcrImageAssets(params.item.llm_input?.ocr_image_assets);
  const selectedOriginalPageNumbers = normalizeSelectedOriginalPageNumbers(
    params.item.llm_input?.selected_original_page_numbers,
  );

  try {
    if (slotSchema.length === 0) {
      throw new Error('当前模板缺少槽位定义，请重新保存模板后再试。');
    }

    if (
      precomputedVisionPages.length === 0 &&
      ocrImageAssets.length === 0 &&
      selectedOriginalPageNumbers.length === 0
    ) {
      throw new Error('当前任务缺少可用于视觉回填的新 PDF 页面图片，请重新创建批量任务。');
    }

    await admin
      .from('generation_task_items')
      .update({
        status: 'ocr_running',
        error_message: null,
        started_at: params.item.started_at ?? startedAt.toISOString(),
        finished_at: null,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
        processing_trace: '',
      })
      .eq('id', params.item.id);

    await admin
      .from('generation_tasks')
      .update({
        status: 'running',
        started_at: params.item.started_at ?? startedAt.toISOString(),
      })
      .eq('id', params.item.task_id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `开始准备新 PDF 页面图片：${params.item.source_pdf_name}，共 ${slotSchema.length} 个槽位。`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `页面准备路由：/api/generation-task-items/${params.item.id}/ocr`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      '当前流程已跳过新 PDF OCR；页面图片准备完成后将直接调用 VISION_LLM 进行视觉槽位回填。',
    );

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'info',
      eventType: 'generation_task_item_pdf_pages_ready_started',
      message: `Started PDF page preparation for ${params.item.source_pdf_name}.`,
      route: '/api/generation-task-items/[taskItemId]/ocr',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: {
        slotCount: slotSchema.length,
        visionPageCount: precomputedVisionPages.length,
        ocrImageAssetCount: ocrImageAssets.length,
        selectedPageCount: selectedOriginalPageNumbers.length,
      },
    });

    const elapsedSeconds = Math.max(
      1,
      Math.round(
        (Date.now() -
          new Date(params.item.started_at ?? startedAt.toISOString()).getTime()) /
          1000,
      ),
    );

    const { data: updatedItem, error: updatedItemError } = await admin
      .from('generation_task_items')
      .update({
        status: 'pdf_pages_ready',
        elapsed_seconds: elapsedSeconds,
        llm_input: {
          ...(params.item.llm_input ?? {}),
          pages: [],
          total_text_length: 0,
        },
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
      })
      .eq('id', params.item.id)
      .select('id, status')
      .single();

    if (updatedItemError) {
      throw updatedItemError;
    }

    if (!updatedItem || updatedItem.status !== 'pdf_pages_ready') {
      throw new Error('PDF page ready status was not persisted correctly before slot-fill handoff.');
    }

    await recalculateTaskSummary(admin, params.item.task_id);
    await appendProcessingTrace(
      admin,
      params.item.id,
      `新 PDF 页面图片准备完成：共 ${precomputedVisionPages.length || ocrImageAssets.length} 页，等待视觉槽位回填。`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      'PDF 页面图片已准备完成，前端轮询检测到后将自动启动槽位回填。',
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `下一步路由：/api/generation-task-items/${params.item.id}/slot-fill`,
    );

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'info',
      eventType: 'generation_task_item_pdf_pages_ready_completed',
      message: `PDF pages prepared for ${params.item.source_pdf_name}.`,
      route: '/api/generation-task-items/[taskItemId]/ocr',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: {
        visionPageCount: precomputedVisionPages.length,
        ocrImageAssetCount: ocrImageAssets.length,
        elapsedSeconds,
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
      `新 PDF 页面图片准备失败，已转为人工核查：${getErrorMessage(error)}`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[RouteErrorDetails][PagePreparation] ${JSON.stringify(
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
      eventType: 'generation_task_item_pdf_pages_ready_failed',
      message: getErrorMessage(error),
      route: '/api/generation-task-items/[taskItemId]/ocr',
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

    if (
      [
        'review_pending',
        'reviewed',
        'succeeded',
        'pdf_pages_ready',
        'slot_filling',
      ].includes(item.status)
    ) {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    if (['running', 'ocr_running'].includes(item.status)) {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    after(async () => {
      await runGenerationTaskItemPagePreparation({
        item,
        actorEmail: user.email ?? null,
      });
    });

    return NextResponse.json(
      {
        data: {
          item: {
            ...item,
            status: 'ocr_running',
            slot_total_count:
              Array.isArray(item.llm_input?.slot_schema) ? item.llm_input.slot_schema.length : 0,
            slot_completed_count: 0,
            processing_trace: '',
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
      eventType: 'generation_task_item_pdf_pages_ready_request_failed',
      message,
      route: '/api/generation-task-items/[taskItemId]/ocr',
      taskItemId,
      payload: buildErrorLogPayload(error),
    });

    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_PDF_PAGES_READY_FAILED',
        message,
      },
      { status: 500 },
    );
  }
}
