import { NextResponse } from 'next/server';
import type { ExtractionParagraph } from '@/src/app/api/types/template-slot-extraction';
import { getRawErrorMessage } from '@/src/lib/errors/raw-error';
import { getUserTemplateById } from '@/src/lib/data/templates-repository';
import type {
  GenerationSlotSchemaItem,
  GenerationSlotReferencePdfEvidence,
  PdfPageInput,
  PdfVisionPageInput,
} from '@/src/lib/llm/fill-template-from-pdf';
import { logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';
import type { SlotReviewSessionPayload } from '@/src/lib/templates/slot-review-session';
import {
  getExtractionItemSlotKey,
  getPdfEvidenceMatchSlotKey,
} from '@/src/lib/templates/slot-key';

interface UploadedFileMetadata {
  file_name?: string;
  storage_path?: string;
  force_vision_page_fill?: boolean;
  force_ocr?: boolean;
  ocr_image_assets?: Array<{
    uploaded_page_number?: number;
    original_page_number?: number;
    storage_path?: string;
    content_type?: string;
    size?: number;
    gemini_file?: {
      uri?: string;
      name?: string | null;
      mime_type?: string;
      mimeType?: string;
      size_bytes?: number | null;
      sizeBytes?: number | null;
      display_name?: string | null;
      displayName?: string | null;
      uploaded_at?: string | null;
    } | null;
    rotation_applied?: -90 | 0 | 90 | 180;
    crop?: GenerationSlotReferencePdfEvidence['example_page_crop'];
  }>;
  parsed_pdf?: {
    pages?: Array<{ pageNumber?: number; text?: string }>;
    totalTextLength?: number;
    likelyScanned?: boolean;
  };
  vision_pages?: Array<{ page_number?: number; image_data_url?: string }>;
  selected_original_page_numbers?: number[];
  uploaded_page_number_mapping?: Array<{
    uploaded_page_number?: number;
    original_page_number?: number;
  }>;
  original_total_pages?: number;
  selected_page_count?: number;
  selected_page_range_label?: string;
}

function normalizePdfPageImageAssets(
  metadata: UploadedFileMetadata | undefined,
) {
  const assets = metadata?.ocr_image_assets;

  if (!Array.isArray(assets)) {
    return [];
  }

  return assets
    .filter(
      (
        entry,
      ): entry is {
        uploaded_page_number: number;
        original_page_number: number;
        storage_path: string;
        content_type?: string;
        size?: number;
        rotation_applied?: -90 | 0 | 90 | 180;
        gemini_file?: {
          uri?: string;
          name?: string | null;
          mime_type?: string;
          mimeType?: string;
          size_bytes?: number | null;
          sizeBytes?: number | null;
          display_name?: string | null;
          displayName?: string | null;
          uploaded_at?: string | null;
        } | null;
        crop?: GenerationSlotReferencePdfEvidence['example_page_crop'];
      } =>
        typeof entry?.uploaded_page_number === 'number' &&
        Number.isInteger(entry.uploaded_page_number) &&
        entry.uploaded_page_number > 0 &&
        typeof entry?.original_page_number === 'number' &&
        Number.isInteger(entry.original_page_number) &&
        entry.original_page_number > 0 &&
        typeof entry?.storage_path === 'string' &&
        entry.storage_path.trim().length > 0,
    )
    .map((entry) => {
      const rawGeminiFile =
        entry.gemini_file && typeof entry.gemini_file === 'object'
          ? entry.gemini_file
          : null;
      const geminiFileUri =
        typeof rawGeminiFile?.uri === 'string' ? rawGeminiFile.uri.trim() : '';
      const geminiFileMimeType =
        typeof rawGeminiFile?.mime_type === 'string'
          ? rawGeminiFile.mime_type.trim()
          : typeof rawGeminiFile?.mimeType === 'string'
            ? rawGeminiFile.mimeType.trim()
            : '';
      const geminiFileSizeBytes =
        typeof rawGeminiFile?.size_bytes === 'number'
          ? rawGeminiFile.size_bytes
          : typeof rawGeminiFile?.sizeBytes === 'number'
            ? rawGeminiFile.sizeBytes
            : typeof entry.size === 'number'
              ? entry.size
              : null;

      return {
        uploaded_page_number: entry.uploaded_page_number,
        original_page_number: entry.original_page_number,
        storage_path: entry.storage_path,
        ...(typeof entry.content_type === 'string' && entry.content_type.trim()
          ? { content_type: entry.content_type.trim() }
          : {}),
        ...(typeof entry.size === 'number' && Number.isFinite(entry.size)
          ? { size: entry.size }
          : {}),
        ...(geminiFileUri && geminiFileMimeType
          ? {
              gemini_file: {
                uri: geminiFileUri,
                name:
                  typeof rawGeminiFile?.name === 'string'
                    ? rawGeminiFile.name
                    : null,
                mime_type: geminiFileMimeType,
                size_bytes:
                  typeof geminiFileSizeBytes === 'number' &&
                  Number.isFinite(geminiFileSizeBytes)
                    ? geminiFileSizeBytes
                    : null,
                display_name:
                  typeof rawGeminiFile?.display_name === 'string'
                    ? rawGeminiFile.display_name
                    : typeof rawGeminiFile?.displayName === 'string'
                      ? rawGeminiFile.displayName
                      : null,
                uploaded_at:
                  typeof rawGeminiFile?.uploaded_at === 'string'
                    ? rawGeminiFile.uploaded_at
                    : null,
                expires_at: null,
                request_label: 'gemini_file_api',
              },
            }
          : {}),
        ...(typeof entry.rotation_applied === 'number'
          ? { rotation_applied: entry.rotation_applied }
          : {}),
        ...(entry.crop ? { crop: entry.crop } : {}),
      };
    })
    .sort(
      (left, right) => left.uploaded_page_number - right.uploaded_page_number,
    );
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

function getErrorMessage(error: unknown) {
  return getRawErrorMessage(error);
}

function buildSlotSchemaFromPayload(
  payload: SlotReviewSessionPayload | null | undefined,
): GenerationSlotSchemaItem[] {
  const paragraphs = Array.isArray(payload?.extractionResult)
    ? payload.extractionResult
    : [];
  const evidenceMatches = Array.isArray(payload?.pdfEvidence?.matches)
    ? payload.pdfEvidence.matches
    : [];
  const evidencePages = Array.isArray(payload?.pdfEvidence?.pages)
    ? payload.pdfEvidence.pages
    : [];

  const buildReferenceEvidence = (
    paragraphIndex: number,
    itemIndex: number,
    item: ExtractionParagraph['items'][number],
  ): GenerationSlotReferencePdfEvidence | null => {
    const slotKey = getExtractionItemSlotKey(item, paragraphIndex, itemIndex);
    const match = evidenceMatches.find(
      (candidate) => getPdfEvidenceMatchSlotKey(candidate) === slotKey,
    );

    if (!match) {
      return null;
    }

    const page = evidencePages.find(
      (candidate) => candidate.pageNumber === match.page_number,
    );

    return {
      example_pdf_file_name: payload?.pdfEvidence?.pdfFileName ?? '',
      example_page_number: match.page_number,
      example_bbox: match.bbox ?? null,
      example_evidence_text: match.evidence_text,
      example_slot_value: match.original_value || item.original_value,
      example_confidence: match.confidence,
      example_match_type: match.match_type,
      example_page_storage_path: page?.storagePath,
      example_page_crop: page?.crop ?? null,
    };
  };

  return paragraphs.flatMap((paragraph: ExtractionParagraph, paragraphIndex) =>
    paragraph.items.map((item, itemIndex) => ({
      slot_key: getExtractionItemSlotKey(item, paragraphIndex, itemIndex),
      field_category: item.field_category,
      meaning_to_applicant: item.meaning_to_applicant,
      template_original_value: item.original_value,
      // template_original_doc_position is intentionally not passed into the
      // slot-fill flow for now.
      reference_pdf_evidence: buildReferenceEvidence(
        paragraphIndex,
        itemIndex,
        item,
      ),
    })),
  );
}

function normalizeParsedPages(
  metadata: UploadedFileMetadata | undefined,
): PdfPageInput[] {
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

function normalizeVisionPages(
  metadata: UploadedFileMetadata | undefined,
): PdfVisionPageInput[] {
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

function normalizeSelectedOriginalPageNumbers(
  metadata: UploadedFileMetadata | undefined,
) {
  const pageNumbers = metadata?.selected_original_page_numbers;

  if (!Array.isArray(pageNumbers)) {
    return [];
  }

  return pageNumbers
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isInteger(value) && value > 0,
    )
    .sort((left, right) => left - right);
}

function normalizeUploadedPageNumberMapping(
  metadata: UploadedFileMetadata | undefined,
) {
  const mappings = metadata?.uploaded_page_number_mapping;

  if (!Array.isArray(mappings)) {
    return [];
  }

  return mappings
    .filter(
      (
        entry,
      ): entry is {
        uploaded_page_number: number;
        original_page_number: number;
      } =>
        typeof entry?.uploaded_page_number === 'number' &&
        Number.isInteger(entry.uploaded_page_number) &&
        entry.uploaded_page_number > 0 &&
        typeof entry?.original_page_number === 'number' &&
        Number.isInteger(entry.original_page_number) &&
        entry.original_page_number > 0,
    )
    .sort(
      (left, right) => left.uploaded_page_number - right.uploaded_page_number,
    );
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
      .select(
        'id, task_id, source_pdf_name, status, reviewed_at, created_at, error_message',
      )
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
    const errorMessage = getErrorMessage(error);
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_LIST_FAILED',
        message: errorMessage,
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
    const fallbackTemplateName = String(
      formData.get('templateName') ?? '',
    ).trim();
    const rawMetadata = String(formData.get('fileMetadatas') ?? '[]');
    const fileMetadatas = JSON.parse(rawMetadata) as UploadedFileMetadata[];
    const files = formData
      .getAll('files')
      .filter((entry): entry is File => entry instanceof File);

    if (!templateId) {
      return NextResponse.json(
        {
          code: 'TEMPLATE_ID_REQUIRED',
          message: '请先选择模板后再创建任务。',
        },
        { status: 400 },
      );
    }

    if (files.length === 0 && fileMetadatas.length === 0) {
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

    if (!Array.isArray(fileMetadatas) || fileMetadatas.length === 0) {
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

    if (files.length > 0 && fileMetadatas.length !== files.length) {
      return NextResponse.json(
        {
          code: 'FILE_METADATA_REQUIRED',
          message: '上传文件数量与元数据数量不一致，请重新上传后再试。',
        },
        { status: 400 },
      );
    }

    const admin = createSupabaseAdminClient();
    const slotReviewPayload =
      (template.slot_review_payload as
        | SlotReviewSessionPayload
        | null
        | undefined) ?? null;
    const slotSchema = buildSlotSchemaFromPayload(slotReviewPayload);

    const taskInsertPayload = {
      owner_id: user.id,
      template_id: templateId,
      template_name_snapshot:
        template.template_name ?? fallbackTemplateName ?? '未命名模板',
      status: 'pending',
      total_items: fileMetadatas.length,
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

    for (const [index, metadata] of fileMetadatas.entries()) {
      const itemId = crypto.randomUUID();
      const preUploadedStoragePath =
        typeof metadata?.storage_path === 'string'
          ? metadata.storage_path.trim()
          : '';
      const storagePath = preUploadedStoragePath;

      if (!storagePath) {
        await admin
          .from('generation_tasks')
          .update({
            status: 'failed',
            failed_items: fileMetadatas.length,
            finished_at: new Date().toISOString(),
          })
          .eq('id', task.id);

        throw new Error(`第 ${index + 1} 个 PDF 缺少存储路径。`);
      }

      itemInsertPayloads.push({
        id: itemId,
        task_id: task.id,
        owner_id: user.id,
        template_id: templateId,
        source_pdf_name:
          metadata?.file_name ?? files[index]?.name ?? `PDF-${index + 1}.pdf`,
        source_pdf_path: storagePath,
        status: 'uploaded',
        elapsed_seconds: 0,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
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
          force_vision_page_fill:
            metadata?.force_vision_page_fill === true ||
            metadata?.force_ocr === true,
          ocr_image_assets: normalizePdfPageImageAssets(metadata),
          selected_original_page_numbers:
            normalizeSelectedOriginalPageNumbers(metadata),
          uploaded_page_number_mapping:
            normalizeUploadedPageNumberMapping(metadata),
          original_total_pages:
            typeof metadata?.original_total_pages === 'number' &&
            Number.isInteger(metadata.original_total_pages)
              ? metadata.original_total_pages
              : normalizeParsedPages(metadata).length,
          selected_page_count:
            typeof metadata?.selected_page_count === 'number' &&
            Number.isInteger(metadata.selected_page_count)
              ? metadata.selected_page_count
              : normalizeParsedPages(metadata).length,
          selected_page_range_label:
            typeof metadata?.selected_page_range_label === 'string'
              ? metadata.selected_page_range_label
              : '',
        },
      });
    }

    const { data: items, error: itemsError } = await admin
      .from('generation_task_items')
      .insert(itemInsertPayloads)
      .select(
        'id, task_id, source_pdf_name, source_pdf_path, status, elapsed_seconds, slot_total_count, slot_completed_count, processing_trace, created_at',
      );

    if (itemsError || !items) {
      await admin
        .from('generation_tasks')
        .update({
          status: 'failed',
          failed_items: fileMetadatas.length,
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
        fileCount: fileMetadatas.length,
        sourcePdfNames: fileMetadatas.map(
          (metadata, index) =>
            metadata.file_name ?? files[index]?.name ?? `PDF-${index + 1}.pdf`,
        ),
      },
    });

    return NextResponse.json({
      data: {
        task,
        items,
      },
    });
  } catch (error) {
    const errorMessage = getErrorMessage(error);

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'generation_task_create_failed',
      message: errorMessage,
      route: '/api/generation-tasks',
    });

    return NextResponse.json(
      {
        code: 'GENERATION_TASK_CREATE_FAILED',
        message: errorMessage,
      },
      { status: 500 },
    );
  }
}
