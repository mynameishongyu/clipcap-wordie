import { NextResponse } from 'next/server';
import type {
  GenerationSlotSchemaItem,
  PdfPageInput,
  PdfVisionPageInput,
} from '@/src/lib/llm/fill-template-from-pdf';
import { fillTemplateSlotsFromPdf } from '@/src/lib/llm/fill-template-from-pdf';
import { logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: '请先登录后再继续。',
    },
    { status: 401 },
  );
}

async function recalculateTaskSummary(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  taskId: string,
) {
  const { data: items, error } = await admin
    .from('generation_task_items')
    .select('status')
    .eq('task_id', taskId);

  if (error) {
    throw error;
  }

  const totalItems = items?.length ?? 0;
  const succeededItems =
    items?.filter((item) => ['succeeded', 'review_pending', 'reviewed'].includes(item.status))
      .length ?? 0;
  const failedItems = items?.filter((item) => item.status === 'failed').length ?? 0;
  const hasRunningItems =
    items?.some((item) => ['running', 'uploaded', 'pending'].includes(item.status)) ?? false;

  const nextStatus = hasRunningItems
    ? 'running'
    : failedItems > 0 && succeededItems === 0
      ? 'failed'
      : 'completed';

  await admin
    .from('generation_tasks')
    .update({
      status: nextStatus,
      total_items: totalItems,
      succeeded_items: succeededItems,
      failed_items: failedItems,
      finished_at: hasRunningItems ? null : new Date().toISOString(),
    })
    .eq('id', taskId);
}

function normalizePages(value: unknown): PdfPageInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (page): page is PdfPageInput =>
      !!page &&
      typeof page === 'object' &&
      typeof (page as PdfPageInput).page_number === 'number' &&
      typeof (page as PdfPageInput).text === 'string',
  );
}

function normalizeVisionPages(value: unknown): PdfVisionPageInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (page): page is PdfVisionPageInput =>
      !!page &&
      typeof page === 'object' &&
      typeof (page as PdfVisionPageInput).page_number === 'number' &&
      typeof (page as PdfVisionPageInput).image_data_url === 'string',
  );
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
      .select('*')
      .eq('id', taskItemId)
      .single();

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
          item: {
            id: item.id,
            task_id: item.task_id,
            source_pdf_name: item.source_pdf_name,
            source_pdf_path: item.source_pdf_path,
            status: item.status,
            elapsed_seconds: item.elapsed_seconds,
            created_at: item.created_at,
            reviewed_at: item.reviewed_at,
            output_docx_path: item.output_docx_path,
            error_message: item.error_message,
          },
        },
      });
    }

    const startedAt = new Date();
    await admin
      .from('generation_task_items')
      .update({
        status: 'running',
        started_at: startedAt.toISOString(),
        error_message: null,
      })
      .eq('id', taskItemId);

    await admin
      .from('generation_tasks')
      .update({
        status: 'running',
        started_at: startedAt.toISOString(),
      })
      .eq('id', item.task_id);

    const llmInput = (item.llm_input ?? {}) as {
      template_name?: string;
      template_prompt?: string;
      slot_schema?: GenerationSlotSchemaItem[];
      pages?: PdfPageInput[];
      vision_pages?: PdfVisionPageInput[];
      likely_scanned?: boolean;
      total_text_length?: number;
    };
    const slotSchema = Array.isArray(llmInput.slot_schema) ? llmInput.slot_schema : [];
    const pages = normalizePages(llmInput.pages);
    const visionPages = normalizeVisionPages(llmInput.vision_pages);

    if (slotSchema.length === 0) {
      throw new Error('当前模板缺少槽位定义，请重新保存模板后再试。');
    }

    if (pages.length === 0 && visionPages.length === 0) {
      throw new Error('当前任务缺少 PDF 预处理结果，请重新创建批量任务后再试。');
    }

    const llmOutput = await fillTemplateSlotsFromPdf({
      pdfFileName: item.source_pdf_name,
      templateName: llmInput.template_name ?? '未命名模板',
      templatePrompt: llmInput.template_prompt ?? '',
      slots: slotSchema,
      pages,
      visionPages,
      likelyScanned: llmInput.likely_scanned === true,
      totalTextLength:
        typeof llmInput.total_text_length === 'number' ? llmInput.total_text_length : 0,
    });

    const finishedAt = new Date();
    const elapsedSeconds = Math.max(
      1,
      Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
    );

    const { data: updatedItem, error: updateError } = await admin
      .from('generation_task_items')
      .update({
        status: 'review_pending',
        elapsed_seconds: elapsedSeconds,
        llm_output: llmOutput,
        finished_at: finishedAt.toISOString(),
      })
      .eq('id', taskItemId)
      .select(
        'id, task_id, source_pdf_name, source_pdf_path, status, elapsed_seconds, created_at, reviewed_at, output_docx_path, error_message',
      )
      .single();

    if (updateError || !updatedItem) {
      throw updateError ?? new Error('回写任务项处理结果失败。');
    }

    await recalculateTaskSummary(admin, item.task_id);

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'info',
      eventType: 'generation_task_item_processed',
      message: 'Generation task item processed successfully.',
      route: '/api/generation-task-items/[taskItemId]/process',
      templateId: item.template_id ?? null,
      taskId: item.task_id,
      taskItemId,
      payload: {
        sourcePdfName: item.source_pdf_name,
        elapsedSeconds,
        slotCount: slotSchema.length,
      },
    });

    return NextResponse.json({
      data: {
        item: updatedItem,
      },
    });
  } catch (error) {
    const { taskItemId } = await context.params;
    const finishedAt = new Date().toISOString();
    const { data: existingItem } = await admin
      .from('generation_task_items')
      .select('task_id')
      .eq('id', taskItemId)
      .single();

    await admin
      .from('generation_task_items')
      .update({
        status: 'failed',
        error_message:
          error instanceof Error ? error.message : 'PDF 填充处理失败，请稍后重试。',
        finished_at: finishedAt,
      })
      .eq('id', taskItemId);

    if (existingItem?.task_id) {
      await recalculateTaskSummary(admin, existingItem.task_id);
    }

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'generation_task_item_failed',
      message: error instanceof Error ? error.message : 'Failed to process generation task item.',
      route: '/api/generation-task-items/[taskItemId]/process',
      taskId: existingItem?.task_id ?? null,
      taskItemId,
      payload: {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
    });

    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_PROCESS_FAILED',
        message:
          error instanceof Error ? error.message : 'PDF 填充处理失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}
