import { NextResponse } from 'next/server';
import { getRawErrorMessage } from '@/src/lib/errors/raw-error';
import { createGeminiImageProxyFile } from '@/src/lib/gemini/image-proxy';
import type { GeminiVisionFile } from '@/src/lib/llm/gemini-vision-file';
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
  content_type?: string | null;
  size?: number | null;
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

export const GENERATION_TASK_ITEM_RUNNING_STATUSES = [
  'uploaded',
  'running',
  'pending',
  'page_preparing',
  'ocr_running',
  'slot_filling',
] as const;

export const VERCEL_FUNCTION_TIMEOUT_SECONDS = 300;
export const GENERATION_TASK_ITEM_TIMEOUT_GRACE_SECONDS = 5;

const GENERATION_TASK_ITEM_TIMEOUT_MESSAGE =
  '处理超时：Vercel 函数最长运行 300 秒，任务已停止，请减少页数或槽位后重试。';

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
    .map((entry) => ({
      ...entry,
      content_type:
        typeof (entry as { content_type?: unknown }).content_type === 'string'
          ? (entry as { content_type: string }).content_type
          : null,
      size:
        typeof (entry as { size?: unknown }).size === 'number' &&
        Number.isFinite((entry as { size: number }).size)
          ? (entry as { size: number }).size
          : null,
    }))
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

function getImageAssetMimeType(asset: PdfPageImageAsset) {
  const contentType = asset.content_type?.trim();

  if (contentType?.startsWith('image/')) {
    return contentType;
  }

  return getMimeTypeFromStoragePath(asset.storage_path);
}

export async function loadVisionPagesFromStoredAssets(params: {
  admin: AdminClient;
  pageImageAssets: PdfPageImageAsset[];
}): Promise<PdfVisionPageInput[]> {
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

export async function buildStoredPageImageProxyVisionPages(params: {
  pageImageAssets: PdfPageImageAsset[];
  requestLabel: string;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}): Promise<PdfVisionPageInput[]> {
  if (params.pageImageAssets.length === 0) {
    return [] as PdfVisionPageInput[];
  }

  const startedAt = Date.now();

  await params.onTrace?.({
    message: `[Gemini Image Proxy][StoragePipelineStart] ${JSON.stringify({
      request_label: params.requestLabel,
      image_count: params.pageImageAssets.length,
      source: 'vercel_gemini_image_proxy',
    })}`,
  });

  const pages: PdfVisionPageInput[] = [];

  for (const [index, asset] of params.pageImageAssets.entries()) {
    const mimeType = getImageAssetMimeType(asset);
    const geminiFile = createGeminiImageProxyFile({
      storagePath: asset.storage_path,
      mimeType,
      sizeBytes: asset.size ?? 0,
      displayName: `${params.requestLabel}-page-${asset.uploaded_page_number}`,
    });

    await params.onTrace?.({
      message: `[Gemini Image Proxy][StoragePipelinePageComplete] ${JSON.stringify({
        request_label: params.requestLabel,
        sequence_index: index + 1,
        uploaded_page_number: asset.uploaded_page_number,
        original_page_number: asset.original_page_number,
        storage_path: asset.storage_path,
        mime_type: mimeType,
        image_size_bytes: asset.size ?? null,
        file_uri: geminiFile.uri,
        source: 'vercel_gemini_image_proxy',
      })}`,
    });

    pages.push({
      page_number: asset.uploaded_page_number,
      image_data_url: '',
      original_page_number: asset.original_page_number,
      gemini_file: geminiFile,
    });
  }

  const durationMs = Date.now() - startedAt;

  await params.onTrace?.({
    message: `[Gemini Image Proxy][StoragePipelineComplete] ${JSON.stringify({
      request_label: params.requestLabel,
      image_count: pages.length,
      source: 'vercel_gemini_image_proxy',
      duration_ms: durationMs,
      duration_seconds: Number((durationMs / 1000).toFixed(2)),
    })}`,
  });

  return pages;
}

export function collectGeminiFilesFromVisionPages(
  pages: PdfVisionPageInput[],
) {
  const filesByNameOrUri = new Map<string, GeminiVisionFile>();

  pages.forEach((page) => {
    const file = page.gemini_file;

    if (!file?.uri || !file.name) {
      return;
    }

    filesByNameOrUri.set(file.name ?? file.uri, file);
  });

  return Array.from(filesByNameOrUri.values());
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

export function isGenerationTaskItemRunningStatus(status: string) {
  return GENERATION_TASK_ITEM_RUNNING_STATUSES.some(
    (runningStatus) => runningStatus === status,
  );
}

export async function markTimedOutGenerationTaskItems(params: {
  admin: AdminClient;
  taskId: string;
  items: Array<{
    id: string;
    status: string;
    elapsed_seconds: number;
    started_at?: string | null;
    finished_at?: string | null;
  }>;
}) {
  const now = Date.now();
  const timedOutItems = params.items.filter((item) => {
    if (!isGenerationTaskItemRunningStatus(item.status) || !item.started_at) {
      return false;
    }

    const startedAtMs = Date.parse(item.started_at);

    if (!Number.isFinite(startedAtMs)) {
      return false;
    }

    const elapsedSeconds = Math.floor((now - startedAtMs) / 1000);

    return (
      elapsedSeconds >=
      VERCEL_FUNCTION_TIMEOUT_SECONDS + GENERATION_TASK_ITEM_TIMEOUT_GRACE_SECONDS
    );
  });

  if (timedOutItems.length === 0) {
    return { updated: false, timedOutItemIds: [] as string[] };
  }

  const finishedAt = new Date().toISOString();
  const timedOutItemIds = timedOutItems.map((item) => item.id);

  const { error } = await params.admin
    .from('generation_task_items')
    .update({
      status: 'failed',
      error_message: GENERATION_TASK_ITEM_TIMEOUT_MESSAGE,
      elapsed_seconds: VERCEL_FUNCTION_TIMEOUT_SECONDS,
      finished_at: finishedAt,
    })
    .in('id', timedOutItemIds);

  if (error) {
    throw error;
  }

  await Promise.all(
    timedOutItemIds.map((taskItemId) =>
      appendProcessingTrace(
        params.admin,
        taskItemId,
        `[Vercel Runtime Timeout] Task exceeded ${VERCEL_FUNCTION_TIMEOUT_SECONDS} seconds and was marked as failed during status refresh.`,
      ),
    ),
  );
  await recalculateTaskSummary(params.admin, params.taskId);

  return { updated: true, timedOutItemIds };
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
