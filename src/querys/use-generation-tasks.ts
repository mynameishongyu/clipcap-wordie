'use client';

import { useMutation } from '@tanstack/react-query';
import type { CreateGenerationTaskResponse } from '@/src/app/api/types/generation-task';
import type { PdfVisionPageInput } from '@/src/lib/pdf/client-pdf';
import { getSupabaseBrowserClient } from '@/src/lib/supabase/client';

const DEFAULT_PDF_VISION_UPLOAD_CONCURRENCY = 3;
const MAX_PDF_VISION_UPLOAD_CONCURRENCY = 8;

export interface CreateGenerationTaskFileInput {
  file: File;
  pageVisionPages: PdfVisionPageInput[];
  selectedOriginalPageNumbers: number[];
  uploadedPageNumberMapping: Array<{
    uploaded_page_number: number;
    original_page_number: number;
  }>;
  originalTotalPages: number;
  selectedPageRangeLabel: string;
  forceVisionPageFill: boolean;
}

export interface CreateGenerationTaskInput {
  templateId: string;
  templateName: string;
  files: CreateGenerationTaskFileInput[];
  onStageChange?: (stage: {
    title: string;
    description: string;
  }) => void;
}

function sanitizeStorageFileName(fileName: string) {
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

function getImageExtensionFromDataUrl(dataUrl: string) {
  if (dataUrl.startsWith('data:image/png')) {
    return 'png';
  }

  if (dataUrl.startsWith('data:image/jpeg')) {
    return 'jpg';
  }

  if (dataUrl.startsWith('data:image/webp')) {
    return 'webp';
  }

  return 'img';
}

function getImageExtensionFromContentType(contentType: string) {
  if (contentType.includes('png')) {
    return 'png';
  }

  if (contentType.includes('jpeg') || contentType.includes('jpg')) {
    return 'jpg';
  }

  if (contentType.includes('webp')) {
    return 'webp';
  }

  return 'img';
}

async function dataUrlToBlob(dataUrl: string) {
  const response = await fetch(dataUrl);

  if (!response.ok) {
    throw new Error('PDF 页面图片数据无效，无法上传到存储。');
  }

  return response.blob();
}

async function getPdfVisionPageBlob(visionPage: PdfVisionPageInput) {
  if (visionPage.imageBlob) {
    return visionPage.imageBlob;
  }

  if (visionPage.imageDataUrl) {
    return dataUrlToBlob(visionPage.imageDataUrl);
  }

  throw new Error('PDF page image data is empty, cannot upload to storage.');
}

function getPdfVisionPageImageExtension(
  visionPage: PdfVisionPageInput,
  blob: Blob,
) {
  if (blob.type) {
    return getImageExtensionFromContentType(blob.type);
  }

  if (visionPage.imageDataUrl) {
    return getImageExtensionFromDataUrl(visionPage.imageDataUrl);
  }

  return 'img';
}

function getPdfVisionUploadConcurrency() {
  const parsedValue = Number(
    process.env.NEXT_PUBLIC_PDF_VISION_UPLOAD_CONCURRENCY,
  );

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_PDF_VISION_UPLOAD_CONCURRENCY;
  }

  return Math.min(
    MAX_PDF_VISION_UPLOAD_CONCURRENCY,
    Math.max(1, Math.floor(parsedValue)),
  );
}

function formatDurationMs(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '0.00 秒';
  }

  if (durationMs < 1000) {
    return `${durationMs} 毫秒`;
  }

  return `${(durationMs / 1000).toFixed(2)} 秒`;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const currentItem = items[currentIndex];

        if (!currentItem) {
          continue;
        }

        await worker(currentItem, currentIndex);
      }
    }),
  );
}

async function reportClientError(input: {
  eventType: string;
  message: string;
  route: string;
  templateId?: string | null;
  payload?: Record<string, unknown>;
}) {
  try {
    await fetch('/api/client-logs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        level: 'error',
        eventType: input.eventType,
        message: input.message,
        route: input.route,
        templateId: input.templateId ?? null,
        payload: input.payload ?? {},
      }),
    });
  } catch (error) {
    console.error('[Client Log] Failed to report frontend error', {
      eventType: input.eventType,
      message: input.message,
      error,
    });
  }
}

async function parseApiPayload<T>(
  response: Response,
): Promise<{
  payload: T | null;
  message: string | null;
}> {
  const contentType = response.headers.get('content-type') ?? '';
  const rawText = await response.text();

  if (!rawText) {
    return { payload: null, message: null };
  }

  if (contentType.includes('application/json')) {
    try {
      const payload = JSON.parse(rawText) as T & { message?: string };
      return {
        payload,
        message:
          typeof payload === 'object' &&
          payload !== null &&
          'message' in payload &&
          typeof payload.message === 'string'
            ? payload.message
            : null,
      };
    } catch {
      return { payload: null, message: rawText };
    }
  }

  return { payload: null, message: rawText };
}

async function uploadFilesToSupabase(input: CreateGenerationTaskInput) {
  const supabase = getSupabaseBrowserClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error('请先登录后再上传 PDF。');
  }

  const uploadAllStartedAt = Date.now();
  const results = await Promise.all(
    input.files.map(async (item) => {
      input.onStageChange?.({
        title: '正在准备 PDF 页面图片',
        description: `${item.file.name}：不上传原始 PDF，只上传转换后的 PNG 页面图片。`,
      });

      let uploadedPageImageCount = 0;
      const totalPageImageCount = item.pageVisionPages.length;
      const uploadConcurrency = getPdfVisionUploadConcurrency();
      const pdfAssetId = crypto.randomUUID();
      const pdfPageFolderPath = `${user.id}/fill-pdf-pages/${pdfAssetId}`;
      const pageImageAssets: Array<
        | {
            uploaded_page_number: number;
            original_page_number: number;
            storage_path: string;
            crop?: PdfVisionPageInput['crop'];
            rotation_applied?: PdfVisionPageInput['rotationApplied'];
          }
        | undefined
      > = Array.from({ length: totalPageImageCount });

      input.onStageChange?.({
        title: '正在上传 PDF 页面图片',
        description:
          `${item.file.name}：准备并行上传 ${totalPageImageCount} 张 PDF 页面图片，并发数 ${uploadConcurrency}。`,
      });

      const uploadStartedAt = Date.now();
      await runWithConcurrency(
        item.pageVisionPages,
        uploadConcurrency,
        async (visionPage, index) => {
          const imageBlob = await getPdfVisionPageBlob(visionPage);
          const uploadedPageNumber =
            item.uploadedPageNumberMapping[index]?.uploaded_page_number ?? index + 1;
          const originalPageNumber =
            item.uploadedPageNumberMapping[index]?.original_page_number ?? visionPage.pageNumber;
          const extension = getPdfVisionPageImageExtension(visionPage, imageBlob);
          const pageImageStoragePath =
            `${pdfPageFolderPath}/page-${uploadedPageNumber}.${extension}`;
          const { error: pageImageUploadError } = await supabase.storage
            .from('generation-pdfs')
            .upload(pageImageStoragePath, imageBlob, {
              contentType: imageBlob.type || 'application/octet-stream',
              upsert: false,
            });

          if (pageImageUploadError) {
            console.error('[Generation Task][PDF Page Image Upload] Failed', {
              fileName: item.file.name,
              uploadedPageNumber,
              originalPageNumber,
              storagePath: pageImageStoragePath,
              contentType: imageBlob.type || 'application/octet-stream',
              size: imageBlob.size,
              error: {
                name: pageImageUploadError.name,
                message: pageImageUploadError.message,
              },
            });
            throw new Error(`上传 PDF 页面图片到存储失败：${pageImageUploadError.message}`);
          }

          uploadedPageImageCount += 1;
          input.onStageChange?.({
            title: '正在上传 PDF 页面图片',
            description:
              `${item.file.name}：已上传 ${uploadedPageImageCount}/${totalPageImageCount} 张 PDF 页面图片，并发数 ${uploadConcurrency}。`,
          });

          pageImageAssets[index] = {
            uploaded_page_number: uploadedPageNumber,
            original_page_number: originalPageNumber,
            storage_path: pageImageStoragePath,
            ...(visionPage.crop ? { crop: visionPage.crop } : {}),
            ...(visionPage.rotationApplied
              ? { rotation_applied: visionPage.rotationApplied }
              : {}),
          };
        },
      );
      const uploadDurationMs = Date.now() - uploadStartedAt;
      console.info(
        `[Batch Generate][${item.file.name}] 上传 PDF 页面图片到 Supabase 总耗时：${formatDurationMs(
          uploadDurationMs,
        )}`,
        {
          fileName: item.file.name,
          pageImageCount: totalPageImageCount,
          uploadedPageImageCount,
          uploadConcurrency,
          durationMs: uploadDurationMs,
          storagePath: pdfPageFolderPath,
        },
      );

      return {
        file_name: item.file.name,
        storage_path: pdfPageFolderPath,
        pdf_asset_id: pdfAssetId,
        ocr_image_assets: pageImageAssets.filter(
          (asset): asset is NonNullable<(typeof pageImageAssets)[number]> =>
            Boolean(asset),
        ),
        selected_original_page_numbers: item.selectedOriginalPageNumbers,
        uploaded_page_number_mapping: item.uploadedPageNumberMapping,
        original_total_pages: item.originalTotalPages,
        selected_page_count: item.selectedOriginalPageNumbers.length,
        selected_page_range_label: item.selectedPageRangeLabel,
        force_vision_page_fill: item.forceVisionPageFill,
      };
    }),
  );
  const uploadAllDurationMs = Date.now() - uploadAllStartedAt;

  console.info(
    `[Batch Generate] 上传 PDF 页面图片到 Supabase 全部文件总耗时：${formatDurationMs(
      uploadAllDurationMs,
    )}`,
    {
      fileCount: input.files.length,
      fileNames: input.files.map((item) => item.file.name),
      durationMs: uploadAllDurationMs,
    },
  );

  return results;
}

export function useCreateGenerationTask() {
  return useMutation({
    mutationFn: async (input: CreateGenerationTaskInput) => {
      let uploadedFileMetadatas;

      try {
        input.onStageChange?.({
          title: '正在上传文件',
          description: '正在上传 PDF 和页面图片到存储，请稍候。',
        });
        uploadedFileMetadatas = await uploadFilesToSupabase(input);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : '上传 PDF 或页面图片到存储失败。';

        console.error('[Generation Task] Staging upload failed', {
          message: errorMessage,
          templateId: input.templateId,
          templateName: input.templateName,
          fileCount: input.files.length,
          fileNames: input.files.map((item) => item.file.name),
        });

        await reportClientError({
          eventType: 'generation_task_staging_upload_failed_frontend',
          message: errorMessage,
          route: '/api/generation-tasks',
          templateId: input.templateId,
          payload: {
            templateName: input.templateName,
            fileCount: input.files.length,
            fileNames: input.files.map((item) => item.file.name),
          },
        });

        throw error instanceof Error ? error : new Error(errorMessage);
      }

      const formData = new FormData();
      formData.append('templateId', input.templateId);
      formData.append('templateName', input.templateName);
      formData.append('fileMetadatas', JSON.stringify(uploadedFileMetadatas));

      input.onStageChange?.({
        title: '正在创建批量任务',
        description: '文件已上传完成，正在向服务端创建批量任务。',
      });

      const response = await fetch('/api/generation-tasks', {
        method: 'POST',
        body: formData,
      });

      const { payload, message } = await parseApiPayload<{
        message?: string;
        data?: CreateGenerationTaskResponse;
      }>(response);

      if (!response.ok || !payload?.data) {
        const errorMessage = message ?? '创建批量生成任务失败，请稍后重试。';
        console.error('[Generation Task] Create failed', {
          status: response.status,
          statusText: response.statusText,
          message: errorMessage,
          templateId: input.templateId,
          templateName: input.templateName,
          fileCount: input.files.length,
          fileNames: input.files.map((item) => item.file.name),
        });

        await reportClientError({
          eventType: 'generation_task_create_failed_frontend',
          message: errorMessage,
          route: '/api/generation-tasks',
          templateId: input.templateId,
          payload: {
            status: response.status,
            statusText: response.statusText,
            templateName: input.templateName,
            fileCount: input.files.length,
            fileNames: input.files.map((item) => item.file.name),
          },
        });

        throw new Error(errorMessage);
      }

      return payload.data;
    },
  });
}

export function useDeleteGenerationTask() {
  return useMutation({
    mutationFn: async (taskId: string) => {
      const response = await fetch(`/api/generation-tasks/${taskId}`, {
        method: 'DELETE',
      });

      const { payload, message } = await parseApiPayload<{
        message?: string;
        data?: { id: string };
      }>(response);

      if (!response.ok || !payload?.data) {
        throw new Error(message ?? '删除批量生成任务失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}

export function useDeleteGenerationTaskItem() {
  return useMutation({
    mutationFn: async (taskItemId: string) => {
      const response = await fetch(`/api/generation-task-items/${taskItemId}`, {
        method: 'DELETE',
      });

      const { payload, message } = await parseApiPayload<{
        message?: string;
        data?: { id: string; task_id: string | null; already_deleted?: boolean };
      }>(response);

      if (!response.ok || !payload?.data) {
        throw new Error(message ?? '删除任务项失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}
