import { NextResponse } from 'next/server';
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

export async function POST(
  request: Request,
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
    const body = (await request.json()) as {
      reviewPayload?: unknown;
    };

    const { data: existingItem, error: existingItemError } = await admin
      .from('generation_task_items')
      .select('id, owner_id, task_id')
      .eq('id', taskItemId)
      .single();

    if (existingItemError || !existingItem) {
      return NextResponse.json(
        {
          code: 'GENERATION_TASK_ITEM_NOT_FOUND',
          message: '未找到该任务项。',
        },
        { status: 404 },
      );
    }

    if (existingItem.owner_id !== user.id) {
      return createUnauthorizedResponse();
    }

    const reviewedAt = new Date().toISOString();

    const { data: item, error: updateError } = await admin
      .from('generation_task_items')
      .update({
        status: 'reviewed',
        review_payload: body.reviewPayload ?? null,
        reviewed_at: reviewedAt,
      })
      .eq('id', taskItemId)
      .select(
        'id, task_id, source_pdf_name, source_pdf_path, status, elapsed_seconds, created_at, reviewed_at, output_docx_path, error_message, llm_input, llm_output, review_payload, started_at, finished_at',
      )
      .single();

    if (updateError || !item) {
      throw updateError ?? new Error('保存核查结果失败。');
    }

    const { data: task, error: taskError } = await admin
      .from('generation_tasks')
      .select(
        'id, owner_id, template_id, template_name_snapshot, status, total_items, succeeded_items, failed_items, created_at',
      )
      .eq('id', item.task_id)
      .single();

    if (taskError || !task) {
      throw taskError ?? new Error('未找到对应的批量任务。');
    }

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'info',
      eventType: 'generation_task_item_reviewed',
      message: 'Generation task item review submitted.',
      route: '/api/generation-task-items/[taskItemId]/review',
      templateId: task.template_id ?? null,
      taskId: item.task_id,
      taskItemId,
      payload: {
        sourcePdfName: item.source_pdf_name,
        reviewedAt,
      },
    });

    return NextResponse.json({
      data: {
        item,
        task,
      },
    });
  } catch (error) {
    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'generation_task_item_review_failed',
      message: error instanceof Error ? error.message : 'Failed to submit generation task item review.',
      route: '/api/generation-task-items/[taskItemId]/review',
      taskItemId: (await context.params).taskItemId,
    });

    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_REVIEW_FAILED',
        message:
          error instanceof Error ? error.message : '保存核查结果失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}
