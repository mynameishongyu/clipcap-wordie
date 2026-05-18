import { after, NextResponse } from 'next/server';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  fillSlotsFromVisionPages,
  type GenerationSlotSchemaItem,
  type PdfVisionPageInput,
  normalizedBboxToGeminiBox2d,
  type ReferencePdfVisionPageInput,
} from '@/src/lib/llm/fill-template-from-pdf';
import {
  cleanupGeminiUploadedFiles,
  getGeminiFilePipelineConcurrency,
  uploadGeminiFilesToFileApi,
  type UploadedGeminiFile,
} from '@/src/lib/llm/gemini-file-api';
import { getLlmRuntimeConfig } from '@/src/lib/llm/provider';
import {
  appendProcessingTrace,
  buildFallbackReviewPayload,
  createUnauthorizedResponse,
  generationTaskItemSelect,
  type GenerationTaskItemRecord,
  getErrorMessage,
  filterPdfPageImageAssetsForSlotFill,
  loadVisionPagesFromStoredAssets,
  normalizePdfPageImageAssets,
  normalizeVisionPages,
  recalculateTaskSummary,
  updateSlotProgress,
  uploadStoredPageImagesToGeminiFileApi,
} from '@/src/lib/generation-task-items/runtime';
import { buildErrorLogPayload, logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

const PROCESS_HARD_TIMEOUT_MS = maxDuration * 1000;
const SLOT_REFERENCE_LABEL_FONT_FAMILY = 'ClipCapSlotReferenceLabel';
const SLOT_REFERENCE_LABEL_FONT_PATH = join(
  process.cwd(),
  'src',
  'assets',
  'fonts',
  'NotoSans-Regular.ttf',
);

let hasAttemptedSlotReferenceFontRegistration = false;
let hasRegisteredSlotReferenceFont = false;

function normalizeConfirmedPageNumbers(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  return Array.from(
    new Set(
      value
        .map((pageNumber) =>
          typeof pageNumber === 'number'
            ? pageNumber
            : typeof pageNumber === 'string'
              ? Number.parseInt(pageNumber, 10)
              : NaN,
        )
        .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber > 0),
    ),
  ).sort((left, right) => left - right);
}

function getSlotReferenceLabelFontFamily() {
  if (!hasAttemptedSlotReferenceFontRegistration) {
    hasAttemptedSlotReferenceFontRegistration = true;

    if (existsSync(SLOT_REFERENCE_LABEL_FONT_PATH)) {
      try {
        GlobalFonts.registerFromPath(
          SLOT_REFERENCE_LABEL_FONT_PATH,
          SLOT_REFERENCE_LABEL_FONT_FAMILY,
        );
        hasRegisteredSlotReferenceFont = true;
      } catch {
        hasRegisteredSlotReferenceFont = false;
      }
    }
  }

  return hasRegisteredSlotReferenceFont
    ? `"${SLOT_REFERENCE_LABEL_FONT_FAMILY}"`
    : 'Arial, sans-serif';
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

function getReferenceBboxGroupKey(bbox: ReferenceSlotBox['bbox']) {
  return [bbox.x, bbox.y, bbox.width, bbox.height]
    .map((value) => Number(value).toFixed(6))
    .join(':');
}

function groupReferenceSlotBoxesByBbox(slotBoxes: ReferenceSlotBox[]) {
  const groups = new Map<
    string,
    {
      bbox: ReferenceSlotBox['bbox'];
      slotBoxes: ReferenceSlotBox[];
    }
  >();

  for (const slotBox of slotBoxes) {
    const key = getReferenceBboxGroupKey(slotBox.bbox);
    const group =
      groups.get(key) ??
      ({
        bbox: slotBox.bbox,
        slotBoxes: [],
      } satisfies {
        bbox: ReferenceSlotBox['bbox'];
        slotBoxes: ReferenceSlotBox[];
      });

    group.slotBoxes.push(slotBox);
    groups.set(key, group);
  }

  return [...groups.values()];
}

function countDuplicateReferenceBboxGroups(slotBoxes: ReferenceSlotBox[]) {
  return groupReferenceSlotBoxesByBbox(slotBoxes).filter(
    (group) => group.slotBoxes.length > 1,
  ).length;
}

async function buildAnnotatedReferencePageDataUrl(params: {
  imageBuffer: Buffer;
  slotBoxes: ReferenceSlotBox[];
}) {
  const image = await loadImage(params.imageBuffer);
  const width = image.width;
  const height = image.height;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const lineWidth = Math.max(2, Math.round(Math.min(width, height) * 0.0015));
  const labelFontSize = Math.max(
    10,
    Math.round(Math.min(width, height) * 0.006),
  );
  const labelPaddingX = Math.max(4, Math.round(labelFontSize * 0.28));
  const labelPaddingY = Math.max(2, Math.round(labelFontSize * 0.18));

  context.drawImage(image, 0, 0, width, height);
  context.font = `${labelFontSize}px ${getSlotReferenceLabelFontFamily()}`;
  context.textBaseline = 'top';

  groupReferenceSlotBoxesByBbox(params.slotBoxes).forEach((bboxGroup) => {
    const { bbox } = bboxGroup;
    const left = Math.max(0, Math.min(width, bbox.x * width));
    const top = Math.max(0, Math.min(height, bbox.y * height));
    const boxWidth = Math.max(
      1,
      Math.min(width - left, bbox.width * width),
    );
    const boxHeight = Math.max(
      1,
      Math.min(height - top, bbox.height * height),
    );

    context.fillStyle = 'rgba(255, 153, 0, 0.08)';
    context.fillRect(left, top, boxWidth, boxHeight);
    context.strokeStyle = '#ff9900';
    context.lineWidth = lineWidth;
    context.strokeRect(left, top, boxWidth, boxHeight);

    const labels = bboxGroup.slotBoxes.map((slotBox) => slotBox.slotKey);
    const measuredWidth = Math.max(
      ...labels.map((label) => context.measureText(label).width),
    );
    const labelLineHeight = Math.ceil(labelFontSize * 1.14);
    const labelWidth = Math.ceil(measuredWidth) + labelPaddingX * 2;
    const labelHeight = labels.length * labelLineHeight + labelPaddingY * 2;
    const labelLeft = Math.max(
      0,
      Math.min(width - labelWidth, left - lineWidth),
    );
    const labelTop = Math.max(
      0,
      Math.min(height - labelHeight, top - labelHeight - lineWidth),
    );

    context.fillStyle = 'rgba(255, 153, 0, 0.92)';
    context.fillRect(labelLeft, labelTop, labelWidth, labelHeight);
    context.fillStyle = '#111111';
    labels.forEach((label, labelIndex) => {
      context.fillText(
        label,
        labelLeft + labelPaddingX,
        labelTop + labelPaddingY + labelIndex * labelLineHeight,
      );
    });
  });

  const annotatedBuffer = canvas.toBuffer('image/png');

  return {
    dataUrl: `data:image/png;base64,${annotatedBuffer.toString('base64')}`,
    buffer: annotatedBuffer,
  };
}

function bufferToImageDataUrl(buffer: Buffer, mimeType: string) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function buildReferenceAnnotationStoragePath(params: {
  ownerId: string;
  taskItemId: string;
  templateId?: string | null;
  pageNumber: number;
}) {
  if (!params.templateId) {
    return `${params.ownerId}/template-reference-pages/annotated/task/${params.taskItemId}/page-${params.pageNumber}.png`;
  }

  return `${params.ownerId}/template-reference-pages/annotated/${params.templateId}/page-${params.pageNumber}.png`;
}

async function createReferenceAnnotationSignedUrl(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  storagePath: string;
}) {
  const { data, error } = await params.admin.storage
    .from('generation-pdfs')
    .createSignedUrl(params.storagePath, 60 * 60 * 24);

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
        results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
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
    getGeminiFilePipelineConcurrency(),
    async (asset) => {
        const annotatedStoragePath = buildReferenceAnnotationStoragePath({
          ownerId: params.ownerId,
          taskItemId: params.taskItemId,
          templateId: params.templateId,
          pageNumber: asset.pageNumber,
        });
        const duplicateBboxGroupCount = countDuplicateReferenceBboxGroups(
          asset.slotBoxes,
        );
        let cachedAnnotatedImageDataUrl: string | undefined;
        let cachedAnnotatedPreviewUrl: string | undefined;

        if (params.templateId && duplicateBboxGroupCount === 0) {
          const { data: cachedBlob } = await params.admin.storage
            .from('generation-pdfs')
            .download(annotatedStoragePath);

          if (cachedBlob) {
            const cachedBuffer = Buffer.from(await cachedBlob.arrayBuffer());
            const cachedMimeType =
              cachedBlob.type ||
              getMimeTypeFromStoragePath(annotatedStoragePath) ||
              'image/png';

            cachedAnnotatedImageDataUrl = bufferToImageDataUrl(
              cachedBuffer,
              cachedMimeType,
            );

            try {
              cachedAnnotatedPreviewUrl =
                await createReferenceAnnotationSignedUrl({
                  admin: params.admin,
                  storagePath: annotatedStoragePath,
                });
            } catch (error) {
              console.warn(
                '[PDF Fill][ReferenceExample] Failed to sign cached annotated reference page image',
                {
                  pageNumber: asset.pageNumber,
                  annotatedStoragePath,
                  error,
                },
              );
            }

            console.info(
              '[PDF Fill][ReferenceExample] Reusing cached annotated reference page image',
              {
                pageNumber: asset.pageNumber,
                annotatedStoragePath,
                slotCount: asset.slotBoxes.length,
                duplicateBboxGroupCount,
              },
            );

            return {
              page: {
                page_number: asset.pageNumber,
                original_page_number: asset.pageNumber,
                image_data_url: cachedAnnotatedImageDataUrl,
                annotated_image_data_url: cachedAnnotatedImageDataUrl,
                ...(cachedAnnotatedPreviewUrl
                  ? { annotated_preview_url: cachedAnnotatedPreviewUrl }
                  : {}),
                annotated_storage_path: annotatedStoragePath,
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
          }
        } else if (params.templateId && duplicateBboxGroupCount > 0) {
          console.info(
            '[PDF Fill][ReferenceExample] Regenerating annotated reference page image because multiple slot keys share bbox',
            {
              pageNumber: asset.pageNumber,
              annotatedStoragePath,
              slotCount: asset.slotBoxes.length,
              duplicateBboxGroupCount,
            },
          );
        }

        const { data: fileBlob, error } = await params.admin.storage
          .from('generation-pdfs')
          .download(asset.storagePath);

        if (error || !fileBlob) {
          const errorMessage = error?.message ?? 'Missing storage object';

          console.warn(
            '[PDF Fill][ReferenceExample] Skipping missing reference page image',
            {
              pageNumber: asset.pageNumber,
              storagePath: asset.storagePath,
              slotCount: asset.slotBoxes.length,
              error: errorMessage,
            },
          );

          return {
            page: null,
            skippedSlotCount: asset.slotBoxes.length,
            downloadFailure: {
              page_number: asset.pageNumber,
              storage_path: asset.storagePath,
              slot_count: asset.slotBoxes.length,
              error_message: errorMessage,
            },
          };
        }

        const buffer = Buffer.from(await fileBlob.arrayBuffer());
        const mimeType =
          fileBlob.type || getMimeTypeFromStoragePath(asset.storagePath);
        const imageDataUrl = bufferToImageDataUrl(buffer, mimeType);
        let annotatedImageDataUrl: string | undefined;
        let annotatedPreviewUrl: string | undefined;
        let uploadedAnnotatedStoragePath: string | undefined;

        try {
          const annotatedImage = await buildAnnotatedReferencePageDataUrl({
            imageBuffer: buffer,
            slotBoxes: asset.slotBoxes,
          });
          annotatedImageDataUrl = annotatedImage.dataUrl;
          uploadedAnnotatedStoragePath = annotatedStoragePath;

          const { error: uploadError } = await params.admin.storage
            .from('generation-pdfs')
            .upload(uploadedAnnotatedStoragePath, annotatedImage.buffer, {
              contentType: 'image/png',
              upsert: true,
            });

          if (uploadError) {
            throw uploadError;
          }

          annotatedPreviewUrl = await createReferenceAnnotationSignedUrl({
            admin: params.admin,
            storagePath: uploadedAnnotatedStoragePath,
          });

          if (params.templateId) {
            console.info(
              '[PDF Fill][ReferenceExample] Cached annotated reference page image',
              {
                pageNumber: asset.pageNumber,
                annotatedStoragePath: uploadedAnnotatedStoragePath,
                slotCount: asset.slotBoxes.length,
                duplicateBboxGroupCount,
              },
            );
          }
        } catch (error) {
          annotatedPreviewUrl = undefined;
          uploadedAnnotatedStoragePath = undefined;
          console.warn(
            '[PDF Fill][ReferenceExample] Failed to annotate reference page image',
            {
              pageNumber: asset.pageNumber,
              storagePath: asset.storagePath,
              error,
            },
          );
        }

        return {
          page: {
            page_number: asset.pageNumber,
            original_page_number: asset.pageNumber,
            image_data_url: imageDataUrl,
            ...(annotatedImageDataUrl
              ? { annotated_image_data_url: annotatedImageDataUrl }
              : {}),
            ...(annotatedPreviewUrl
              ? { annotated_preview_url: annotatedPreviewUrl }
              : {}),
            ...(uploadedAnnotatedStoragePath
              ? { annotated_storage_path: uploadedAnnotatedStoragePath }
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
  visionPages: ReturnType<typeof normalizeVisionPages>;
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
          source: page.gemini_file ? 'gemini_file' : 'supabase_download',
          has_data_url: Boolean(page.image_data_url),
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
      }, source=${page.gemini_file ? 'gemini_file' : 'supabase_download'}, storage_path=${
        asset?.storage_path ?? 'none'
      }`,
    );
  }
}

function normalizeCachedGeminiFile(value: unknown): UploadedGeminiFile | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const uri = typeof record.uri === 'string' ? record.uri.trim() : '';
  const mimeType =
    typeof record.mime_type === 'string'
      ? record.mime_type
      : typeof record.mimeType === 'string'
        ? record.mimeType
        : '';

  if (!uri || !mimeType) {
    return null;
  }

  return {
    uri,
    name: typeof record.name === 'string' ? record.name : undefined,
    mimeType,
    sizeBytes:
      typeof record.size_bytes === 'number'
        ? record.size_bytes
        : typeof record.sizeBytes === 'number'
          ? record.sizeBytes
          : 0,
    displayName:
      typeof record.display_name === 'string'
        ? record.display_name
        : typeof record.displayName === 'string'
          ? record.displayName
          : 'cached-page-filter-image',
  };
}

function buildVisionPagesFromCachedGeminiFiles(
  pageImageAssets: ReturnType<typeof normalizePdfPageImageAssets>,
): PdfVisionPageInput[] {
  return pageImageAssets.flatMap((asset) => {
    const geminiFile = normalizeCachedGeminiFile(asset.gemini_file);

    if (!geminiFile) {
      return [];
    }

    return [
      {
        page_number: asset.uploaded_page_number,
        image_data_url: '',
        original_page_number: asset.original_page_number,
        gemini_file: geminiFile,
      },
    ];
  });
}

function collectCachedGeminiFilesForCleanup(
  pageImageAssets: ReturnType<typeof normalizePdfPageImageAssets>,
) {
  const filesByNameOrUri = new Map<string, UploadedGeminiFile>();

  pageImageAssets.forEach((asset) => {
    const geminiFile = normalizeCachedGeminiFile(asset.gemini_file);

    if (!geminiFile) {
      return;
    }

    filesByNameOrUri.set(geminiFile.name ?? geminiFile.uri, geminiFile);
  });

  return Array.from(filesByNameOrUri.values());
}

type SharedReferenceGeminiFileEntry = {
  page_number: number;
  original_page_number?: number | null;
  annotated_storage_path?: string | null;
  annotated_preview_url?: string | null;
  file: {
    uri: string;
    name?: string | null;
    mime_type: string;
    size_bytes?: number | null;
    display_name?: string | null;
  };
};

type SharedReferenceGeminiCache = {
  task_id: string;
  template_id?: string | null;
  created_at: string;
  files: SharedReferenceGeminiFileEntry[];
};

function normalizeSharedReferenceGeminiCache(
  value: unknown,
): SharedReferenceGeminiCache | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const filesValue = record.files;

  if (!Array.isArray(filesValue)) {
    return null;
  }

  const files = filesValue.flatMap((entry): SharedReferenceGeminiFileEntry[] => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const entryRecord = entry as Record<string, unknown>;
    const pageNumber = Number(entryRecord.page_number);
    const file = normalizeCachedGeminiFile(entryRecord.file);

    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !file) {
      return [];
    }

    return [
      {
        page_number: pageNumber,
        original_page_number:
          typeof entryRecord.original_page_number === 'number'
            ? entryRecord.original_page_number
            : null,
        annotated_storage_path:
          typeof entryRecord.annotated_storage_path === 'string'
            ? entryRecord.annotated_storage_path
            : null,
        annotated_preview_url:
          typeof entryRecord.annotated_preview_url === 'string'
            ? entryRecord.annotated_preview_url
            : null,
        file: {
          uri: file.uri,
          name: file.name ?? null,
          mime_type: file.mimeType,
          size_bytes: file.sizeBytes,
          display_name: file.displayName,
        },
      },
    ];
  });

  if (files.length === 0) {
    return null;
  }

  return {
    task_id: typeof record.task_id === 'string' ? record.task_id : '',
    template_id:
      typeof record.template_id === 'string' ? record.template_id : null,
    created_at:
      typeof record.created_at === 'string'
        ? record.created_at
        : new Date().toISOString(),
    files,
  };
}

function attachSharedReferenceGeminiFiles(
  pages: ReferencePdfVisionPageInput[],
  cache: SharedReferenceGeminiCache | null,
) {
  if (!cache) {
    return pages;
  }

  const fileByPageNumber = new Map(
    cache.files.map((entry) => [entry.page_number, entry]),
  );
  const fileByStoragePath = new Map(
    cache.files.flatMap((entry) =>
      entry.annotated_storage_path
        ? [[entry.annotated_storage_path, entry] as const]
        : [],
    ),
  );

  return pages.map((page) => {
    const entry =
      (page.annotated_storage_path
        ? fileByStoragePath.get(page.annotated_storage_path)
        : null) ?? fileByPageNumber.get(page.page_number);

    if (!entry) {
      return page;
    }

    const geminiFile = normalizeCachedGeminiFile(entry.file);

    if (!geminiFile) {
      return page;
    }

    return {
      ...page,
      gemini_file: geminiFile,
    };
  });
}

async function loadSharedReferenceGeminiCache(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  taskId: string;
}) {
  const { data, error } = await params.admin
    .from('generation_task_items')
    .select('id, llm_input')
    .eq('task_id', params.taskId);

  if (error || !data) {
    return null;
  }

  for (const item of data as Array<{ llm_input?: unknown }>) {
    const llmInput =
      item.llm_input && typeof item.llm_input === 'object'
        ? (item.llm_input as Record<string, unknown>)
        : null;
    const cache = normalizeSharedReferenceGeminiCache(
      llmInput?.reference_gemini_files,
    );

    if (cache) {
      return cache;
    }
  }

  return null;
}

function sharedReferenceCacheCoversPages(
  cache: SharedReferenceGeminiCache | null,
  pages: ReferencePdfVisionPageInput[],
) {
  if (!cache || pages.length === 0) {
    return false;
  }

  const cachePageNumbers = new Set(cache.files.map((file) => file.page_number));
  const cacheStoragePaths = new Set(
    cache.files.flatMap((file) =>
      file.annotated_storage_path ? [file.annotated_storage_path] : [],
    ),
  );

  return pages.every((page) =>
    page.annotated_storage_path
      ? cacheStoragePaths.has(page.annotated_storage_path) ||
        cachePageNumbers.has(page.page_number)
      : cachePageNumbers.has(page.page_number),
  );
}

async function persistSharedReferenceGeminiCache(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  taskId: string;
  cache: SharedReferenceGeminiCache;
}) {
  const { data, error } = await params.admin
    .from('generation_task_items')
    .select('id, llm_input')
    .eq('task_id', params.taskId);

  if (error || !data) {
    throw error ?? new Error('Failed to load generation task items.');
  }

  const updateResults = await Promise.all(
    (data as Array<{ id: string; llm_input?: unknown }>).map((item) => {
      const llmInput =
        item.llm_input && typeof item.llm_input === 'object'
          ? (item.llm_input as Record<string, unknown>)
          : {};

      return params.admin
        .from('generation_task_items')
        .update({
          llm_input: {
            ...llmInput,
            reference_gemini_files: params.cache,
          },
        })
        .eq('id', item.id);
    }),
  );
  const updateError = updateResults.find((result) => result.error)?.error;

  if (updateError) {
    throw updateError;
  }
}

async function uploadSharedReferenceGeminiCache(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  taskItemId: string;
  taskId: string;
  templateId: string | null;
  pages: ReferencePdfVisionPageInput[];
}) {
  const llmConfig = getLlmRuntimeConfig('vision');

  if (llmConfig.provider !== 'gemini' || params.pages.length === 0) {
    return null;
  }

  const requestLabel = `shared reference pages for task ${params.taskId}`;
  const uploadedFiles = await uploadGeminiFilesToFileApi({
    config: llmConfig,
    requestLabel,
    images: params.pages.map((page) => ({
      dataUrl: page.annotated_image_data_url ?? page.image_data_url,
      displayName: `reference-page-${page.page_number}`,
    })),
    onTrace: async ({ message }) => {
      await appendProcessingTrace(params.admin, params.taskItemId, message);
    },
  });
  try {
    const cache: SharedReferenceGeminiCache = {
      task_id: params.taskId,
      template_id: params.templateId,
      created_at: new Date().toISOString(),
      files: params.pages.flatMap((page, index) => {
        const file = uploadedFiles[index];

        if (!file) {
          return [];
        }

        return [
          {
            page_number: page.page_number,
            original_page_number:
              page.original_page_number ?? page.page_number,
            annotated_storage_path: page.annotated_storage_path ?? null,
            annotated_preview_url: page.annotated_preview_url ?? null,
            file: {
              uri: file.uri,
              name: file.name ?? null,
              mime_type: file.mimeType,
              size_bytes: file.sizeBytes,
              display_name: file.displayName,
            },
          },
        ];
      }),
    };

    await persistSharedReferenceGeminiCache({
      admin: params.admin,
      taskId: params.taskId,
      cache,
    });
    await appendProcessingTrace(
      params.admin,
      params.taskItemId,
      `[Gemini File API][SharedReferenceCacheSaved] ${JSON.stringify({
        task_id: params.taskId,
        template_id: params.templateId,
        reference_page_count: cache.files.length,
      })}`,
    );

    return cache;
  } catch (error) {
    await appendProcessingTrace(
      params.admin,
      params.taskItemId,
      `[Gemini File API][SharedReferenceCachePersistFailed] ${JSON.stringify({
        task_id: params.taskId,
        uploaded_file_count: uploadedFiles.length,
        error_message: getErrorMessage(error),
      })}`,
    );
    await cleanupGeminiUploadedFiles({
      config: llmConfig,
      files: uploadedFiles,
    });
    throw error;
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

  let cache = await loadSharedReferenceGeminiCache({
    admin: params.admin,
    taskId: params.taskId,
  });

  if (!sharedReferenceCacheCoversPages(cache, params.pages)) {
    await appendProcessingTrace(
      params.admin,
      params.taskItemId,
      `[Gemini File API][SharedReferenceCacheMiss] ${JSON.stringify({
        task_id: params.taskId,
        template_id: params.templateId,
        reference_page_count: params.pages.length,
        existing_cache_page_count: cache?.files.length ?? 0,
      })}`,
    );

    try {
      cache = await uploadSharedReferenceGeminiCache(params);
    } catch (error) {
      await appendProcessingTrace(
        params.admin,
        params.taskItemId,
        `[Gemini File API][SharedReferenceCacheFallback] ${JSON.stringify({
          task_id: params.taskId,
          error_message: getErrorMessage(error),
          fallback: 'reference_pages_will_use_image_url_upload_per_call',
        })}`,
      );
      cache = null;
    }
  } else {
    await appendProcessingTrace(
      params.admin,
      params.taskItemId,
      `[Gemini File API][SharedReferenceCacheHit] ${JSON.stringify({
        task_id: params.taskId,
        template_id: params.templateId,
        reference_page_count: params.pages.length,
        cached_reference_page_count: cache?.files.length ?? 0,
      })}`,
    );
  }

  return attachSharedReferenceGeminiFiles(params.pages, cache);
}

const FINAL_TASK_ITEM_STATUSES = new Set([
  'review_pending',
  'reviewed',
  'succeeded',
  'failed',
  'cancelled',
  'completed',
]);

async function cleanupSharedReferenceGeminiCacheIfTaskFinished(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  taskItemId: string;
  taskId: string;
}) {
  const llmConfig = getLlmRuntimeConfig('vision');

  if (llmConfig.provider !== 'gemini') {
    return;
  }

  const { data, error } = await params.admin
    .from('generation_task_items')
    .select('id, status, llm_input')
    .eq('task_id', params.taskId);

  if (error || !data) {
    await appendProcessingTrace(
      params.admin,
      params.taskItemId,
      `[Gemini File API][SharedReferenceCleanupCheckFailed] ${JSON.stringify({
        task_id: params.taskId,
        error_message: error?.message ?? 'Failed to load task items.',
      })}`,
    );
    return;
  }

  const rows = data as Array<{
    id: string;
    status?: string | null;
    llm_input?: unknown;
  }>;
  const activeRows = rows.filter(
    (row) => !FINAL_TASK_ITEM_STATUSES.has(row.status ?? ''),
  );

  if (activeRows.length > 0) {
    await appendProcessingTrace(
      params.admin,
      params.taskItemId,
      `[Gemini File API][SharedReferenceCleanupDeferred] ${JSON.stringify({
        task_id: params.taskId,
        active_item_count: activeRows.length,
        active_items: activeRows.map((row) => ({
          id: row.id,
          status: row.status ?? null,
        })),
      })}`,
    );
    return;
  }

  const cache =
    rows
      .map((row) => {
        const llmInput =
          row.llm_input && typeof row.llm_input === 'object'
            ? (row.llm_input as Record<string, unknown>)
            : null;

        return normalizeSharedReferenceGeminiCache(
          llmInput?.reference_gemini_files,
        );
      })
      .find(Boolean) ?? null;

  if (!cache) {
    return;
  }

  const filesByNameOrUri = new Map<string, UploadedGeminiFile>();
  cache.files.forEach((entry) => {
    const file = normalizeCachedGeminiFile(entry.file);

    if (file) {
      filesByNameOrUri.set(file.name ?? file.uri, file);
    }
  });
  const files = Array.from(filesByNameOrUri.values());

  await appendProcessingTrace(
    params.admin,
    params.taskItemId,
    `[Gemini File API][SharedReferenceCleanupStart] ${JSON.stringify({
      task_id: params.taskId,
      uploaded_file_count: files.length,
      reason: 'all_generation_task_items_finished',
    })}`,
  );
  const cleanupResults = await cleanupGeminiUploadedFiles({
    config: llmConfig,
    files,
  });
  await appendProcessingTrace(
    params.admin,
    params.taskItemId,
    `[Gemini File API][SharedReferenceCleanupComplete] ${JSON.stringify({
      task_id: params.taskId,
      cleanup_results: cleanupResults.map((result) =>
        result.status === 'fulfilled'
          ? result.value
          : {
              deleted: false,
              reason: 'cleanup_rejected',
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            },
      ),
    })}`,
  );

  const updateResults = await Promise.all(
    rows.map((row) => {
      const llmInput =
        row.llm_input && typeof row.llm_input === 'object'
          ? (row.llm_input as Record<string, unknown>)
          : {};
      const { reference_gemini_files: _referenceGeminiFiles, ...nextLlmInput } =
        llmInput;

      return params.admin
        .from('generation_task_items')
        .update({ llm_input: nextLlmInput })
        .eq('id', row.id);
    }),
  );
  const updateError = updateResults.find((result) => result.error)?.error;

  if (updateError) {
    await appendProcessingTrace(
      params.admin,
      params.taskItemId,
      `[Gemini File API][SharedReferenceCacheClearFailed] ${JSON.stringify({
        task_id: params.taskId,
        error_message: updateError.message,
      })}`,
    );
  }
}

async function cleanupCachedGeminiFilesForTaskItem(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  taskItemId: string;
  pageImageAssets: ReturnType<typeof normalizePdfPageImageAssets>;
}) {
  const files = collectCachedGeminiFilesForCleanup(params.pageImageAssets);

  if (files.length === 0) {
    return;
  }

  const llmConfig = getLlmRuntimeConfig('vision');

  if (llmConfig.provider !== 'gemini') {
    return;
  }

  await appendProcessingTrace(
    params.admin,
    params.taskItemId,
    `[Gemini File API][TaskCleanupStart] ${JSON.stringify({
      uploaded_file_count: files.length,
      reason: 'slot_fill_finished_or_fallback',
    })}`,
  );
  const cleanupResults = await cleanupGeminiUploadedFiles({
    config: llmConfig,
    files,
  });
  await appendProcessingTrace(
    params.admin,
    params.taskItemId,
    `[Gemini File API][TaskCleanupComplete] ${JSON.stringify({
      cleanup_results: cleanupResults.map((result) =>
        result.status === 'fulfilled'
          ? result.value
          : {
              deleted: false,
              reason: 'cleanup_rejected',
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            },
      ),
    })}`,
  );
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
  const precomputedVisionPages = normalizeVisionPages(
    params.item.llm_input?.vision_pages,
  );
  const allPageImageAssets = normalizePdfPageImageAssets(
    params.item.llm_input?.ocr_image_assets,
  );
  const pageImageAssets =
    filterPdfPageImageAssetsForSlotFill(allPageImageAssets);
  const pipelineStartedAt = params.item.started_at
    ? new Date(params.item.started_at)
    : startedAt;
  let transientSlotFillGeminiFiles: UploadedGeminiFile[] = [];

  try {
    if (slotSchema.length === 0) {
      throw new Error('当前模板缺少槽位定义，请重新保存模板后再试。');
    }

    if (precomputedVisionPages.length === 0 && pageImageAssets.length === 0) {
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
        precomputed_vision_page_count: precomputedVisionPages.length,
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

    const llmConfig = getLlmRuntimeConfig('vision');
    const cachedGeminiVisionPages =
      llmConfig.provider === 'gemini'
        ? buildVisionPagesFromCachedGeminiFiles(pageImageAssets)
        : [];
    const canReuseCachedGeminiFiles =
      cachedGeminiVisionPages.length === pageImageAssets.length &&
      pageImageAssets.length > 0;
    const visionPages =
      precomputedVisionPages.length > 0
        ? precomputedVisionPages
        : canReuseCachedGeminiFiles
          ? cachedGeminiVisionPages
          : llmConfig.provider === 'gemini' && pageImageAssets.length > 0
            ? await uploadStoredPageImagesToGeminiFileApi({
                admin,
                pageImageAssets,
                config: llmConfig,
                requestLabel: `slot fill ${params.item.id}`,
                onTrace: async ({ message }) => {
                  await appendProcessingTrace(admin, params.item.id, message);
                },
              })
          : await loadVisionPagesFromStoredAssets({
              admin,
              pageImageAssets,
            });
    transientSlotFillGeminiFiles =
      precomputedVisionPages.length === 0 &&
      !canReuseCachedGeminiFiles &&
      llmConfig.provider === 'gemini'
        ? visionPages.flatMap((page) =>
            page.gemini_file ? [page.gemini_file] : [],
          )
        : [];

    await appendProcessingTrace(
      admin,
      params.item.id,
      `[Gemini File API][SlotFillReuse] ${JSON.stringify({
        provider: llmConfig.provider,
        reused_cached_page_file_count: canReuseCachedGeminiFiles
          ? cachedGeminiVisionPages.length
          : 0,
        fallback_to_supabase_download:
          precomputedVisionPages.length === 0 &&
          !canReuseCachedGeminiFiles &&
          llmConfig.provider !== 'gemini',
        uploaded_via_storage_pipeline_file_count:
          transientSlotFillGeminiFiles.length,
        cached_page_file_count: cachedGeminiVisionPages.length,
        required_page_count: pageImageAssets.length,
      })}`,
    );

    if (visionPages.length === 0) {
      throw new Error('当前任务没有可读取的新 PDF 页面图片。');
    }

    const referenceExamplePages = await loadReferenceExamplePagesWithBbox({
      admin,
      taskItemId: params.item.id,
      ownerId: params.item.owner_id,
      templateId: params.item.template_id,
      slots: slotSchema,
    });
    const referencePagesForSlotFill =
      await getSharedReferencePagesForSlotFill({
        admin,
        taskItemId: params.item.id,
        taskId: params.item.task_id,
        templateId: params.item.template_id,
        pages: referenceExamplePages.pages,
      });

    await admin
      .from('generation_task_items')
      .update({
        status: 'slot_filling',
        error_message: null,
        started_at: pipelineStartedAt.toISOString(),
        finished_at: null,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
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
    const llmOutput = await fillSlotsFromVisionPages({
      pdfFileName: params.item.source_pdf_name,
      slots: slotSchema,
      visionPages,
      referenceExamplePages: referencePagesForSlotFill,
      processStartedAtMs,
      processHardTimeoutMs: PROCESS_HARD_TIMEOUT_MS,
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

    const { error: updateError } = await admin
      .from('generation_task_items')
      .update({
        status: 'review_pending',
        elapsed_seconds: elapsedSeconds,
        llm_output: llmOutput,
        slot_total_count: slotSchema.length,
        slot_completed_count: completedSlots,
        finished_at: finishedAt.toISOString(),
      })
      .eq('id', params.item.id);

    if (updateError) {
      throw updateError;
    }

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

    await admin
      .from('generation_task_items')
      .update({
        status: 'review_pending',
        error_message: null,
        llm_output: fallbackReviewPayload,
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
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[RouteErrorDetails][SlotFill] ${JSON.stringify(
        buildErrorLogPayload(error, {
          sourcePdfName: params.item.source_pdf_name,
          slotCount: slotSchema.length,
          visionPageCount: precomputedVisionPages.length,
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
        visionPageCount: precomputedVisionPages.length,
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
    if (transientSlotFillGeminiFiles.length > 0) {
      const llmConfig = getLlmRuntimeConfig('vision');

      await appendProcessingTrace(
        admin,
        params.item.id,
        `[Gemini File API][SlotFillTransientCleanupStart] ${JSON.stringify({
          uploaded_file_count: transientSlotFillGeminiFiles.length,
          reason: 'slot_fill_finished_or_fallback',
        })}`,
      );
      const cleanupResults = await cleanupGeminiUploadedFiles({
        config: llmConfig,
        files: transientSlotFillGeminiFiles,
      });
      await appendProcessingTrace(
        admin,
        params.item.id,
        `[Gemini File API][SlotFillTransientCleanupComplete] ${JSON.stringify({
          cleanup_results: cleanupResults.map((result) =>
            result.status === 'fulfilled'
              ? result.value
              : {
                  deleted: false,
                  reason: 'cleanup_rejected',
                  error:
                    result.reason instanceof Error
                      ? result.reason.message
                      : String(result.reason),
                },
          ),
        })}`,
      );
    }
    await cleanupCachedGeminiFilesForTaskItem({
      admin,
      taskItemId: params.item.id,
      pageImageAssets: allPageImageAssets,
    });
    await cleanupSharedReferenceGeminiCacheIfTaskFinished({
      admin,
      taskItemId: params.item.id,
      taskId: params.item.task_id,
    });
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

    const rawBody = await request.json().catch(() => null);
    const confirmedPageNumbers = normalizeConfirmedPageNumbers(
      rawBody && typeof rawBody === 'object'
        ? (rawBody as { confirmedPageNumbers?: unknown }).confirmedPageNumbers
        : null,
    );
    let nextItem = item;

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

    after(async () => {
      await runGenerationTaskItemSlotFill({
        item: nextItem,
        actorEmail: user.email ?? null,
      });
    });

    return NextResponse.json(
      {
        data: {
          item: {
            ...nextItem,
            status: 'slot_filling',
            error_message: null,
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
