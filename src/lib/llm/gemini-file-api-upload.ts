import { fetch as undiciFetch } from 'undici';
import { getOptionalEnv } from '@/src/lib/llm/env';
import type { LlmRuntimeConfig } from '@/src/lib/llm/provider';

type UndiciFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;
export type GeminiFileApiDispatcher = UndiciFetchInit['dispatcher'];
export type GeminiFileApiUploadStream =
  | ReadableStream<Uint8Array>
  | NodeJS.ReadableStream
  | AsyncIterable<Uint8Array>;

export interface UploadedGeminiFile {
  uri: string;
  name?: string;
  mimeType: string;
  sizeBytes: number;
  displayName: string;
}

const DEFAULT_GEMINI_FILE_PIPELINE_CONCURRENCY = 2;
const MAX_GEMINI_FILE_PIPELINE_CONCURRENCY = 20;

export function getGeminiFilePipelineConcurrency() {
  const rawValue = getOptionalEnv('PDF_GEMINI_FILE_PIPELINE_CONCURRENCY');
  const parsedValue = rawValue
    ? Number(rawValue)
    : DEFAULT_GEMINI_FILE_PIPELINE_CONCURRENCY;

  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    return DEFAULT_GEMINI_FILE_PIPELINE_CONCURRENCY;
  }

  return Math.min(MAX_GEMINI_FILE_PIPELINE_CONCURRENCY, parsedValue);
}

export async function runWithConcurrency<T, R>(
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

export function resolveGeminiApiOrigins(config: LlmRuntimeConfig) {
  const url = new URL(
    config.baseUrl || 'https://generativelanguage.googleapis.com',
  );
  const origin = url.origin;

  return {
    generateBaseUrl: `${origin}/v1beta`,
    uploadBaseUrl: `${origin}/upload/v1beta`,
  };
}

export function normalizeGeminiModelForPath(model: string) {
  return model.trim().replace(/^models\//, '');
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/s);

  if (!match?.[1] || !match?.[2]) {
    throw new Error(
      'Gemini File API image input must be a data:image/... base64 URL.',
    );
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

async function uploadGeminiFileBuffer(params: {
  config: LlmRuntimeConfig;
  buffer: Buffer;
  mimeType: string;
  displayName: string;
  dispatcher?: GeminiFileApiDispatcher;
  signal?: AbortSignal;
}) {
  const { uploadBaseUrl } = resolveGeminiApiOrigins(params.config);
  const startUpload = await undiciFetch(`${uploadBaseUrl}/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': params.config.apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(params.buffer.byteLength),
      'X-Goog-Upload-Header-Content-Type': params.mimeType,
      'Content-Type': 'application/json',
    },
    dispatcher: params.dispatcher,
    signal: params.signal,
    body: JSON.stringify({
      file: {
        display_name: params.displayName,
      },
    }),
  } as UndiciFetchInit);

  if (!startUpload.ok) {
    const details = await startUpload.text();
    throw new Error(
      `Gemini File API upload start failed (${startUpload.status}): ${details}`,
    );
  }

  const uploadUrl =
    startUpload.headers.get('x-goog-upload-url') ??
    startUpload.headers.get('X-Goog-Upload-URL');

  if (!uploadUrl) {
    throw new Error('Gemini File API upload URL is missing.');
  }

  const finishUpload = await undiciFetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(params.buffer.byteLength),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    dispatcher: params.dispatcher,
    signal: params.signal,
    body: params.buffer,
  } as UndiciFetchInit);

  if (!finishUpload.ok) {
    const details = await finishUpload.text();
    throw new Error(
      `Gemini File API upload finalize failed (${finishUpload.status}): ${details}`,
    );
  }

  const payload = (await finishUpload.json()) as {
    file?: {
      uri?: string;
      name?: string;
      mimeType?: string;
      mime_type?: string;
      sizeBytes?: string | number;
      size_bytes?: string | number;
    };
  };
  const file = payload.file;
  const uri = file?.uri;

  if (!uri) {
    throw new Error('Gemini File API response did not include file.uri.');
  }

  return {
    uri,
    name: file.name,
    mimeType: file.mimeType ?? file.mime_type ?? params.mimeType,
    sizeBytes: Number(
      file.sizeBytes ?? file.size_bytes ?? params.buffer.byteLength,
    ),
    displayName: params.displayName,
  } satisfies UploadedGeminiFile;
}

export async function uploadGeminiFileStream(params: {
  config: LlmRuntimeConfig;
  stream: GeminiFileApiUploadStream;
  sizeBytes: number;
  mimeType: string;
  displayName: string;
  dispatcher?: GeminiFileApiDispatcher;
  signal?: AbortSignal;
}) {
  const sizeBytes = Math.max(0, Math.round(params.sizeBytes));

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error(
      'Gemini File API stream upload requires a positive file size.',
    );
  }

  const { uploadBaseUrl } = resolveGeminiApiOrigins(params.config);
  const startUpload = await undiciFetch(`${uploadBaseUrl}/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': params.config.apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(sizeBytes),
      'X-Goog-Upload-Header-Content-Type': params.mimeType,
      'Content-Type': 'application/json',
    },
    dispatcher: params.dispatcher,
    signal: params.signal,
    body: JSON.stringify({
      file: {
        display_name: params.displayName,
      },
    }),
  } as UndiciFetchInit);

  if (!startUpload.ok) {
    const details = await startUpload.text();
    throw new Error(
      `Gemini File API upload start failed (${startUpload.status}): ${details}`,
    );
  }

  const uploadUrl =
    startUpload.headers.get('x-goog-upload-url') ??
    startUpload.headers.get('X-Goog-Upload-URL');

  if (!uploadUrl) {
    throw new Error('Gemini File API upload URL is missing.');
  }

  const finishUpload = await undiciFetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(sizeBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    dispatcher: params.dispatcher,
    signal: params.signal,
    body: params.stream as UndiciFetchInit['body'],
    duplex: 'half',
  } as UndiciFetchInit & { duplex: 'half' });

  if (!finishUpload.ok) {
    const details = await finishUpload.text();
    throw new Error(
      `Gemini File API upload finalize failed (${finishUpload.status}): ${details}`,
    );
  }

  const payload = (await finishUpload.json()) as {
    file?: {
      uri?: string;
      name?: string;
      mimeType?: string;
      mime_type?: string;
      sizeBytes?: string | number;
      size_bytes?: string | number;
    };
  };
  const file = payload.file;
  const uri = file?.uri;

  if (!uri) {
    throw new Error('Gemini File API response did not include file.uri.');
  }

  return {
    uri,
    name: file.name,
    mimeType: file.mimeType ?? file.mime_type ?? params.mimeType,
    sizeBytes: Number(file.sizeBytes ?? file.size_bytes ?? sizeBytes),
    displayName: params.displayName,
  } satisfies UploadedGeminiFile;
}

export async function uploadGeminiFileBytes(params: {
  config: LlmRuntimeConfig;
  buffer: Buffer;
  mimeType: string;
  displayName: string;
  dispatcher?: GeminiFileApiDispatcher;
  signal?: AbortSignal;
}) {
  return uploadGeminiFileBuffer(params);
}

export async function uploadGeminiFile(params: {
  config: LlmRuntimeConfig;
  dataUrl: string;
  displayName: string;
  dispatcher?: GeminiFileApiDispatcher;
  signal?: AbortSignal;
}) {
  const { mimeType, buffer } = parseDataUrl(params.dataUrl);

  return uploadGeminiFileBuffer({
    config: params.config,
    buffer,
    mimeType,
    displayName: params.displayName,
    dispatcher: params.dispatcher,
    signal: params.signal,
  });
}

async function deleteGeminiFile(params: {
  config: LlmRuntimeConfig;
  file: UploadedGeminiFile;
  dispatcher?: GeminiFileApiDispatcher;
}) {
  if (!params.file.name) {
    return {
      name: null,
      uri: params.file.uri,
      deleted: false,
      reason: 'missing_file_name',
    };
  }

  const { generateBaseUrl } = resolveGeminiApiOrigins(params.config);
  const upstream = await undiciFetch(`${generateBaseUrl}/${params.file.name}`, {
    method: 'DELETE',
    headers: {
      'x-goog-api-key': params.config.apiKey,
    },
    dispatcher: params.dispatcher,
  } as UndiciFetchInit);

  if (!upstream.ok) {
    const details = await upstream.text();

    return {
      name: params.file.name,
      uri: params.file.uri,
      deleted: false,
      reason: `delete_failed_${upstream.status}`,
      details,
    };
  }

  return {
    name: params.file.name,
    uri: params.file.uri,
    deleted: true,
    reason: null,
  };
}

export async function cleanupGeminiFiles(params: {
  config: LlmRuntimeConfig;
  files: UploadedGeminiFile[];
  dispatcher?: GeminiFileApiDispatcher;
}) {
  return Promise.allSettled(
    params.files.map((file) =>
      deleteGeminiFile({
        config: params.config,
        file,
        dispatcher: params.dispatcher,
      }),
    ),
  );
}

export async function cleanupGeminiUploadedFiles(params: {
  config: LlmRuntimeConfig;
  files: UploadedGeminiFile[];
  dispatcher?: GeminiFileApiDispatcher;
}) {
  return cleanupGeminiFiles(params);
}

export function summarizeCleanupResults(
  cleanupResults: Awaited<ReturnType<typeof cleanupGeminiFiles>>,
) {
  return cleanupResults.map((result) => {
    if (result.status === 'rejected') {
      return {
        deleted: false,
        reason: 'cleanup_rejected',
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      };
    }

    return result.value;
  });
}

export async function uploadGeminiFilesToFileApi(params: {
  config: LlmRuntimeConfig;
  images: Array<{
    dataUrl: string;
    displayName: string;
  }>;
  requestLabel?: string;
  dispatcher?: GeminiFileApiDispatcher;
  signal?: AbortSignal;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  if (params.images.length === 0) {
    return [] as UploadedGeminiFile[];
  }

  const requestLabel = params.requestLabel ?? 'gemini file api upload';
  const uploadStartedAt = Date.now();

  await params.onTrace?.({
    message: `[Gemini File API][UploadStart] ${JSON.stringify({
      request_label: requestLabel,
      image_count: params.images.length,
      pipeline_concurrency: getGeminiFilePipelineConcurrency(),
    })}`,
  });

  const uploadedFiles = await runWithConcurrency(
    params.images,
    getGeminiFilePipelineConcurrency(),
    async (image) =>
      uploadGeminiFile({
        config: params.config,
        dataUrl: image.dataUrl,
        displayName: image.displayName,
        dispatcher: params.dispatcher,
        signal: params.signal,
      }),
  );
  const uploadDurationMs = Date.now() - uploadStartedAt;

  await params.onTrace?.({
    message: `[Gemini File API][UploadComplete] ${JSON.stringify({
      request_label: requestLabel,
      uploaded_file_count: uploadedFiles.length,
      upload_duration_ms: uploadDurationMs,
      upload_duration_seconds: Number((uploadDurationMs / 1000).toFixed(2)),
      uploaded_files: uploadedFiles.map((file) => ({
        name: file.name ?? null,
        uri: file.uri,
        mime_type: file.mimeType,
        size_bytes: file.sizeBytes,
        display_name: file.displayName,
      })),
    })}`,
  });

  return uploadedFiles;
}
