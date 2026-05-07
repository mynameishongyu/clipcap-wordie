'use client';

import type { PdfVisionPageInput } from '@/src/lib/pdf/client-pdf';
import { getSupabaseBrowserClient } from '@/src/lib/supabase/client';

export interface StoredPdfVisionPageAsset {
  pageNumber: number;
  originalPageNumber: number;
  storagePath: string;
  previewUrl: string;
  localPreviewUrl?: string;
  contentType: string;
  size: number;
}

function sanitizeStorageFileName(fileName: string) {
  const lastDotIndex = fileName.lastIndexOf('.');
  const baseName =
    lastDotIndex >= 0 ? fileName.slice(0, lastDotIndex) : fileName;

  const normalizedBaseName = baseName
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalizedBaseName || 'file';
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

function getImageContentTypeFromDataUrl(dataUrl: string) {
  if (dataUrl.startsWith('data:image/png')) {
    return 'image/png';
  }

  if (dataUrl.startsWith('data:image/jpeg')) {
    return 'image/jpeg';
  }

  if (dataUrl.startsWith('data:image/webp')) {
    return 'image/webp';
  }

  return 'image/png';
}

async function dataUrlToBlob(dataUrl: string) {
  const response = await fetch(dataUrl);

  if (!response.ok) {
    throw new Error('PDF 页图数据无效，无法上传到 Supabase Storage。');
  }

  return response.blob();
}

export async function uploadPdfVisionPagesToSupabase(input: {
  pdfFileName: string;
  visionPages: PdfVisionPageInput[];
  onLog?: (message: string, details?: Record<string, unknown>) => void;
}) {
  const supabase = getSupabaseBrowserClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error('请先登录后再上传 PDF 页图。');
  }

  const safeBaseName = sanitizeStorageFileName(input.pdfFileName);
  const totalPageCount = input.visionPages.length;
  const uploadedAssets: StoredPdfVisionPageAsset[] = [];

  input.onLog?.('[Template Extract][PDF Evidence][Storage] Upload started.', {
    pdfFileName: input.pdfFileName,
    pageCount: totalPageCount,
  });

  for (const [index, visionPage] of input.visionPages.entries()) {
    const blob = await dataUrlToBlob(visionPage.imageDataUrl);
    const extension = getImageExtensionFromDataUrl(visionPage.imageDataUrl);
    const storagePath =
      `${user.id}/template-extraction-ocr/${crypto.randomUUID()}-` +
      `${safeBaseName}-page-${visionPage.pageNumber}.${extension}`;
    const contentType =
      blob.type || getImageContentTypeFromDataUrl(visionPage.imageDataUrl);
    const localPreviewUrl =
      typeof URL !== 'undefined' ? URL.createObjectURL(blob) : undefined;

    input.onLog?.(
      '[Template Extract][PDF Evidence][Storage] Uploading page image.',
      {
        pdfFileName: input.pdfFileName,
        pageNumber: visionPage.pageNumber,
        index: index + 1,
        totalPageCount,
        blob,
        localPreviewUrl,
        storagePath,
        contentType,
        size: blob.size,
      },
    );

    const { error: uploadError } = await supabase.storage
      .from('generation-pdfs')
      .upload(storagePath, blob, {
        contentType,
        upsert: false,
      });

    if (uploadError) {
      throw new Error(
        `上传 PDF 页图到 Supabase Storage 失败：${uploadError.message}`,
      );
    }

    const { data: signedUrlData, error: signedUrlError } =
      await supabase.storage
        .from('generation-pdfs')
        .createSignedUrl(storagePath, 60 * 60 * 24);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      throw new Error(
        `创建 PDF 页图预览链接失败：${signedUrlError?.message ?? storagePath}`,
      );
    }

    const asset = {
      pageNumber: visionPage.pageNumber,
      originalPageNumber: visionPage.pageNumber,
      storagePath,
      previewUrl: signedUrlData.signedUrl,
      ...(localPreviewUrl ? { localPreviewUrl } : {}),
      contentType,
      size: blob.size,
    } satisfies StoredPdfVisionPageAsset;

    uploadedAssets.push(asset);
    input.onLog?.(
      '[Template Extract][PDF Evidence][Storage] Page image uploaded.',
      {
        ...asset,
        index: index + 1,
        totalPageCount,
      },
    );
  }

  input.onLog?.('[Template Extract][PDF Evidence][Storage] Upload completed.', {
    pdfFileName: input.pdfFileName,
    uploadedPageCount: uploadedAssets.length,
  });

  return uploadedAssets;
}
