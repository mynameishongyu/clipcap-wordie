import { after, NextResponse } from 'next/server';
import {
  fillSlotsFromVisionPages,
  type GenerationSlotSchemaItem,
  type PdfVisionPageInput,
  normalizedBboxToGeminiBox2d,
  type ReferencePdfVisionPageInput,
} from '@/src/lib/llm/fill-template-from-pdf';
import {
  createGeminiImageProxyFile,
  createGeminiImageProxyUrl,
} from '@/src/lib/gemini/image-proxy';
import {
  getLlmRuntimeConfig,
  getLlmRuntimeTraceConfig,
} from '@/src/lib/llm/provider';
import {
  createLlmUsageAccumulator,
  summarizeLlmUsage,
} from '@/src/lib/llm/usage';
import {
  appendProcessingTrace,
  buildStoredPageImageFileApiVisionPages,
  buildStoredPageImageSupabaseSignedUrlVisionPages,
  buildFallbackReviewPayload,
  cleanupGeminiFileApiFilesForTrace,
  collectGeminiFileApiFilesFromAssets,
  collectGeminiFileApiFilesFromVisionPages,
  createUnauthorizedResponse,
  generationTaskItemSelect,
  type GenerationTaskItemRecord,
  type PdfPageImageAsset,
  getErrorMessage,
  filterPdfPageImageAssetsForSlotFill,
  loadVisionPagesFromStoredAssets,
  normalizePdfPageImageAssets,
  recalculateTaskSummary,
  updateSlotProgress,
} from '@/src/lib/generation-task-items/runtime';
import { buildErrorLogPayload, logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';
import { getSupabaseSignedUrlExpiresInSeconds } from '@/src/lib/supabase/signed-url';

export const runtime = 'nodejs';
export const maxDuration = 300;

const PROCESS_HARD_TIMEOUT_MS = maxDuration * 1000;

/*
// Reserved for the previous manual page-confirmation flow. The current
// automated flow uses page-preparation's persisted used_for_slot_fill flags.
function parseConfirmedPageNumber(value: unknown) {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return Number.parseInt(value, 10);
  }

  return NaN;
}

function normalizeConfirmedPageNumbers(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  const parsedPageNumbers = value.map(parseConfirmedPageNumber);
  const validPageNumbers = parsedPageNumbers.filter(
    (pageNumber) => Number.isInteger(pageNumber) && pageNumber > 0,
  );
  const uniquePageNumbers = Array.from(new Set(validPageNumbers));
  const sortedPageNumbers = uniquePageNumbers.sort(
    (left, right) => left - right,
  );

  return sortedPageNumbers;
}
*/

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

function hasUsableReferenceBbox(slot: GenerationSlotSchemaItem) {
  const bbox = slot.reference_pdf_evidence?.example_bbox;

  return (
    Boolean(bbox) &&
    typeof bbox?.x === 'number' &&
    typeof bbox?.y === 'number' &&
    typeof bbox?.width === 'number' &&
    typeof bbox?.height === 'number' &&
    bbox.width > 0 &&
    bbox.height > 0
  );
}

type ReferenceSlotBox = {
  slotKey: string;
  slotName: string;
  slotSource: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  exampleEvidenceText: string;
  exampleSlotValue: string;
};

function getVercelMemoryUsageSnapshot(stage: string) {
  const memory = process.memoryUsage();

  return {
    stage,
    rss_bytes: memory.rss,
    heap_total_bytes: memory.heapTotal,
    heap_used_bytes: memory.heapUsed,
    external_bytes: memory.external,
    array_buffers_bytes: memory.arrayBuffers,
  };
}

async function appendMemoryTrace(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  taskItemId: string,
  stage: string,
  details?: Record<string, unknown>,
) {
  await appendProcessingTrace(
    admin,
    taskItemId,
    `[Vercel Memory][PDF Fill][SlotFill] ${JSON.stringify({
      ...getVercelMemoryUsageSnapshot(stage),
      ...(details ?? {}),
    })}`,
  );
}

function buildReferenceAnnotationStoragePath(params: {
  ownerId: string;
  taskItemId: string;
  templateId?: string | null;
  pageNumber: number;
}) {
  if (!params.templateId) {
    return `${params.ownerId}/template-reference-pages/annotated/task/${params.taskItemId}/page-${params.pageNumber}.jpg`;
  }

  return `${params.ownerId}/template-reference-pages/annotated/${params.templateId}/page-${params.pageNumber}.jpg`;
}

async function createReferenceAnnotationSignedUrl(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  storagePath: string;
}) {
  const slashIndex = params.storagePath.lastIndexOf('/');
  const folderPath =
    slashIndex >= 0 ? params.storagePath.slice(0, slashIndex) : '';
  const fileName =
    slashIndex >= 0
      ? params.storagePath.slice(slashIndex + 1)
      : params.storagePath;
  const { data: entries, error: listError } = await params.admin.storage
    .from('generation-pdfs')
    .list(folderPath, {
      limit: 1,
      search: fileName,
    });

  if (listError) {
    throw listError;
  }

  if (!entries?.some((entry) => entry.name === fileName)) {
    throw new Error(`Missing storage object for ${params.storagePath}`);
  }

  const { data, error } = await params.admin.storage
    .from('generation-pdfs')
    .createSignedUrl(
      params.storagePath,
      getSupabaseSignedUrlExpiresInSeconds(),
    );

  if (error || !data?.signedUrl) {
    throw error ?? new Error(`Missing signed URL for ${params.storagePath}`);
  }

  return data.signedUrl;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(
          items[currentIndex]!,
          currentIndex,
        );
      }
    }),
  );

  return results;
}

async function loadReferenceExamplePagesWithBbox(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  taskItemId: string;
  ownerId: string;
  templateId?: string | null;
  slots: GenerationSlotSchemaItem[];
}) {
  const pageAssetsByKey = new Map<
    string,
    {
      pageNumber: number;
      storagePath: string;
      examplePdfFileName?: string;
      slotBoxes: ReferenceSlotBox[];
    }
  >();
  const llmConfig = getLlmRuntimeConfig('vision');
  let skippedSlotsWithoutBbox = 0;
  let skippedSlotsWithoutPageImage = 0;

  for (const slot of params.slots) {
    const reference = slot.reference_pdf_evidence;

    if (!reference || !hasUsableReferenceBbox(slot)) {
      skippedSlotsWithoutBbox += 1;
      continue;
    }

    const pageNumber = reference.example_page_number;
    const storagePath = reference.example_page_storage_path?.trim();

    if (!pageNumber || !storagePath) {
      skippedSlotsWithoutPageImage += 1;
      continue;
    }

    const bbox = reference.example_bbox;

    if (!bbox) {
      skippedSlotsWithoutBbox += 1;
      continue;
    }

    const pageAssetKey = `${pageNumber}:${storagePath}`;
    const existingPageAsset = pageAssetsByKey.get(pageAssetKey);
    const slotBox = {
      slotKey: slot.slot_key,
      slotName: slot.field_category,
      slotSource: slot.meaning_to_applicant,
      bbox,
      exampleEvidenceText: reference.example_evidence_text ?? '',
      exampleSlotValue: reference.example_slot_value ?? '',
    } satisfies ReferenceSlotBox;

    if (existingPageAsset) {
      existingPageAsset.slotBoxes.push(slotBox);
      continue;
    }

    pageAssetsByKey.set(pageAssetKey, {
      pageNumber,
      storagePath,
      examplePdfFileName: reference.example_pdf_file_name,
      slotBoxes: [slotBox],
    });
  }

  const referencePageAssets = [...pageAssetsByKey.values()].sort(
    (left, right) => left.pageNumber - right.pageNumber,
  );
  const pageResults = await runWithConcurrency(
    referencePageAssets,
    2,
    async (asset) => {
      const annotatedStoragePath = buildReferenceAnnotationStoragePath({
        ownerId: params.ownerId,
        taskItemId: params.taskItemId,
        templateId: params.templateId,
        pageNumber: asset.pageNumber,
      });

      try {
        const annotatedPreviewUrl = await createReferenceAnnotationSignedUrl({
          admin: params.admin,
          storagePath: annotatedStoragePath,
        });
        const annotatedMimeType =
          getMimeTypeFromStoragePath(annotatedStoragePath);
        let annotatedImageUrl = annotatedPreviewUrl;
        let annotatedGeminiFile:
          | ReturnType<typeof createGeminiImageProxyFile>
          | undefined;

        if (llmConfig.provider === 'doubao') {
          /*
          // Previous Doubao path used the Vercel image proxy for annotated
          // reference pages. Keep the proxy helpers available for rollback;
          // Doubao now uses Supabase signed URLs directly.
          annotatedImageUrl = createGeminiImageProxyUrl({
            storagePath: annotatedStoragePath,
            mimeType: annotatedMimeType,
          });
          annotatedGeminiFile = createGeminiImageProxyFile({
            storagePath: annotatedStoragePath,
            mimeType: annotatedMimeType,
            sizeBytes: 0,
            displayName: `annotated-reference-page-${asset.pageNumber}`,
          });
          */
        } else {
          annotatedImageUrl = createGeminiImageProxyUrl({
            storagePath: annotatedStoragePath,
            mimeType: annotatedMimeType,
          });
          annotatedGeminiFile = createGeminiImageProxyFile({
            storagePath: annotatedStoragePath,
            mimeType: annotatedMimeType,
            sizeBytes: 0,
            displayName: `annotated-reference-page-${asset.pageNumber}`,
          });
        }

        console.info(
          '[PDF Fill][ReferenceExample] Using browser-saved annotated reference page image',
          {
            pageNumber: asset.pageNumber,
            annotatedStoragePath,
            slotCount: asset.slotBoxes.length,
          },
        );

        return {
          page: {
            page_number: asset.pageNumber,
            original_page_number: asset.pageNumber,
            image_data_url: '',
            image_url: annotatedImageUrl,
            annotated_preview_url: annotatedPreviewUrl,
            annotated_storage_path: annotatedStoragePath,
            ...(annotatedGeminiFile
              ? { gemini_file: annotatedGeminiFile }
              : {}),
            annotated_slots: asset.slotBoxes.map((slotBox) => ({
              slot_key: slotBox.slotKey,
              slot_name: slotBox.slotName,
              slot_source: slotBox.slotSource,
              example_annotation_label: slotBox.slotKey,
              example_box_2d: normalizedBboxToGeminiBox2d(slotBox.bbox),
              example_evidence_text: slotBox.exampleEvidenceText,
              example_slot_value: slotBox.exampleSlotValue,
            })),
            example_pdf_file_name: asset.examplePdfFileName,
          } satisfies ReferencePdfVisionPageInput,
          skippedSlotCount: 0,
          downloadFailure: null,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);

        console.warn(
          '[PDF Fill][ReferenceExample] Missing browser-saved annotated reference page image',
          {
            pageNumber: asset.pageNumber,
            annotatedStoragePath,
            sourceStoragePath: asset.storagePath,
            slotCount: asset.slotBoxes.length,
            error: errorMessage,
          },
        );

        return {
          page: null,
          skippedSlotCount: asset.slotBoxes.length,
          downloadFailure: {
            page_number: asset.pageNumber,
            storage_path: annotatedStoragePath,
            slot_count: asset.slotBoxes.length,
            error_message: `Missing browser-saved annotated reference image. ${errorMessage}`,
          },
        };
      }
    },
  );
  const skippedReferencePageDownloads = pageResults.flatMap((result) =>
    result.downloadFailure ? [result.downloadFailure] : [],
  );
  const pages = pageResults.flatMap((result) =>
    result.page ? [result.page] : [],
  );
  skippedSlotsWithoutPageImage += pageResults.reduce(
    (sum, result) => sum + result.skippedSlotCount,
    0,
  );

  return {
    pages,
    skippedSlotsWithoutBbox,
    skippedSlotsWithoutPageImage,
    skippedReferencePageDownloads,
  };
}

async function appendVisionPageImageDebugTraces(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  taskItemId: string;
  visionPages: PdfVisionPageInput[];
  pageImageAssets: ReturnType<typeof normalizePdfPageImageAssets>;
}) {
  const assetsByUploadedPageNumber = new Map(
    params.pageImageAssets.map((asset) => [asset.uploaded_page_number, asset]),
  );

  await appendProcessingTrace(
    params.admin,
    params.taskItemId,
    `[PDF Fill][VisionPageImageOrder] ${JSON.stringify(
      params.visionPages.map((page, index) => {
        const asset = assetsByUploadedPageNumber.get(page.page_number);

        return {
          sequence_index: index + 1,
          uploaded_page_number: page.page_number,
          original_page_number:
            page.original_page_number ??
            asset?.original_page_number ??
            page.page_number,
          storage_path: asset?.storage_path ?? null,
          source: page.gemini_file
            ? 'gemini_file'
            : page.image_url
              ? 'image_url'
              : 'supabase_download',
          has_data_url: Boolean(page.image_data_url),
          has_image_url: Boolean(page.image_url),
          has_gemini_file: Boolean(page.gemini_file),
        };
      }),
    )}`,
  );

  for (const page of params.visionPages) {
    const asset = assetsByUploadedPageNumber.get(page.page_number);

    await appendProcessingTrace(
      params.admin,
      params.taskItemId,
      `[PDF Fill][VisionPageImage] uploaded_page=${page.page_number}, original_page=${
        page.original_page_number ??
        asset?.original_page_number ??
        page.page_number
      }, source=${
        page.gemini_file
          ? 'gemini_file'
          : page.image_url
            ? 'image_url'
            : 'supabase_download'
      }, storage_path=${asset?.storage_path ?? 'none'}`,
    );
  }
}

async function getSharedReferencePagesForSlotFill(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  taskItemId: string;
  taskId: string;
  templateId: string | null;
  pages: ReferencePdfVisionPageInput[];
}) {
  const llmConfig = getLlmRuntimeConfig('vision');

  if (llmConfig.provider !== 'gemini' || params.pages.length === 0) {
    return params.pages;
  }

  const referenceAssets = params.pages.flatMap((page) => {
    const storagePath = page.annotated_storage_path?.trim();

    if (!storagePath) {
      return [];
    }

    return [
      {
        uploaded_page_number: page.page_number,
        original_page_number: page.original_page_number ?? page.page_number,
        storage_path: storagePath,
        content_type: getMimeTypeFromStoragePath(storagePath),
        size: page.gemini_file?.sizeBytes ?? 0,
      } satisfies PdfPageImageAsset,
    ];
  });
  const uploadedReferencePages = await buildStoredPageImageFileApiVisionPages({
    admin: params.admin,
    pageImageAssets: referenceAssets,
    config: llmConfig,
    requestLabel: `slot fill reference ${params.taskItemId}`,
    onTrace: async ({ message }) => {
      await appendProcessingTrace(params.admin, params.taskItemId, message);
    },
  });
  const geminiFileByPageNumber = new Map(
    uploadedReferencePages.flatMap((page) =>
      page.gemini_file ? [[page.page_number, page.gemini_file] as const] : [],
    ),
  );
  const pages = params.pages.map((page) => ({
    ...page,
    image_url: '',
    gemini_file:
      geminiFileByPageNumber.get(page.page_number) ?? page.gemini_file,
  }));

  await appendProcessingTrace(
    params.admin,
    params.taskItemId,
    `[Gemini File API][SharedReferencePages] ${JSON.stringify({
      task_id: params.taskId,
      template_id: params.templateId,
      reference_page_count: pages.length,
      source: 'gemini_file_api',
      pages: pages.map((page) => ({
        page_number: page.page_number,
        annotated_storage_path: page.annotated_storage_path ?? null,
        file_uri: page.gemini_file?.uri ?? null,
        mime_type: page.gemini_file?.mimeType ?? null,
      })),
    })}`,
  );

  /*
  // Previous Gemini path reused the Vercel image proxy references created in
  // loadReferenceExamplePagesWithBbox. Keep that path available for rollback;
  // Gemini now uses File API file_uri values.
  await appendProcessingTrace(
    params.admin,
    params.taskItemId,
    `[Gemini Image Proxy][SharedReferencePages] ${JSON.stringify({
      task_id: params.taskId,
      template_id: params.templateId,
      reference_page_count: params.pages.length,
      source: 'vercel_gemini_image_proxy',
      pages: params.pages.map((page) => ({
        page_number: page.page_number,
        annotated_storage_path: page.annotated_storage_path ?? null,
        file_uri: page.gemini_file?.uri ?? null,
        mime_type: page.gemini_file?.mimeType ?? null,
      })),
    })}`,
  );
  */

  return pages;
}
async function runGenerationTaskItemSlotFill(params: {
  item: GenerationTaskItemRecord;
  actorEmail: string | null;
}) {
  const admin = createSupabaseAdminClient();
  const startedAt = new Date();
  const processStartedAtMs = startedAt.getTime();
  const slotSchema = Array.isArray(params.item.llm_input?.slot_schema)
    ? params.item.llm_input.slot_schema
    : [];
  /*
  // Reserved for the previous precomputed vision-page flow. The current
  // automated flow uses page-preparation's persisted ocr_image_assets.
  const precomputedVisionPages = normalizeVisionPages(
    params.item.llm_input?.vision_pages,
  );
  */
  const allPageImageAssets = normalizePdfPageImageAssets(
    params.item.llm_input?.ocr_image_assets,
  );
  const pageImageAssets =
    filterPdfPageImageAssetsForSlotFill(allPageImageAssets);
  const pipelineStartedAt = params.item.started_at
    ? new Date(params.item.started_at)
    : startedAt;
  const slotFillUsageAccumulator = createLlmUsageAccumulator();
  let slotFillVisionPagesForCleanup: PdfVisionPageInput[] = [];
  let referencePagesForCleanup: ReferencePdfVisionPageInput[] = [];
  try {
    if (slotSchema.length === 0) {
      throw new Error('当前模板缺少槽位定义，请重新保存模板后再试。');
    }

    if (pageImageAssets.length === 0) {
      throw new Error(
        '当前任务缺少可用于视觉回填的新 PDF 页面图片，请重新创建批量任务。',
      );
    }

    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][SlotFillPreflight] ${JSON.stringify({
        document_name: params.item.source_pdf_name,
        slot_count: slotSchema.length,
        confirmed_slot_fill_page_numbers:
          params.item.llm_input?.confirmed_slot_fill_page_numbers ?? null,
        used_page_image_assets: pageImageAssets.map((asset) => ({
          uploaded_page_number: asset.uploaded_page_number,
          original_page_number: asset.original_page_number,
          storage_path: asset.storage_path,
          used_for_slot_fill: asset.used_for_slot_fill ?? true,
        })),
        ignored_page_image_assets: allPageImageAssets
          .filter((asset) => asset.used_for_slot_fill === false)
          .map((asset) => ({
            uploaded_page_number: asset.uploaded_page_number,
            original_page_number: asset.original_page_number,
            storage_path: asset.storage_path,
          })),
      })}`,
    );
    await appendMemoryTrace(admin, params.item.id, 'slot_fill_route_started', {
      source_pdf_name: params.item.source_pdf_name,
      page_image_asset_count: pageImageAssets.length,
      slot_count: slotSchema.length,
    });

    const llmConfig = getLlmRuntimeConfig('vision');
    const usesGeminiFileApi =
      llmConfig.provider === 'gemini' && pageImageAssets.length > 0;
    const usesSupabaseSignedUrls =
      llmConfig.provider === 'doubao' && pageImageAssets.length > 0;
    let visionPages: PdfVisionPageInput[];

    if (usesGeminiFileApi) {
      visionPages = await buildStoredPageImageFileApiVisionPages({
        admin,
        pageImageAssets,
        config: llmConfig,
        requestLabel: `slot fill ${params.item.id}`,
        onTrace: async ({ message }) => {
          await appendProcessingTrace(admin, params.item.id, message);
        },
      });
    } else if (usesSupabaseSignedUrls) {
      /*
      // Previous Doubao path used Vercel image proxy URLs here. Keep the proxy
      // helper available for rollback/comparison; Doubao now uses Supabase
      // signed URLs directly.
      visionPages = await buildStoredPageImageProxyVisionPages({
        pageImageAssets,
        requestLabel: `slot fill ${params.item.id}`,
        onTrace: async ({ message }) => {
          await appendProcessingTrace(admin, params.item.id, message);
        },
      });
      */
      visionPages = await buildStoredPageImageSupabaseSignedUrlVisionPages({
        admin,
        pageImageAssets,
        requestLabel: `slot fill ${params.item.id}`,
        onTrace: async ({ message }) => {
          await appendProcessingTrace(admin, params.item.id, message);
        },
      });
    } else {
      visionPages = await loadVisionPagesFromStoredAssets({
        admin,
        pageImageAssets,
      });
    }
    slotFillVisionPagesForCleanup = visionPages;

    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][SlotFillImageSource] ${JSON.stringify({
        provider: llmConfig.provider,
        gemini_file_api_page_count: usesGeminiFileApi ? visionPages.length : 0,
        supabase_signed_url_page_count: usesSupabaseSignedUrls
          ? visionPages.length
          : 0,
        fallback_to_supabase_download:
          !usesGeminiFileApi && !usesSupabaseSignedUrls,
        required_page_count: pageImageAssets.length,
      })}`,
    );

    if (visionPages.length === 0) {
      throw new Error('当前任务没有可读取的新 PDF 页面图片。');
    }

    await appendMemoryTrace(admin, params.item.id, 'vision_page_urls_ready', {
      vision_page_count: visionPages.length,
      source: usesGeminiFileApi
        ? 'gemini_file_api'
        : usesSupabaseSignedUrls
          ? 'supabase_signed_url'
          : 'data_url',
    });

    const referenceExamplePages = await loadReferenceExamplePagesWithBbox({
      admin,
      taskItemId: params.item.id,
      ownerId: params.item.owner_id,
      templateId: params.item.template_id,
      slots: slotSchema,
    });
    const referencePagesForSlotFill = await getSharedReferencePagesForSlotFill({
      admin,
      taskItemId: params.item.id,
      taskId: params.item.task_id,
      templateId: params.item.template_id,
      pages: referenceExamplePages.pages,
    });
    referencePagesForCleanup = referencePagesForSlotFill;
    await appendMemoryTrace(
      admin,
      params.item.id,
      'reference_page_urls_ready',
      {
        reference_page_count: referencePagesForSlotFill.length,
      },
    );

    await admin
      .from('generation_task_items')
      .update({
        status: 'slot_filling',
        error_message: null,
        started_at: pipelineStartedAt.toISOString(),
        finished_at: null,
        updated_at: startedAt.toISOString(),
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
        slot_fill_llm_usage: null,
      })
      .eq('id', params.item.id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `槽位回填路由：/api/generation-task-items/${params.item.id}/slot-fill`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `即将开始 VISION_LLM 视觉槽位回填：PDF=${params.item.source_pdf_name}，槽位数=${slotSchema.length}，页面图片=${visionPages.length}。`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      '槽位回填阶段：直接使用槽位来源、示例 PDF 定位信息和新 PDF 页面图片调用 VISION_LLM。',
    );

    await appendVisionPageImageDebugTraces({
      admin,
      taskItemId: params.item.id,
      visionPages,
      pageImageAssets,
    });
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][VisionPagesUsed] ${JSON.stringify({
        document_name: params.item.source_pdf_name,
        confirmed_slot_fill_page_numbers:
          params.item.llm_input?.confirmed_slot_fill_page_numbers ?? null,
        used_page_numbers: visionPages.map((page) => page.page_number),
        all_uploaded_page_numbers: allPageImageAssets.map(
          (asset) => asset.uploaded_page_number,
        ),
        ignored_page_numbers: allPageImageAssets
          .filter((asset) => asset.used_for_slot_fill === false)
          .map((asset) => asset.uploaded_page_number),
      })}`,
    );

    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][ReferenceExample] Using ${referencePagesForSlotFill.length} example PDF page image(s) with bbox for slot fill; skipped ${referenceExamplePages.skippedSlotsWithoutBbox} slot(s) without bbox, ${referenceExamplePages.skippedSlotsWithoutPageImage} slot(s) without readable stored example page image, and ${referenceExamplePages.skippedReferencePageDownloads.length} missing reference page object(s).`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][ReferenceExampleImages] ${JSON.stringify({
        document_name: params.item.source_pdf_name,
        skipped_reference_page_downloads:
          referenceExamplePages.skippedReferencePageDownloads,
        pages: referencePagesForSlotFill.map((page) => ({
          example_pdf_file_name: page.example_pdf_file_name ?? null,
          page_number: page.page_number,
          original_page_number: page.original_page_number ?? page.page_number,
          annotated_preview_url: page.annotated_preview_url ?? null,
          annotated_storage_path: page.annotated_storage_path ?? null,
          has_gemini_file: Boolean(page.gemini_file),
          gemini_file_name: page.gemini_file?.name ?? null,
          gemini_file_uri: page.gemini_file?.uri ?? null,
          annotated_slots: page.annotated_slots ?? [],
        })),
      })}`,
    );
    for (const downloadFailure of referenceExamplePages.skippedReferencePageDownloads) {
      await appendProcessingTrace(
        admin,
        params.item.id,
        `[PDF Fill][ReferenceExampleMissing] ${JSON.stringify({
          document_name: params.item.source_pdf_name,
          page_number: downloadFailure.page_number,
          storage_path: downloadFailure.storage_path,
          slot_count: downloadFailure.slot_count,
          error_message: downloadFailure.error_message,
        })}`,
      );
    }

    console.log('[Generation Task Item] Direct visual slot fill starting', {
      taskItemId: params.item.id,
      taskId: params.item.task_id,
      sourcePdfName: params.item.source_pdf_name,
      slotCount: slotSchema.length,
      visionPageCount: visionPages.length,
      referenceExamplePageCount: referencePagesForSlotFill.length,
    });

    let lastLoggedCompletedSlots = -1;
    const runDirectVisionSlotFill = async (input: {
      runVisionPages: PdfVisionPageInput[];
      runReferencePages: ReferencePdfVisionPageInput[];
    }) =>
      fillSlotsFromVisionPages({
        pdfFileName: params.item.source_pdf_name,
        slots: slotSchema,
        visionPages: input.runVisionPages,
        referenceExamplePages: input.runReferencePages,
        processStartedAtMs,
        processHardTimeoutMs: PROCESS_HARD_TIMEOUT_MS,
        usageAccumulator: slotFillUsageAccumulator,
        onTrace: async ({ message }) => {
          await appendProcessingTrace(admin, params.item.id, message);
        },
        onProgress: async ({ completedSlots, totalSlots }) => {
          await updateSlotProgress(admin, params.item.id, {
            completedSlots,
            totalSlots,
          });

          if (
            completedSlots === totalSlots ||
            completedSlots === 0 ||
            completedSlots !== lastLoggedCompletedSlots
          ) {
            lastLoggedCompletedSlots = completedSlots;
            await appendProcessingTrace(
              admin,
              params.item.id,
              `槽位回填进度：已完成 ${completedSlots}/${totalSlots}，待抽取 ${Math.max(0, totalSlots - completedSlots)}。`,
            );

            await logEvent({
              ownerId: params.item.owner_id,
              actorEmail: params.actorEmail,
              level: 'info',
              eventType: 'generation_task_item_progress',
              message: `Generation task item progressed to ${completedSlots}/${totalSlots} filled slots.`,
              route: '/api/generation-task-items/[taskItemId]/slot-fill',
              templateId: params.item.template_id,
              taskId: params.item.task_id,
              taskItemId: params.item.id,
              payload: {
                completedSlots,
                totalSlots,
                pendingSlots: Math.max(0, totalSlots - completedSlots),
              },
            });
          }
        },
      });

    const llmOutput = await runDirectVisionSlotFill({
      runVisionPages: visionPages,
      runReferencePages: referencePagesForSlotFill,
    });

    await appendMemoryTrace(admin, params.item.id, 'vision_slot_fill_done', {
      extracted_item_count: llmOutput.extracted_items.length,
    });

    const finishedAt = new Date();
    const elapsedSeconds = Math.max(
      1,
      Math.round((finishedAt.getTime() - pipelineStartedAt.getTime()) / 1000),
    );
    const completedSlots = llmOutput.extracted_items.filter((item) =>
      Boolean(item.original_value.trim()),
    ).length;

    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][SlotFillOutput] ${JSON.stringify({
        document_name: params.item.source_pdf_name,
        task_item_id: params.item.id,
        slot_count: slotSchema.length,
        completed_slot_count: completedSlots,
        extracted_items: llmOutput.extracted_items,
      })}`,
    );

    const visionTraceConfig = getLlmRuntimeTraceConfig('vision');
    const slotFillLlmUsage = summarizeLlmUsage(slotFillUsageAccumulator, {
      provider: visionTraceConfig.provider,
      model: visionTraceConfig.model,
      modelEnvName: visionTraceConfig.modelEnvName,
    });
    const { error: updateError } = await admin
      .from('generation_task_items')
      .update({
        status: 'review_pending',
        elapsed_seconds: elapsedSeconds,
        llm_output: llmOutput,
        slot_fill_llm_usage: slotFillLlmUsage,
        slot_total_count: slotSchema.length,
        slot_completed_count: completedSlots,
        finished_at: finishedAt.toISOString(),
      })
      .eq('id', params.item.id);

    if (updateError) {
      throw updateError;
    }
    await appendMemoryTrace(admin, params.item.id, 'slot_fill_persisted', {
      completed_slot_count: completedSlots,
      slot_count: slotSchema.length,
    });

    await recalculateTaskSummary(admin, params.item.task_id);
    await appendProcessingTrace(
      admin,
      params.item.id,
      `槽位回填完成，用时 ${elapsedSeconds} 秒；已回填 ${completedSlots}/${slotSchema.length} 个槽位。`,
    );

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'info',
      eventType: 'generation_task_item_processed',
      message: 'Generation task item processed successfully.',
      route: '/api/generation-task-items/[taskItemId]/slot-fill',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: {
        sourcePdfName: params.item.source_pdf_name,
        elapsedSeconds,
        slotCount: slotSchema.length,
        completedSlots,
        pendingSlots: Math.max(0, slotSchema.length - completedSlots),
        visionPageCount: visionPages.length,
      },
    });
  } catch (error) {
    const fallbackReviewPayload = buildFallbackReviewPayload(slotSchema);
    const visionTraceConfig = getLlmRuntimeTraceConfig('vision');
    const slotFillLlmUsage = summarizeLlmUsage(slotFillUsageAccumulator, {
      provider: visionTraceConfig.provider,
      model: visionTraceConfig.model,
      modelEnvName: visionTraceConfig.modelEnvName,
    });

    await admin
      .from('generation_task_items')
      .update({
        status: 'review_pending',
        error_message: null,
        llm_output: fallbackReviewPayload,
        slot_fill_llm_usage: slotFillLlmUsage,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
        finished_at: new Date().toISOString(),
      })
      .eq('id', params.item.id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `模型自动回填失败，已转为人工核查：${getErrorMessage(error)}`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][RawError][SlotFill] ${getErrorMessage(error)}`,
    );
    await appendMemoryTrace(admin, params.item.id, 'route_failed', {
      error_message: getErrorMessage(error),
      source_pdf_name: params.item.source_pdf_name,
      slot_count: slotSchema.length,
      vision_page_count: pageImageAssets.length,
      page_image_asset_count: pageImageAssets.length,
    });
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[RouteErrorDetails][SlotFill] ${JSON.stringify(
        buildErrorLogPayload(error, {
          sourcePdfName: params.item.source_pdf_name,
          slotCount: slotSchema.length,
          visionPageCount: pageImageAssets.length,
          pageImageAssetCount: pageImageAssets.length,
          usedPageImageAssets: pageImageAssets.map((asset) => ({
            uploaded_page_number: asset.uploaded_page_number,
            original_page_number: asset.original_page_number,
            storage_path: asset.storage_path,
            used_for_slot_fill: asset.used_for_slot_fill ?? true,
          })),
          ignoredPageImageAssets: allPageImageAssets
            .filter((asset) => asset.used_for_slot_fill === false)
            .map((asset) => ({
              uploaded_page_number: asset.uploaded_page_number,
              original_page_number: asset.original_page_number,
              storage_path: asset.storage_path,
            })),
        }),
      )}`,
    );

    await recalculateTaskSummary(admin, params.item.task_id);

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'error',
      eventType: 'generation_task_item_slot_fill_failed',
      message: getErrorMessage(error),
      route: '/api/generation-task-items/[taskItemId]/slot-fill',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: buildErrorLogPayload(error, {
        sourcePdfName: params.item.source_pdf_name,
        slotCount: slotSchema.length,
        visionPageCount: pageImageAssets.length,
        pageImageAssetCount: pageImageAssets.length,
        usedPageImageAssets: pageImageAssets.map((asset) => ({
          uploaded_page_number: asset.uploaded_page_number,
          original_page_number: asset.original_page_number,
          storage_path: asset.storage_path,
          used_for_slot_fill: asset.used_for_slot_fill ?? true,
        })),
        ignoredPageImageAssets: allPageImageAssets
          .filter((asset) => asset.used_for_slot_fill === false)
          .map((asset) => ({
            uploaded_page_number: asset.uploaded_page_number,
            original_page_number: asset.original_page_number,
            storage_path: asset.storage_path,
          })),
      }),
    });
  } finally {
    const cleanupConfig = getLlmRuntimeConfig('vision');

    if (cleanupConfig.provider === 'gemini') {
      await cleanupGeminiFileApiFilesForTrace({
        config: cleanupConfig,
        files: [
          ...collectGeminiFileApiFilesFromAssets(allPageImageAssets),
          ...collectGeminiFileApiFilesFromVisionPages(
            slotFillVisionPagesForCleanup,
          ),
          ...collectGeminiFileApiFilesFromVisionPages(referencePagesForCleanup),
        ],
        requestLabel: `slot fill ${params.item.id}`,
        onTrace: async ({ message }) => {
          await appendProcessingTrace(admin, params.item.id, message);
        },
      });
    }
  }
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

    if (['review_pending', 'reviewed', 'succeeded'].includes(item.status)) {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    if (item.status === 'slot_filling') {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    if (item.status !== 'pdf_pages_ready') {
      return NextResponse.json(
        {
          code: 'GENERATION_TASK_ITEM_PDF_PAGES_NOT_READY',
          message:
            '当前任务的新 PDF 页面图片尚未准备完成，暂时不能开始槽位回填。',
        },
        { status: 409 },
      );
    }

    let nextItem = item;

    /*
    // Reserved for the previous manual page-confirmation flow. The current
    // automated flow uses page-preparation's persisted used_for_slot_fill flags.
    const rawBody = await request.json().catch(() => null);
    const confirmedPageNumbers = normalizeConfirmedPageNumbers(
      rawBody && typeof rawBody === 'object'
        ? (rawBody as { confirmedPageNumbers?: unknown }).confirmedPageNumbers
        : null,
    );

    if (confirmedPageNumbers) {
      if (confirmedPageNumbers.length === 0) {
        return NextResponse.json(
          {
            code: 'GENERATION_TASK_ITEM_NO_CONFIRMED_PAGES',
            message: '请至少选择一页用于槽位回填。',
          },
          { status: 400 },
        );
      }

      const confirmedPageNumberSet = new Set(confirmedPageNumbers);
      const currentPageImageAssets = normalizePdfPageImageAssets(
        item.llm_input?.ocr_image_assets,
      );
      const nextPageImageAssets = currentPageImageAssets.map((asset) => ({
        ...asset,
        used_for_slot_fill: confirmedPageNumberSet.has(
          asset.uploaded_page_number,
        ),
      }));

      if (
        nextPageImageAssets.filter(
          (asset) => asset.used_for_slot_fill !== false,
        ).length === 0
      ) {
        return NextResponse.json(
          {
            code: 'GENERATION_TASK_ITEM_NO_CONFIRMED_PAGES',
            message: '请至少选择一页用于槽位回填。',
          },
          { status: 400 },
        );
      }

      const nextLlmInput = {
        ...(item.llm_input ?? {}),
        ocr_image_assets: nextPageImageAssets,
        confirmed_slot_fill_page_numbers: confirmedPageNumbers,
      };

      const { data: persistedItem, error: persistError } = await admin
        .from('generation_task_items')
        .update({
          llm_input: nextLlmInput,
        })
        .eq('id', item.id)
        .select(generationTaskItemSelect)
        .single<GenerationTaskItemRecord>();

      if (persistError || !persistedItem) {
        throw (
          persistError ?? new Error('Failed to persist confirmed page list.')
        );
      }

      nextItem = persistedItem;

      await appendProcessingTrace(
        admin,
        item.id,
        `[PDF Fill][ConfirmedPages] ${JSON.stringify({
          source: 'user',
          confirmed_page_numbers: confirmedPageNumbers,
          selected_page_count: confirmedPageNumbers.length,
          all_uploaded_page_numbers: currentPageImageAssets.map(
            (asset) => asset.uploaded_page_number,
          ),
          ignored_page_numbers: currentPageImageAssets
            .filter(
              (asset) =>
                !confirmedPageNumberSet.has(asset.uploaded_page_number),
            )
            .map((asset) => asset.uploaded_page_number),
        })}`,
      );
    }
    */

    after(async () => {
      await runGenerationTaskItemSlotFill({
        item: nextItem,
        actorEmail: user.email ?? null,
      });
    });

    const phaseStartedAt = new Date().toISOString();

    return NextResponse.json(
      {
        data: {
          item: {
            ...nextItem,
            status: 'slot_filling',
            error_message: null,
            updated_at: phaseStartedAt,
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
      eventType: 'generation_task_item_slot_fill_request_failed',
      message,
      route: '/api/generation-task-items/[taskItemId]/slot-fill',
      taskItemId,
      payload: buildErrorLogPayload(error),
    });

    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_SLOT_FILL_FAILED',
        message,
      },
      { status: 500 },
    );
  }
}
