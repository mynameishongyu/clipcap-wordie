import { after, NextResponse } from 'next/server';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  fillSlotsFromVisionPages,
  type GenerationSlotSchemaItem,
  normalizedBboxToGeminiBox2d,
  type ReferencePdfVisionPageInput,
} from '@/src/lib/llm/fill-template-from-pdf';
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

  params.slotBoxes.forEach((slotBox) => {
    const left = Math.max(0, Math.min(width, slotBox.bbox.x * width));
    const top = Math.max(0, Math.min(height, slotBox.bbox.y * height));
    const boxWidth = Math.max(
      1,
      Math.min(width - left, slotBox.bbox.width * width),
    );
    const boxHeight = Math.max(
      1,
      Math.min(height - top, slotBox.bbox.height * height),
    );

    context.fillStyle = 'rgba(255, 153, 0, 0.08)';
    context.fillRect(left, top, boxWidth, boxHeight);
    context.strokeStyle = '#ff9900';
    context.lineWidth = lineWidth;
    context.strokeRect(left, top, boxWidth, boxHeight);

    const label = slotBox.slotKey;
    const measured = context.measureText(label);
    const labelWidth = Math.ceil(measured.width) + labelPaddingX * 2;
    const labelHeight = labelFontSize + labelPaddingY * 2;
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
    context.fillText(
      label,
      labelLeft + labelPaddingX,
      labelTop + labelPaddingY,
    );
  });

  const annotatedBuffer = canvas.toBuffer('image/png');

  return {
    dataUrl: `data:image/png;base64,${annotatedBuffer.toString('base64')}`,
    buffer: annotatedBuffer,
  };
}

async function loadReferenceExamplePagesWithBbox(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  taskItemId: string;
  ownerId: string;
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

  const pageResults = await Promise.all(
    [...pageAssetsByKey.values()]
      .sort((left, right) => left.pageNumber - right.pageNumber)
      .map(async (asset) => {
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
        const imageDataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
        let annotatedImageDataUrl: string | undefined;
        let annotatedPreviewUrl: string | undefined;
        let annotatedStoragePath: string | undefined;

        try {
          const annotatedImage = await buildAnnotatedReferencePageDataUrl({
            imageBuffer: buffer,
            slotBoxes: asset.slotBoxes,
          });
          annotatedImageDataUrl = annotatedImage.dataUrl;
          annotatedStoragePath =
            `${params.ownerId}/slot-fill-reference-annotations/${params.taskItemId}/` +
            `${randomUUID()}-example-page-${asset.pageNumber}.png`;

          const { error: uploadError } = await params.admin.storage
            .from('generation-pdfs')
            .upload(annotatedStoragePath, annotatedImage.buffer, {
              contentType: 'image/png',
              upsert: false,
            });

          if (uploadError) {
            throw uploadError;
          }

          const { data: signedUrlData, error: signedUrlError } =
            await params.admin.storage
              .from('generation-pdfs')
              .createSignedUrl(annotatedStoragePath, 60 * 60 * 24);

          if (signedUrlError || !signedUrlData?.signedUrl) {
            throw (
              signedUrlError ??
              new Error(`Missing signed URL for ${annotatedStoragePath}`)
            );
          }

          annotatedPreviewUrl = signedUrlData.signedUrl;
        } catch (error) {
          annotatedPreviewUrl = undefined;
          annotatedStoragePath = undefined;
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
            ...(annotatedStoragePath
              ? { annotated_storage_path: annotatedStoragePath }
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
      }),
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
          has_data_url: Boolean(page.image_data_url),
        };
      }),
    )}`,
  );

  for (const page of params.visionPages) {
    const asset = assetsByUploadedPageNumber.get(page.page_number);
    let signedUrl: string | null = null;
    let signedUrlErrorMessage: string | null = null;

    if (asset?.storage_path) {
      const { data, error } = await params.admin.storage
        .from('generation-pdfs')
        .createSignedUrl(asset.storage_path, 60 * 60 * 24);

      if (error || !data?.signedUrl) {
        signedUrlErrorMessage =
          error?.message ?? `Missing signed URL for ${asset.storage_path}`;
      } else {
        signedUrl = data.signedUrl;
      }
    }

    await appendProcessingTrace(
      params.admin,
      params.taskItemId,
      `[PDF Fill][VisionPageImage] uploaded_page=${page.page_number}, original_page=${
        page.original_page_number ??
        asset?.original_page_number ??
        page.page_number
      }, storage_path=${asset?.storage_path ?? 'none'}, signed_url=${
        signedUrl ?? 'none'
      }, signed_url_error=${signedUrlErrorMessage ?? 'none'}`,
    );
  }
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

    const visionPages =
      precomputedVisionPages.length > 0
        ? precomputedVisionPages
        : await loadVisionPagesFromStoredAssets({
            admin,
            pageImageAssets,
          });

    if (visionPages.length === 0) {
      throw new Error('当前任务没有可读取的新 PDF 页面图片。');
    }

    const referenceExamplePages = await loadReferenceExamplePagesWithBbox({
      admin,
      taskItemId: params.item.id,
      ownerId: params.item.owner_id,
      slots: slotSchema,
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
      `[PDF Fill][ReferenceExample] Using ${referenceExamplePages.pages.length} example PDF page image(s) with bbox for slot fill; skipped ${referenceExamplePages.skippedSlotsWithoutBbox} slot(s) without bbox, ${referenceExamplePages.skippedSlotsWithoutPageImage} slot(s) without readable stored example page image, and ${referenceExamplePages.skippedReferencePageDownloads.length} missing reference page object(s).`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][ReferenceExampleImages] ${JSON.stringify({
        document_name: params.item.source_pdf_name,
        skipped_reference_page_downloads:
          referenceExamplePages.skippedReferencePageDownloads,
        pages: referenceExamplePages.pages.map((page) => ({
          example_pdf_file_name: page.example_pdf_file_name ?? null,
          page_number: page.page_number,
          original_page_number: page.original_page_number ?? page.page_number,
          annotated_preview_url: page.annotated_preview_url ?? null,
          annotated_storage_path: page.annotated_storage_path ?? null,
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
      referenceExamplePageCount: referenceExamplePages.pages.length,
    });

    let lastLoggedCompletedSlots = -1;
    const llmOutput = await fillSlotsFromVisionPages({
      pdfFileName: params.item.source_pdf_name,
      slots: slotSchema,
      visionPages,
      referenceExamplePages: referenceExamplePages.pages,
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
