import { NextResponse } from 'next/server';
import {
  markTimedOutGenerationTaskItems,
  normalizePdfPageImageAssets,
} from '@/src/lib/generation-task-items/runtime';
import { logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

type GenerationTaskItemListRecord = {
  id: string;
  task_id: string;
  source_pdf_name: string;
  source_pdf_path: string;
  status: string;
  elapsed_seconds: number;
  slot_total_count: number;
  slot_completed_count: number;
  processing_trace: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  updated_at?: string | null;
  reviewed_at?: string | null;
  output_docx_path?: string | null;
  error_message?: string | null;
};

function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: '请先登录后再继续。',
    },
    { status: 401 },
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  try {
    const { taskId } = await context.params;
    const { data: task, error: taskError } = await supabase
      .from('generation_tasks')
      .select(
        'id, owner_id, template_id, template_name_snapshot, status, total_items, succeeded_items, failed_items, created_at',
      )
      .eq('id', taskId)
      .is('deleted_at', null)
      .single();

    if (taskError || !task) {
      return NextResponse.json(
        {
          code: 'GENERATION_TASK_NOT_FOUND',
          message: '未找到该批量生成任务。',
        },
        { status: 404 },
      );
    }

    const itemSelect =
      'id, task_id, source_pdf_name, source_pdf_path, status, elapsed_seconds, slot_total_count, slot_completed_count, processing_trace, created_at, started_at, finished_at, updated_at, reviewed_at, output_docx_path, error_message';

    let { data: items, error: itemsError } = await supabase
      .from('generation_task_items')
      .select(itemSelect)
      .eq('task_id', taskId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .returns<GenerationTaskItemListRecord[]>();

    if (itemsError) {
      throw itemsError;
    }

    const admin = createSupabaseAdminClient();
    let nextTask = task;
    let nextItems = items ?? [];
    const timeoutResult = await markTimedOutGenerationTaskItems({
      admin,
      taskId,
      items: nextItems,
    });

    if (timeoutResult.updated) {
      const { data: refreshedTask, error: refreshedTaskError } = await admin
        .from('generation_tasks')
        .select(
          'id, owner_id, template_id, template_name_snapshot, status, total_items, succeeded_items, failed_items, created_at',
        )
        .eq('id', taskId)
        .is('deleted_at', null)
        .single();

      if (refreshedTaskError || !refreshedTask) {
        throw refreshedTaskError ?? new Error('Failed to refresh generation task.');
      }

      const { data: refreshedItems, error: refreshedItemsError } = await admin
        .from('generation_task_items')
        .select(itemSelect)
        .eq('task_id', taskId)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .returns<GenerationTaskItemListRecord[]>();

      if (refreshedItemsError) {
        throw refreshedItemsError;
      }

      nextTask = refreshedTask;
      nextItems = refreshedItems ?? [];
    }

    return NextResponse.json({
      data: {
        task: nextTask,
        items: nextItems,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_FETCH_FAILED',
        message:
          error instanceof Error ? error.message : '读取批量生成任务失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  try {
    const { taskId } = await context.params;
    const admin = createSupabaseAdminClient();

    const { data: task, error: taskError } = await admin
      .from('generation_tasks')
      .select('id, owner_id, template_id')
      .eq('id', taskId)
      .is('deleted_at', null)
      .single();

    if (taskError || !task) {
      return NextResponse.json(
        {
          code: 'GENERATION_TASK_NOT_FOUND',
          message: '未找到该批量生成任务。',
        },
        { status: 404 },
      );
    }

    if (task.owner_id !== user.id) {
      return createUnauthorizedResponse();
    }

    const { data: items, error: itemsError } = await admin
      .from('generation_task_items')
      .select('id, source_pdf_path, output_docx_path, llm_input')
      .eq('task_id', taskId)
      .is('deleted_at', null);

    if (itemsError) {
      throw itemsError;
    }

    const storagePaths = Array.from(
      new Set(
        (items ?? [])
          .flatMap((item) => [
            item.source_pdf_path?.includes('/staged-pdf-pages/') ||
            item.source_pdf_path?.includes('/fill-pdf-pages/')
              ? null
              : item.source_pdf_path,
            item.output_docx_path,
            ...normalizePdfPageImageAssets(
              (item as { llm_input?: { ocr_image_assets?: unknown } | null })
                .llm_input?.ocr_image_assets,
            ).map((asset) => asset.storage_path),
          ])
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
      ),
    );

    if (storagePaths.length > 0) {
      const { error: removeStorageError } = await admin.storage
        .from('generation-pdfs')
        .remove(storagePaths);

      if (removeStorageError) {
        throw removeStorageError;
      }
    }

    const deletedAt = new Date().toISOString();
    const { error: deleteItemsError } = await admin
      .from('generation_task_items')
      .update({
        deleted_at: deletedAt,
        deleted_by: user.id,
        updated_at: deletedAt,
      })
      .eq('task_id', taskId)
      .is('deleted_at', null);

    if (deleteItemsError) {
      throw deleteItemsError;
    }

    const { error: deleteTaskError } = await admin
      .from('generation_tasks')
      .update({
        deleted_at: deletedAt,
        deleted_by: user.id,
        updated_at: deletedAt,
      })
      .eq('id', taskId);

    if (deleteTaskError) {
      throw deleteTaskError;
    }

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'info',
      eventType: 'generation_task_deleted',
      message: 'Generation task deleted.',
      route: '/api/generation-tasks/[taskId]',
      templateId: task.template_id ?? null,
      taskId: null,
      payload: {
        deletedTaskId: taskId,
        itemCount: items?.length ?? 0,
        storagePathCount: storagePaths.length,
      },
    });

    return NextResponse.json({
      data: {
        id: taskId,
      },
    });
  } catch (error) {
    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'generation_task_delete_failed',
      message: error instanceof Error ? error.message : 'Failed to delete generation task.',
      route: '/api/generation-tasks/[taskId]',
      taskId: (await context.params).taskId,
    });

    return NextResponse.json(
      {
        code: 'GENERATION_TASK_DELETE_FAILED',
        message:
          error instanceof Error ? error.message : '删除批量生成任务失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}
