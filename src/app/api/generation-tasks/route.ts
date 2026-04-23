import { NextResponse } from 'next/server';
import type { ExtractionParagraph } from '@/src/app/api/types/template-slot-extraction';
import { getUserTemplateById } from '@/src/lib/data/templates-repository';
import type {
  GenerationSlotSchemaItem,
  PdfPageInput,
  PdfVisionPageInput,
} from '@/src/lib/llm/fill-template-from-pdf';
import { logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';
import type { SlotReviewSessionPayload } from '@/src/lib/templates/slot-review-session';

interface UploadedFileMetadata {
  file_name?: string;
  parsed_pdf?: {
    pages?: Array<{ pageNumber?: number; text?: string }>;
    totalTextLength?: number;
    likelyScanned?: boolean;
  };
  vision_pages?: Array<{ page_number?: number; image_data_url?: string }>;
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

function sanitizeFileName(fileName: string) {
  const lastDotIndex = fileName.lastIndexOf('.');
  const extension = lastDotIndex >= 0 ? fileName.slice(lastDotIndex).toLowerCase() : '';
  const baseName = lastDotIndex >= 0 ? fileName.slice(0, lastDotIndex) : fileName;

  const normalizedBaseName = baseName
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  const safeBaseName = normalizedBaseName || 'file';
  const safeExtension = extension === '.pdf' ? extension : '.pdf';

  return `${safeBaseName}${safeExtension}`;
}

function buildSlotSchemaFromPayload(
  payload: SlotReviewSessionPayload | null | undefined,
): GenerationSlotSchemaItem[] {
  const paragraphs = Array.isArray(payload?.extractionResult) ? payload.extractionResult : [];

  return paragraphs.flatMap((paragraph: ExtractionParagraph, paragraphIndex) =>
    paragraph.items.map((item, itemIndex) => ({
      slot_key: `${paragraphIndex}-${itemIndex}-${item.sequence}`,
      field_category: item.field_category,
      meaning_to_applicant: item.meaning_to_applicant,
    })),
  );
}

function normalizeParsedPages(metadata: UploadedFileMetadata | undefined): PdfPageInput[] {
  const pages = metadata?.parsed_pdf?.pages;

  if (!Array.isArray(pages)) {
    return [];
  }

  return pages
    .filter(
      (page): page is { pageNumber: number; text: string } =>
        typeof page?.pageNumber === 'number' && typeof page?.text === 'string',
    )
    .map((page) => ({
      page_number: page.pageNumber,
      text: page.text,
    }));
}

function normalizeVisionPages(metadata: UploadedFileMetadata | undefined): PdfVisionPageInput[] {
  const pages = metadata?.vision_pages;

  if (!Array.isArray(pages)) {
    return [];
  }

  return pages
    .filter(
      (page): page is { page_number: number; image_data_url: string } =>
        typeof page?.page_number === 'number' &&
        typeof page?.image_data_url === 'string' &&
        page.image_data_url.startsWith('data:image/'),
    )
    .map((page) => ({
      page_number: page.page_number,
      image_data_url: page.image_data_url,
    }));
}

async function getAuthenticatedUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { supabase, user };
}

export async function GET() {
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  try {
    const { data: tasks, error: tasksError } = await supabase
      .from('generation_tasks')
      .select('id, template_id, template_name_snapshot, status, created_at')
      .eq('owner_id', user.id)
      .order('created_at', { ascending: false })
      .limit(30);

    if (tasksError) {
      throw tasksError;
    }

    const taskIds = (tasks ?? []).map((task) => task.id);

    if (taskIds.length === 0) {
      return NextResponse.json({ data: [] });
    }

    const { data: items, error: itemsError } = await supabase
      .from('generation_task_items')
      .select('id, task_id, source_pdf_name, status, reviewed_at, created_at, error_message')
      .in('task_id', taskIds)
      .order('created_at', { ascending: false });

    if (itemsError) {
      throw itemsError;
    }

    const taskMap = new Map((tasks ?? []).map((task) => [task.id, task]));
    const response = (items ?? [])
      .map((item) => {
        const task = taskMap.get(item.task_id);

        if (!task) {
          return null;
        }

        return {
          item_id: item.id,
          task_id: item.task_id,
          template_id: task.template_id,
          template_name_snapshot: task.template_name_snapshot,
          task_status: task.status,
          task_created_at: task.created_at,
          source_pdf_name: item.source_pdf_name,
          status: item.status,
          reviewed_at: item.reviewed_at,
          created_at: item.created_at,
          error_message: item.error_message,
        };
      })
      .filter((entry) => entry !== null);

    return NextResponse.json({
      data: response,
    });
  } catch (error) {
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_LIST_FAILED',
        message: error instanceof Error ? error.message : '读取任务列表失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  try {
    const formData = await request.formData();
    const templateId = String(formData.get('templateId') ?? '').trim();
    const fallbackTemplateName = String(formData.get('templateName') ?? '').trim();
    const rawMetadata = String(formData.get('fileMetadatas') ?? '[]');
    const fileMetadatas = JSON.parse(rawMetadata) as UploadedFileMetadata[];
    const files = formData.getAll('files').filter((entry): entry is File => entry instanceof File);

    if (!templateId) {
      return NextResponse.json(
        {
          code: 'TEMPLATE_ID_REQUIRED',
          message: '请先选择模板后再创建任务。',
        },
        { status: 400 },
      );
    }

    if (files.length === 0) {
      return NextResponse.json(
        {
          code: 'PDF_REQUIRED',
          message: '请至少上传一个 PDF 文件。',
        },
        { status: 400 },
      );
    }

    if (files.some((file) => !file.name.toLowerCase().endsWith('.pdf'))) {
      return NextResponse.json(
        {
          code: 'INVALID_PDF_FILE',
          message: '当前只支持上传 PDF 文件。',
        },
        { status: 400 },
      );
    }

    if (!Array.isArray(fileMetadatas) || fileMetadatas.length !== files.length) {
      return NextResponse.json(
        {
          code: 'FILE_METADATA_REQUIRED',
          message: '当前缺少 PDF 解析结果，请重新上传后再试。',
        },
        { status: 400 },
      );
    }

    const template = await getUserTemplateById(supabase, user, templateId);

    if (!template) {
      return NextResponse.json(
        {
          code: 'TEMPLATE_NOT_FOUND',
          message: '未找到该模板，可能已被删除。',
        },
        { status: 404 },
      );
    }

    const admin = createSupabaseAdminClient();
    const slotReviewPayload =
      (template.slot_review_payload as SlotReviewSessionPayload | null | undefined) ?? null;
    const slotSchema = buildSlotSchemaFromPayload(slotReviewPayload);

    const taskInsertPayload = {
      owner_id: user.id,
      template_id: templateId,
      template_name_snapshot: template.template_name ?? fallbackTemplateName ?? '未命名模板',
      status: 'pending',
      total_items: files.length,
      succeeded_items: 0,
      failed_items: 0,
    };

    const { data: task, error: taskError } = await admin
      .from('generation_tasks')
      .insert(taskInsertPayload)
      .select(
        'id, owner_id, template_id, template_name_snapshot, status, total_items, succeeded_items, failed_items, created_at',
      )
      .single();

    if (taskError || !task) {
      throw taskError ?? new Error('创建批量生成任务失败。');
    }

    const itemInsertPayloads = [];

    for (const [index, file] of files.entries()) {
      const metadata = fileMetadatas[index];
      const itemId = crypto.randomUUID();
      const storagePath = `${user.id}/${task.id}/${itemId}-${sanitizeFileName(file.name)}`;

      const { error: uploadError } = await admin.storage.from('generation-pdfs').upload(storagePath, file, {
        contentType: 'application/pdf',
        upsert: false,
      });

      if (uploadError) {
        await admin
          .from('generation_tasks')
          .update({
            status: 'failed',
            failed_items: files.length,
            finished_at: new Date().toISOString(),
          })
          .eq('id', task.id);

        throw uploadError;
      }

      itemInsertPayloads.push({
        id: itemId,
        task_id: task.id,
        owner_id: user.id,
        template_id: templateId,
        source_pdf_name: file.name,
        source_pdf_path: storagePath,
        status: 'uploaded',
        elapsed_seconds: 0,
        llm_input: {
          template_id: templateId,
          template_name: template.template_name,
          template_prompt: template.prompt ?? '',
          slot_schema: slotSchema,
          pages: normalizeParsedPages(metadata),
          vision_pages: normalizeVisionPages(metadata),
          likely_scanned: metadata?.parsed_pdf?.likelyScanned === true,
          total_text_length:
            typeof metadata?.parsed_pdf?.totalTextLength === 'number'
              ? metadata.parsed_pdf.totalTextLength
              : 0,
        },
      });
    }

    const { data: items, error: itemsError } = await admin
      .from('generation_task_items')
      .insert(itemInsertPayloads)
      .select(
        'id, task_id, source_pdf_name, source_pdf_path, status, elapsed_seconds, created_at',
      );

    if (itemsError || !items) {
      await admin
        .from('generation_tasks')
        .update({
          status: 'failed',
          failed_items: files.length,
          finished_at: new Date().toISOString(),
        })
        .eq('id', task.id);

      throw itemsError ?? new Error('创建批量任务明细失败。');
    }

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'info',
      eventType: 'generation_task_created',
      message: `Created generation task with ${items.length} items.`,
      route: '/api/generation-tasks',
      templateId,
      taskId: task.id,
      payload: {
        templateName: task.template_name_snapshot,
        fileCount: files.length,
        sourcePdfNames: files.map((file) => file.name),
      },
    });

    return NextResponse.json({
      data: {
        task,
        items,
      },
    });
  } catch (error) {
    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'generation_task_create_failed',
      message: error instanceof Error ? error.message : 'Failed to create generation task.',
      route: '/api/generation-tasks',
    });

    return NextResponse.json(
      {
        code: 'GENERATION_TASK_CREATE_FAILED',
        message: error instanceof Error ? error.message : '创建批量生成任务失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}
