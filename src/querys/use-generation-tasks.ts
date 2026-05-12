'use client';

import { useMutation } from '@tanstack/react-query';
import type { CreateGenerationTaskResponse } from '@/src/app/api/types/generation-task';
import type { PdfVisionPageInput } from '@/src/lib/pdf/client-pdf';
import { getSupabaseBrowserClient } from '@/src/lib/supabase/client';

export interface CreateGenerationTaskFileInput {
  file: File;
  ocrVisionPages: PdfVisionPageInput[];
  selectedOriginalPageNumbers: number[];
  uploadedPageNumberMapping: Array<{
    uploaded_page_number: number;
    original_page_number: number;
  }>;
  originalTotalPages: number;
  selectedPageRangeLabel: string;
  forceOcr: boolean;
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

async function dataUrlToBlob(dataUrl: string) {
  const response = await fetch(dataUrl);

  if (!response.ok) {
    throw new Error('OCR 图片数据无效，无法上传到存储。');
  }

  return response.blob();
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

  return Promise.all(
    input.files.map(async (item) => {
      input.onStageChange?.({
        title: '正在上传 PDF',
        description: `正在上传 ${item.file.name} 的原始 PDF 到存储。`,
      });

      const storagePath = `${user.id}/staged/${crypto.randomUUID()}-${sanitizeStorageFileName(item.file.name)}`;
      const { error: uploadError } = await supabase.storage
        .from('generation-pdfs')
        .upload(storagePath, item.file, {
          contentType: 'application/pdf',
          upsert: false,
        });

      if (uploadError) {
        throw new Error(`上传 PDF 到存储失败：${uploadError.message}`);
      }

      let uploadedOcrImageCount = 0;
      const totalOcrImageCount = item.ocrVisionPages.length;

      const ocrImageAssets = await Promise.all(
        item.ocrVisionPages.map(async (visionPage, index) => {
          const imageBlob = await dataUrlToBlob(visionPage.imageDataUrl);
          const uploadedPageNumber =
            item.uploadedPageNumberMapping[index]?.uploaded_page_number ?? index + 1;
          const originalPageNumber =
            item.uploadedPageNumberMapping[index]?.original_page_number ?? visionPage.pageNumber;
          const extension = getImageExtensionFromDataUrl(visionPage.imageDataUrl);
          const ocrImageStoragePath =
            `${user.id}/staged-ocr/${crypto.randomUUID()}-` +
            `${sanitizeStorageFileName(item.file.name).replace(/\.pdf$/i, '')}` +
            `-page-${uploadedPageNumber}.${extension}`;
          const { error: ocrUploadError } = await supabase.storage
            .from('generation-pdfs')
            .upload(ocrImageStoragePath, imageBlob, {
              contentType: imageBlob.type || 'application/octet-stream',
              upsert: false,
            });

          if (ocrUploadError) {
            console.error('[Generation Task][OCR Image Upload] Failed', {
              fileName: item.file.name,
              uploadedPageNumber,
              originalPageNumber,
              storagePath: ocrImageStoragePath,
              contentType: imageBlob.type || 'application/octet-stream',
              size: imageBlob.size,
              error: {
                name: ocrUploadError.name,
                message: ocrUploadError.message,
              },
            });
            throw new Error(`上传 OCR 页图到存储失败：${ocrUploadError.message}`);
          }

          uploadedOcrImageCount += 1;
          input.onStageChange?.({
            title: '正在上传 OCR 图片',
            description:
              `${item.file.name}：已上传 ${uploadedOcrImageCount}/${totalOcrImageCount} 张 OCR 图片。`,
          });

          return {
            uploaded_page_number: uploadedPageNumber,
            original_page_number: originalPageNumber,
            storage_path: ocrImageStoragePath,
            ...(visionPage.crop ? { crop: visionPage.crop } : {}),
          };
        }),
      );

      return {
        file_name: item.file.name,
        storage_path: storagePath,
        ocr_image_assets: ocrImageAssets,
        selected_original_page_numbers: item.selectedOriginalPageNumbers,
        uploaded_page_number_mapping: item.uploadedPageNumberMapping,
        original_total_pages: item.originalTotalPages,
        selected_page_count: item.selectedOriginalPageNumbers.length,
        selected_page_range_label: item.selectedPageRangeLabel,
        force_ocr: item.forceOcr,
      };
    }),
  );
}

export function useCreateGenerationTask() {
  return useMutation({
    mutationFn: async (input: CreateGenerationTaskInput) => {
      let uploadedFileMetadatas;

      try {
        input.onStageChange?.({
          title: '正在上传文件',
          description: '正在上传 PDF 和 OCR 图片到存储，请稍候。',
        });
        uploadedFileMetadatas = await uploadFilesToSupabase(input);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : '上传 PDF 或 OCR 图片到存储失败。';

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
