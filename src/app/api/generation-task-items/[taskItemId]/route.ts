import { NextResponse } from 'next/server';
import { logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';
import { getSupabaseSignedUrlExpiresInSeconds } from '@/src/lib/supabase/signed-url';

type GenerationPdfPreviewPage = {
  pageNumber: number;
  originalPageNumber: number;
  imageUrl: string;
  storagePath: string;
  rotationApplied?: number | null;
  crop?: {
    left: number;
    top: number;
    width: number;
    height: number;
    originalWidth: number;
    originalHeight: number;
    contentRatio: number;
  } | null;
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

function normalizePdfPreviewPagesInput(value: unknown) {
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
        rotation_applied?: number;
        crop?: GenerationPdfPreviewPage['crop'];
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

async function createGenerationPdfPreviewPages(input: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  llmInput: unknown;
}): Promise<GenerationPdfPreviewPage[]> {
  if (!input.llmInput || typeof input.llmInput !== 'object') {
    return [];
  }

  const assets = normalizePdfPreviewPagesInput(
    (input.llmInput as { ocr_image_assets?: unknown }).ocr_image_assets,
  );

  if (assets.length === 0) {
    return [];
  }

  const signedPages = await Promise.all(
    assets.map(async (asset): Promise<GenerationPdfPreviewPage | null> => {
      const { data, error } = await input.admin.storage
        .from('generation-pdfs')
        .createSignedUrl(
          asset.storage_path,
          getSupabaseSignedUrlExpiresInSeconds(),
        );

      if (error || !data?.signedUrl) {
        return null;
      }

      const page: GenerationPdfPreviewPage = {
        pageNumber: asset.uploaded_page_number,
        originalPageNumber: asset.original_page_number,
        imageUrl: data.signedUrl,
        storagePath: asset.storage_path,
        rotationApplied:
          typeof asset.rotation_applied === 'number'
            ? asset.rotation_applied
            : null,
      };

      if (asset.crop) {
        page.crop = asset.crop;
      }

      return page;
    }),
  );

  return signedPages.filter(
    (page): page is GenerationPdfPreviewPage => Boolean(page),
  );
}

export async function GET(
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

  try {
    const { taskItemId } = await context.params;
    const { data: item, error: itemError } = await supabase
      .from('generation_task_items')
      .select(
        'id, task_id, source_pdf_name, source_pdf_path, status, elapsed_seconds, slot_total_count, slot_completed_count, processing_trace, created_at, reviewed_at, output_docx_path, error_message, llm_input, llm_output, review_payload, started_at, finished_at',
      )
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

    const { data: task, error: taskError } = await supabase
      .from('generation_tasks')
      .select(
        'id, owner_id, template_id, template_name_snapshot, status, total_items, succeeded_items, failed_items, created_at',
      )
      .eq('id', item.task_id)
      .single();

    if (taskError || !task) {
      return NextResponse.json(
        {
          code: 'GENERATION_TASK_NOT_FOUND',
          message: '未找到该任务项所属的批量任务。',
        },
        { status: 404 },
      );
    }

    const admin = createSupabaseAdminClient();
    const { data: signedUrlData } =
      item.source_pdf_path.includes('/staged-pdf-pages/') ||
      item.source_pdf_path.includes('/fill-pdf-pages/')
        ? { data: null }
        : await admin.storage
            .from('generation-pdfs')
            .createSignedUrl(
              item.source_pdf_path,
              getSupabaseSignedUrlExpiresInSeconds(),
            );

    const pdfPreviewPages = await createGenerationPdfPreviewPages({
      admin,
      llmInput: item.llm_input,
    });

    let templatePreviewHtml: string | null = null;
    let templatePreviewDocument: unknown = null;
    let templatePreviewSlots: unknown = null;
    let templatePreviewUploadText: string | null = null;

    if (task.template_id) {
      const { data: template } = await supabase
        .from('templates')
        .select('upload_html, slot_review_payload')
        .eq('id', task.template_id)
        .eq('owner_id', user.id)
        .maybeSingle<{
          upload_html?: string | null;
          slot_review_payload?: {
            parsedDocument?: unknown;
            extractionResult?: unknown;
            uploadText?: string | null;
          } | null;
        }>();

      templatePreviewHtml = template?.upload_html ?? null;
      templatePreviewDocument = template?.slot_review_payload?.parsedDocument ?? null;
      templatePreviewSlots = template?.slot_review_payload?.extractionResult ?? null;
      templatePreviewUploadText = template?.slot_review_payload?.uploadText ?? null;
    }

    return NextResponse.json({
      data: {
        item: {
          ...item,
          pdf_preview_url: signedUrlData?.signedUrl ?? null,
          pdf_preview_pages: pdfPreviewPages,
          template_preview_html: templatePreviewHtml,
          template_preview_document: templatePreviewDocument,
          template_preview_slots: templatePreviewSlots,
          template_preview_upload_text: templatePreviewUploadText,
        },
        task,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_FETCH_FAILED',
        message: error instanceof Error ? error.message : '读取任务项详情失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}

export async function DELETE(
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

  try {
    const { taskItemId } = await context.params;
    const admin = createSupabaseAdminClient();

    const { data: item, error: itemError } = await admin
      .from('generation_task_items')
      .select('id, owner_id, task_id, template_id, source_pdf_path, output_docx_path, llm_input')
      .eq('id', taskItemId)
      .single();

    if (itemError || !item) {
      return NextResponse.json({
        data: {
          id: taskItemId,
          task_id: null,
          already_deleted: true,
        },
      });
    }

    if (item.owner_id !== user.id) {
      return createUnauthorizedResponse();
    }

    const storagePaths = Array.from(
      new Set(
        [
          item.source_pdf_path?.includes('/staged-pdf-pages/') ||
          item.source_pdf_path?.includes('/fill-pdf-pages/')
            ? null
            : item.source_pdf_path,
          item.output_docx_path,
          ...normalizePdfPreviewPagesInput(
            (item as { llm_input?: { ocr_image_assets?: unknown } | null })
              .llm_input?.ocr_image_assets,
          ).map((asset) => asset.storage_path),
        ].filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        ),
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

    const { error: deleteItemError } = await admin
      .from('generation_task_items')
      .delete()
      .eq('id', taskItemId);

    if (deleteItemError) {
      throw deleteItemError;
    }

    const { count, error: countError } = await admin
      .from('generation_task_items')
      .select('id', { count: 'exact', head: true })
      .eq('task_id', item.task_id);

    if (countError) {
      throw countError;
    }

    if ((count ?? 0) === 0) {
      const { error: deleteTaskError } = await admin
        .from('generation_tasks')
        .delete()
        .eq('id', item.task_id);

      if (deleteTaskError) {
        throw deleteTaskError;
      }
    }

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'info',
      eventType: 'generation_task_item_deleted',
      message: 'Generation task item deleted.',
      route: '/api/generation-task-items/[taskItemId]',
      templateId: item.template_id ?? null,
      taskId: (count ?? 0) === 0 ? null : item.task_id,
      taskItemId: null,
      payload: {
        deletedWholeTask: (count ?? 0) === 0,
        deletedTaskId: item.task_id,
        deletedTaskItemId: taskItemId,
        storagePathCount: storagePaths.length,
      },
    });

    return NextResponse.json({
      data: {
        id: taskItemId,
        task_id: item.task_id,
        already_deleted: false,
      },
    });
  } catch (error) {
    const { taskItemId } = await context.params;

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'generation_task_item_delete_failed',
      message: error instanceof Error ? error.message : 'Failed to delete generation task item.',
      route: '/api/generation-task-items/[taskItemId]',
      taskItemId,
    });

    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_DELETE_FAILED',
        message: error instanceof Error ? error.message : '删除任务项失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}
