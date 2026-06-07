'use client';

export type ClientGeminiFileReference = {
  uri: string;
  name?: string | null;
  mime_type: string;
  size_bytes?: number | null;
  display_name?: string | null;
  uploaded_at?: string | null;
};

export type GeminiFileUploadConfig = {
  provider: string;
  model: string;
  enabled: boolean;
  concurrency: number;
};

async function parseJsonResponse<T>(response: Response) {
  const rawText = await response.text();

  if (!rawText) {
    return null as T | null;
  }

  try {
    return JSON.parse(rawText) as T;
  } catch {
    return null as T | null;
  }
}

export async function getBrowserGeminiFileUploadConfig() {
  const response = await fetch('/api/gemini-file-uploads', {
    method: 'GET',
    cache: 'no-store',
  });
  const payload = await parseJsonResponse<{
    data?: GeminiFileUploadConfig;
    message?: string;
  }>(response);

  if (!response.ok || !payload?.data) {
    throw new Error(payload?.message ?? 'Failed to load Gemini upload config.');
  }

  return payload.data;
}

export async function uploadBrowserImageToGeminiFileApi(input: {
  blob: Blob;
  displayName: string;
  pageNumber?: number | null;
  originalPageNumber?: number | null;
  storagePath?: string | null;
  fileName?: string | null;
}) {
  const startedAt = performance.now();

  console.info('[Gemini File API][BrowserUploadStart]', {
    displayName: input.displayName,
    fileName: input.fileName ?? null,
    pageNumber: input.pageNumber ?? null,
    originalPageNumber: input.originalPageNumber ?? null,
    storagePath: input.storagePath ?? null,
    contentType: input.blob.type || 'application/octet-stream',
    sizeBytes: input.blob.size,
  });

  const response = await fetch('/api/gemini-file-uploads', {
    method: 'POST',
    headers: {
      'Content-Type': input.blob.type || 'application/octet-stream',
      'x-file-size': String(input.blob.size),
      'x-display-name': input.displayName,
    },
    body: input.blob,
  });
  const payload = await parseJsonResponse<{
    data?: { file?: ClientGeminiFileReference };
    message?: string;
  }>(response);
  const durationMs = performance.now() - startedAt;

  if (!response.ok || !payload?.data?.file) {
    const message =
      payload?.message ?? `Gemini File API upload failed: ${response.status}`;

    console.error('[Gemini File API][BrowserUploadFailed]', {
      displayName: input.displayName,
      fileName: input.fileName ?? null,
      pageNumber: input.pageNumber ?? null,
      originalPageNumber: input.originalPageNumber ?? null,
      storagePath: input.storagePath ?? null,
      durationMs: Math.round(durationMs),
      errorMessage: message,
    });

    throw new Error(message);
  }

  console.info('[Gemini File API][BrowserUploadComplete]', {
    displayName: input.displayName,
    fileName: input.fileName ?? null,
    pageNumber: input.pageNumber ?? null,
    originalPageNumber: input.originalPageNumber ?? null,
    storagePath: input.storagePath ?? null,
    durationMs: Math.round(durationMs),
    fileNameOnGemini: payload.data.file.name ?? null,
    fileUri: payload.data.file.uri,
    mimeType: payload.data.file.mime_type,
    sizeBytes: payload.data.file.size_bytes ?? null,
  });

  return payload.data.file;
}

export async function cleanupBrowserGeminiFiles(
  files: ClientGeminiFileReference[],
) {
  const cleanupFiles = files.filter((file) => file.name && file.uri);

  if (cleanupFiles.length === 0) {
    return;
  }

  await fetch('/api/gemini-file-uploads', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files: cleanupFiles }),
  }).catch((error) => {
    console.warn('[Gemini File API][BrowserCleanupFailed]', {
      fileCount: cleanupFiles.length,
      error,
    });
  });
}
