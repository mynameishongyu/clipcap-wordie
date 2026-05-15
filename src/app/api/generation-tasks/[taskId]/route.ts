import { NextResponse } from 'next/server';
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
  reviewed_at?: string | null;
  output_docx_path?: string | null;
  error_message?: string | null;
  llm_input?: {
    ocr_image_assets?: unknown;
  } | null;
};

function normalizePageFilterAssets(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (
        entry,
      ): entry is {
        uploaded_page_number: number;
        original_page_number: number;
        storage_path: string;
        filter_decision?: string | null;
        filter_reason?: string | null;
        filter_confidence?: number | null;
        used_for_slot_fill?: boolean;
      } =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as { uploaded_page_number?: unknown }).uploaded_page_number === 'number' &&
        Number.isInteger((entry as { uploaded_page_number: number }).uploaded_page_number) &&
        (entry as { uploaded_page_number: number }).uploaded_page_number > 0 &&
        typeof (entry as { original_page_number?: unknown }).original_page_number === 'number' &&
        Number.isInteger((entry as { original_page_number: number }).original_page_number) &&
        (entry as { original_page_number: number }).original_page_number > 0 &&
        typeof (entry as { storage_path?: unknown }).storage_path === 'string' &&
        (entry as { storage_path: string }).storage_path.trim().length > 0,
    )
    .sort((left, right) => left.uploaded_page_number - right.uploaded_page_number);
}

async function buildPageFilterPages(input: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  item: GenerationTaskItemListRecord;
}) {
  const assets = normalizePageFilterAssets(input.item.llm_input?.ocr_image_assets);

  if (assets.length === 0) {
    return [];
  }

  const signedPages = await Promise.all(
    assets.map(async (asset) => {
      const { data } = await input.admin.storage
        .from('generation-pdfs')
        .createSignedUrl(asset.storage_path, 60 * 60);

      return {
        uploadedPageNumber: asset.uploaded_page_number,
        originalPageNumber: asset.original_page_number,
        storagePath: asset.storage_path,
        imageUrl: data?.signedUrl ?? null,
        filterDecision: asset.filter_decision ?? null,
        filterReason: asset.filter_reason ?? null,
        filterConfidence:
          typeof asset.filter_confidence === 'number'
            ? asset.filter_confidence
            : null,
        selectedForSlotFill: asset.used_for_slot_fill !== false,
      };
    }),
  );

  return signedPages;
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

    const { data: items, error: itemsError } = await supabase
      .from('generation_task_items')
      .select(
        'id, task_id, source_pdf_name, source_pdf_path, status, elapsed_seconds, slot_total_count, slot_completed_count, processing_trace, created_at, reviewed_at, output_docx_path, error_message, llm_input',
      )
      .eq('task_id', taskId)
      .order('created_at', { ascending: true })
      .returns<GenerationTaskItemListRecord[]>();

    if (itemsError) {
      throw itemsError;
    }

    const admin = createSupabaseAdminClient();
    const itemsWithPageFilters = await Promise.all(
      (items ?? []).map(async (item) => ({
        ...item,
        pdf_page_filter_pages: await buildPageFilterPages({ admin, item }),
        llm_input: undefined,
      })),
    );

    return NextResponse.json({
      data: {
        task,
        items: itemsWithPageFilters,
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
      .eq('task_id', taskId);

    if (itemsError) {
      throw itemsError;
    }

    const storagePaths = Array.from(
      new Set(
        (items ?? [])
          .flatMap((item) => [
            item.source_pdf_path?.includes('/staged-pdf-pages/')
              ? null
              : item.source_pdf_path,
            item.output_docx_path,
            ...normalizePageFilterAssets(
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

    const { error: deleteTaskError } = await admin
      .from('generation_tasks')
      .delete()
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
