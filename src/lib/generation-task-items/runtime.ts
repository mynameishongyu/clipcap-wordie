import { NextResponse } from 'next/server';
import { getRawErrorMessage } from '@/src/lib/errors/raw-error';
import type {
  GenerationSlotSchemaItem,
  PdfPageInput,
  PdfVisionPageInput,
} from '@/src/lib/llm/fill-template-from-pdf';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';

export type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export type PdfPageImageAsset = {
  uploaded_page_number: number;
  original_page_number: number;
  storage_path: string;
  filter_decision?: 'keep' | 'drop' | 'review' | string;
  filter_reason?: string | null;
  filter_confidence?: number | null;
  used_for_slot_fill?: boolean;
  gemini_file?: {
    uri: string;
    name?: string | null;
    mime_type: string;
    size_bytes?: number | null;
    display_name?: string | null;
    uploaded_at?: string | null;
    request_label?: string | null;
  } | null;
  rotation_applied?: -90 | 0 | 90 | 180;
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

export type GenerationTaskItemRecord = {
  id: string;
  task_id: string;
  owner_id: string;
  template_id: string | null;
  source_pdf_name: string;
  source_pdf_path: string;
  status: string;
  elapsed_seconds: number;
  slot_total_count: number;
  slot_completed_count: number;
  processing_trace?: string;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  reviewed_at?: string | null;
  output_docx_path?: string | null;
  error_message?: string | null;
  llm_input?: {
    template_name?: string;
    template_prompt?: string;
    slot_schema?: GenerationSlotSchemaItem[];
    pages?: PdfPageInput[];
    vision_pages?: PdfVisionPageInput[];
    ocr_image_assets?: PdfPageImageAsset[];
    likely_scanned?: boolean;
    total_text_length?: number;
    force_vision_page_fill?: boolean;
    selected_original_page_numbers?: number[];
    confirmed_slot_fill_page_numbers?: number[];
    uploaded_page_number_mapping?: Array<{
      uploaded_page_number: number;
      original_page_number: number;
    }>;
    selected_page_range_label?: string;
    page_filter?: {
      completed_at?: string;
      total_page_count?: number;
      kept_page_count?: number;
      dropped_page_count?: number;
      review_page_count?: number;
      drop_example_count?: number;
      model?: string;
      provider?: string;
      error_message?: string;
    };
  } | null;
};

export const generationTaskItemSelect =
  'id, task_id, owner_id, template_id, source_pdf_name, source_pdf_path, status, elapsed_seconds, slot_total_count, slot_completed_count, processing_trace, created_at, started_at, finished_at, reviewed_at, output_docx_path, error_message, llm_input';

export function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: '请先登录后再继续。',
    },
    { status: 401 },
  );
}

export function getErrorMessage(error: unknown) {
  return getRawErrorMessage(error);
}

export function buildFallbackReviewPayload(slotSchema: GenerationSlotSchemaItem[]) {
  return {
    document_summary: '',
    extracted_items: slotSchema.map((slot) => ({
      slot_key: slot.slot_key,
      field_category: slot.field_category,
      meaning_to_applicant: slot.meaning_to_applicant,
      original_value: '',
      evidence: '',
      evidence_page_numbers: [],
      notes: '',
      confidence: null,
    })),
  };
}

export function formatProcessingTraceEntry(message: string) {
  return `[${new Date().toISOString()}] ${message}`;
}

export function normalizePages(value: unknown): PdfPageInput[] {
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

export function normalizeVisionPages(value: unknown): PdfVisionPageInput[] {
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

export function normalizeSelectedOriginalPageNumbers(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (pageNumber): pageNumber is number =>
      typeof pageNumber === 'number' && Number.isInteger(pageNumber) && pageNumber > 0,
  );
}

export function normalizePdfPageImageAssets(value: unknown): PdfPageImageAsset[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (entry): entry is PdfPageImageAsset =>
        !!entry &&
        typeof entry === 'object' &&
        typeof entry.uploaded_page_number === 'number' &&
        Number.isInteger(entry.uploaded_page_number) &&
        entry.uploaded_page_number > 0 &&
        typeof entry.original_page_number === 'number' &&
        Number.isInteger(entry.original_page_number) &&
        entry.original_page_number > 0 &&
        typeof entry.storage_path === 'string' &&
        entry.storage_path.trim().length > 0,
    )
    .sort((left, right) => left.uploaded_page_number - right.uploaded_page_number);
}

export function filterPdfPageImageAssetsForSlotFill(assets: PdfPageImageAsset[]) {
  return assets.filter((asset) => asset.used_for_slot_fill !== false);
}

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

export async function loadVisionPagesFromStoredAssets(params: {
  admin: AdminClient;
  pageImageAssets: PdfPageImageAsset[];
}) {
  if (params.pageImageAssets.length === 0) {
    return [];
  }

  return Promise.all(
    params.pageImageAssets.map(async (asset) => {
      const { data: fileBlob, error } = await params.admin.storage
        .from('generation-pdfs')
        .download(asset.storage_path);

      if (error || !fileBlob) {
        const errorMessage = error?.message ?? 'Missing storage object';

        throw new Error(
          `[PDF Fill][StorageDownloadFailed] Unable to download uploaded PDF page image: storage_path=${asset.storage_path}, uploaded_page=${asset.uploaded_page_number}, original_page=${asset.original_page_number}, error=${errorMessage}`,
          error ? { cause: error } : undefined,
        );
      }

      const buffer = Buffer.from(await fileBlob.arrayBuffer());
      const mimeType = fileBlob.type || getMimeTypeFromStoragePath(asset.storage_path);

      return {
        page_number: asset.uploaded_page_number,
        image_data_url: `data:${mimeType};base64,${buffer.toString('base64')}`,
        original_page_number: asset.original_page_number,
      } satisfies PdfVisionPageInput;
    }),
  );
}

export async function recalculateTaskSummary(admin: AdminClient, taskId: string) {
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
    items?.some((item) =>
      [
        'running',
        'uploaded',
        'pending',
        'page_preparing',
        'ocr_running',
        'pdf_pages_ready',
        'slot_filling',
      ].includes(item.status),
    ) ?? false;

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

export async function updateSlotProgress(
  admin: AdminClient,
  taskItemId: string,
  progress: { completedSlots: number; totalSlots: number },
) {
  await admin
    .from('generation_task_items')
    .update({
      slot_total_count: progress.totalSlots,
      slot_completed_count: progress.completedSlots,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskItemId);
}

export async function appendProcessingTrace(
  admin: AdminClient,
  taskItemId: string,
  message: string,
) {
  try {
    const { error } = await admin.rpc('append_generation_task_item_processing_trace', {
      p_task_item_id: taskItemId,
      p_entry: formatProcessingTraceEntry(message),
    });

    if (error) {
      console.error('[Generation Task] Failed to append processing trace.', error);
    }
  } catch (error) {
    console.error('[Generation Task] Failed to append processing trace.', error);
  }
}
