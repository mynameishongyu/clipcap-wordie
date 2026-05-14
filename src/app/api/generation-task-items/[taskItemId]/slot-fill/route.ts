import { after, NextResponse } from 'next/server';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { randomUUID } from 'crypto';
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
  loadVisionPagesFromStoredAssets,
  normalizeOcrImageAssets,
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
  context.font = `${labelFontSize}px Arial, sans-serif`;
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
    context.fillText(label, labelLeft + labelPaddingX, labelTop + labelPaddingY);
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

  const pages = await Promise.all(
    [...pageAssetsByKey.values()]
      .sort((left, right) => left.pageNumber - right.pageNumber)
      .map(async (asset) => {
        const { data: fileBlob, error } = await params.admin.storage
          .from('generation-pdfs')
          .download(asset.storagePath);

        if (error || !fileBlob) {
          throw (
            error ?? new Error(`无法下载示例 PDF 页图: ${asset.storagePath}`)
          );
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
        } satisfies ReferencePdfVisionPageInput;
      }),
  );

  return {
    pages,
    skippedSlotsWithoutBbox,
    skippedSlotsWithoutPageImage,
  };
}

async function appendVisionPageImageDebugTraces(params: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  taskItemId: string;
  visionPages: ReturnType<typeof normalizeVisionPages>;
  ocrImageAssets: ReturnType<typeof normalizeOcrImageAssets>;
}) {
  const assetsByUploadedPageNumber = new Map(
    params.ocrImageAssets.map((asset) => [asset.uploaded_page_number, asset]),
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
  const ocrImageAssets = normalizeOcrImageAssets(
    params.item.llm_input?.ocr_image_assets,
  );
  const pipelineStartedAt = params.item.started_at
    ? new Date(params.item.started_at)
    : startedAt;

  try {
    if (slotSchema.length === 0) {
      throw new Error('当前模板缺少槽位定义，请重新保存模板后再试。');
    }

    if (precomputedVisionPages.length === 0 && ocrImageAssets.length === 0) {
      throw new Error(
        '当前任务缺少可用于视觉回填的新 PDF 页面图片，请重新创建批量任务。',
      );
    }

    const visionPages =
      precomputedVisionPages.length > 0
        ? precomputedVisionPages
        : await loadVisionPagesFromStoredAssets({
            admin,
            ocrImageAssets,
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
      '槽位回填阶段：跳过新 PDF OCR，直接使用槽位来源、示例 PDF 定位信息和新 PDF 页面图片调用 VISION_LLM。',
    );

    await appendVisionPageImageDebugTraces({
      admin,
      taskItemId: params.item.id,
      visionPages,
      ocrImageAssets,
    });

    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][ReferenceExample] Using ${referenceExamplePages.pages.length} example PDF page image(s) with bbox for slot fill; skipped ${referenceExamplePages.skippedSlotsWithoutBbox} slot(s) without bbox and ${referenceExamplePages.skippedSlotsWithoutPageImage} slot(s) without stored example page image.`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][ReferenceExampleImages] ${JSON.stringify({
        document_name: params.item.source_pdf_name,
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
      `[RouteErrorDetails][SlotFill] ${JSON.stringify(
        buildErrorLogPayload(error, {
          sourcePdfName: params.item.source_pdf_name,
          slotCount: slotSchema.length,
          visionPageCount: precomputedVisionPages.length,
          ocrImageAssetCount: ocrImageAssets.length,
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
        ocrImageAssetCount: ocrImageAssets.length,
      }),
    });
  }
}

export async function POST(
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

    after(async () => {
      await runGenerationTaskItemSlotFill({
        item,
        actorEmail: user.email ?? null,
      });
    });

    return NextResponse.json(
      {
        data: {
          item: {
            ...item,
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
