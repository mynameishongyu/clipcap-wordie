import { fetch as undiciFetch } from 'undici';
import { getOptionalEnv } from '@/src/lib/llm/env';
import type { LlmRuntimeConfig } from '@/src/lib/llm/provider';

type UndiciFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;
export type GeminiFileApiDispatcher = UndiciFetchInit['dispatcher'];

export type GeminiFileApiMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | {
      type: 'gemini_file';
      gemini_file: {
        uri: string;
        name?: string | null;
        mime_type?: string | null;
        mimeType?: string | null;
        size_bytes?: number | null;
        display_name?: string | null;
      };
    };

export interface GeminiFileApiChatCompletionBody {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | GeminiFileApiMessagePart[];
  }>;
}

export interface UploadedGeminiFile {
  uri: string;
  name?: string;
  mimeType: string;
  sizeBytes: number;
  displayName: string;
}

export interface GeminiFileApiTimingSummary {
  uploadDurationMs: number;
  generateContentDurationMs: number | null;
  cleanupDurationMs: number | null;
  totalDurationMs: number;
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

function resolveGeminiApiOrigins(config: LlmRuntimeConfig) {
  const url = new URL(config.baseUrl || 'https://generativelanguage.googleapis.com');
  const origin = url.origin;

  return {
    generateBaseUrl: `${origin}/v1beta`,
    uploadBaseUrl: `${origin}/upload/v1beta`,
  };
}

function normalizeGeminiModelForPath(model: string) {
  return model.trim().replace(/^models\//, '');
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/s);

  if (!match?.[1] || !match?.[2]) {
    throw new Error('Gemini File API image input must be a data:image/... base64 URL.');
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
  dispatcher?: UndiciFetchInit['dispatcher'];
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

export async function uploadGeminiFileBytes(params: {
  config: LlmRuntimeConfig;
  buffer: Buffer;
  mimeType: string;
  displayName: string;
  dispatcher?: UndiciFetchInit['dispatcher'];
  signal?: AbortSignal;
}) {
  return uploadGeminiFileBuffer(params);
}

async function uploadGeminiFile(params: {
  config: LlmRuntimeConfig;
  dataUrl: string;
  displayName: string;
  dispatcher?: UndiciFetchInit['dispatcher'];
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
  dispatcher?: UndiciFetchInit['dispatcher'];
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
  const upstream = await undiciFetch(
    `${generateBaseUrl}/${params.file.name}`,
    {
      method: 'DELETE',
      headers: {
        'x-goog-api-key': params.config.apiKey,
      },
      dispatcher: params.dispatcher,
    } as UndiciFetchInit,
  );

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

async function cleanupGeminiFiles(params: {
  config: LlmRuntimeConfig;
  files: UploadedGeminiFile[];
  dispatcher?: UndiciFetchInit['dispatcher'];
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
  dispatcher?: UndiciFetchInit['dispatcher'];
}) {
  return cleanupGeminiFiles(params);
}

export async function uploadGeminiFilesToFileApi(params: {
  config: LlmRuntimeConfig;
  images: Array<{
    dataUrl: string;
    displayName: string;
  }>;
  requestLabel?: string;
  dispatcher?: UndiciFetchInit['dispatcher'];
  signal?: AbortSignal;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
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

function collectImageParts(body: GeminiFileApiChatCompletionBody) {
  const imageParts: Array<{
    messageIndex: number;
    partIndex: number;
    url: string;
    displayName: string;
  }> = [];

  body.messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) {
      return;
    }

    message.content.forEach((part, partIndex) => {
      if (part.type !== 'image_url') {
        return;
      }

      imageParts.push({
        messageIndex,
        partIndex,
        url: part.image_url.url,
        displayName: `vision-input-${messageIndex + 1}-${partIndex + 1}`,
      });
    });
  });

  return imageParts;
}

function buildGeminiNativeRequestBody(params: {
  body: GeminiFileApiChatCompletionBody;
  uploadedFilesByPart: Map<string, UploadedGeminiFile>;
}) {
  const systemTexts: string[] = [];
  const contents = params.body.messages
    .flatMap((message, messageIndex) => {
      if (message.role === 'system') {
        const text =
          typeof message.content === 'string'
            ? message.content
            : message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n');

        if (text.trim()) {
          systemTexts.push(text);
        }

        return [];
      }

      const parts =
        typeof message.content === 'string'
          ? [{ text: message.content }]
          : message.content.map((part, partIndex) => {
              if (part.type === 'text') {
                return { text: part.text };
              }

              if (part.type === 'gemini_file') {
                return {
                  file_data: {
                    mime_type:
                      part.gemini_file.mime_type ??
                      part.gemini_file.mimeType ??
                      'application/octet-stream',
                    file_uri: part.gemini_file.uri,
                  },
                };
              }

              const uploadedFile = params.uploadedFilesByPart.get(
                `${messageIndex}:${partIndex}`,
              );

              if (!uploadedFile) {
                throw new Error('Missing Gemini uploaded file for image part.');
              }

              return {
                file_data: {
                  mime_type: uploadedFile.mimeType,
                  file_uri: uploadedFile.uri,
                },
              };
            });

      return [
        {
          role: message.role === 'assistant' ? 'model' : 'user',
          parts,
        },
      ];
    })
    .filter((content) => content.parts.length > 0);

  return {
    ...(systemTexts.length > 0
      ? { system_instruction: { parts: [{ text: systemTexts.join('\n\n') }] } }
      : {}),
    contents,
  };
}

export async function callGeminiFileApiChatCompletion(params: {
  config: LlmRuntimeConfig;
  body: GeminiFileApiChatCompletionBody;
  requestLabel?: string;
  dispatcher?: UndiciFetchInit['dispatcher'];
  signal?: AbortSignal;
  cleanupUploadedFiles?: boolean;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  const imageParts = collectImageParts(params.body);
  const requestLabel = params.requestLabel ?? 'gemini file api vision request';
  const callStartedAt = Date.now();
  let uploadedFiles: UploadedGeminiFile[] = [];
  let requestBody: ReturnType<typeof buildGeminiNativeRequestBody> | null = null;
  let responsePayload:
    | {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      }
    | null = null;
  let cleanupResults: Awaited<ReturnType<typeof cleanupGeminiFiles>> = [];
  let uploadDurationMs = 0;
  let generateContentDurationMs: number | null = null;
  let cleanupDurationMs: number | null = null;

  try {
    const uploadStartedAt = Date.now();
    await params.onTrace?.({
      message: `[Gemini File API][UploadStart] ${JSON.stringify({
        request_label: requestLabel,
        image_count: imageParts.length,
        pipeline_concurrency: getGeminiFilePipelineConcurrency(),
      })}`,
    });
    uploadedFiles = await runWithConcurrency(
      imageParts,
      getGeminiFilePipelineConcurrency(),
      async (imagePart) =>
        uploadGeminiFile({
          config: params.config,
          dataUrl: imagePart.url,
          displayName: imagePart.displayName,
          dispatcher: params.dispatcher,
          signal: params.signal,
        }),
    );
    uploadDurationMs = Date.now() - uploadStartedAt;
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
    const uploadedFilesByPart = new Map(
      imageParts.map((imagePart, index) => [
        `${imagePart.messageIndex}:${imagePart.partIndex}`,
        uploadedFiles[index]!,
      ]),
    );
    requestBody = buildGeminiNativeRequestBody({
      body: params.body,
      uploadedFilesByPart,
    });
    await params.onTrace?.({
      message: `[Gemini File API][GenerateContentStart] ${JSON.stringify({
        request_label: requestLabel,
        model: params.config.model,
        content_count: requestBody.contents.length,
        image_count: uploadedFiles.length,
      })}`,
    });
    const { generateBaseUrl } = resolveGeminiApiOrigins(params.config);
    const generateContentStartedAt = Date.now();
    const upstream = await undiciFetch(
      `${generateBaseUrl}/models/${encodeURIComponent(
        normalizeGeminiModelForPath(params.config.model),
      )}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': params.config.apiKey,
          'Content-Type': 'application/json',
        },
        dispatcher: params.dispatcher,
        signal: params.signal,
        body: JSON.stringify(requestBody),
      } as UndiciFetchInit,
    );

    if (!upstream.ok) {
      const details = await upstream.text();
      throw new Error(
        `Gemini generateContent request failed (${upstream.status}): ${details}`,
      );
    }

    responsePayload = (await upstream.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };
    generateContentDurationMs = Date.now() - generateContentStartedAt;
    await params.onTrace?.({
      message: `[Gemini File API][GenerateContentComplete] ${JSON.stringify({
        request_label: requestLabel,
        candidate_count: responsePayload.candidates?.length ?? 0,
        text_length:
          responsePayload.candidates?.[0]?.content?.parts
            ?.map((part) => part.text ?? '')
            .join('').length ?? 0,
        generate_content_duration_ms: generateContentDurationMs,
        generate_content_duration_seconds: Number(
          (generateContentDurationMs / 1000).toFixed(2),
        ),
      })}`,
    });
  } finally {
    // Gemini File API storage is quota-limited. Each call owns these uploads,
    // so clean them up once generateContent has consumed the file_uri values.
    const shouldCleanupUploadedFiles =
      params.cleanupUploadedFiles !== false || !responsePayload;

    if (shouldCleanupUploadedFiles) {
      const cleanupStartedAt = Date.now();
      await params.onTrace?.({
        message: `[Gemini File API][CleanupStart] ${JSON.stringify({
          request_label: requestLabel,
          uploaded_file_count: uploadedFiles.length,
        })}`,
      });
      cleanupResults = await cleanupGeminiFiles({
        config: params.config,
        files: uploadedFiles,
        dispatcher: params.dispatcher,
      });
      cleanupDurationMs = Date.now() - cleanupStartedAt;
      await params.onTrace?.({
        message: `[Gemini File API][CleanupComplete] ${JSON.stringify({
          request_label: requestLabel,
          cleanup_duration_ms: cleanupDurationMs,
          cleanup_duration_seconds: Number(
            (cleanupDurationMs / 1000).toFixed(2),
          ),
          cleanup_results: summarizeCleanupResults(cleanupResults),
        })}`,
      });
    } else {
      await params.onTrace?.({
        message: `[Gemini File API][CleanupSkipped] ${JSON.stringify({
          request_label: requestLabel,
          uploaded_file_count: uploadedFiles.length,
          reason: 'caller_will_manage_uploaded_files',
        })}`,
      });
    }
  }

  const text =
    responsePayload?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('') ?? '';

  return {
    payload: {
      choices: [
        {
          message: {
            content: text,
          },
        },
      ],
    },
    requestBody,
    uploadedFiles,
    cleanupResults,
    responsePayload,
    timings: {
      uploadDurationMs,
      generateContentDurationMs,
      cleanupDurationMs,
      totalDurationMs: Date.now() - callStartedAt,
    } satisfies GeminiFileApiTimingSummary,
  };
}

function summarizeCleanupResults(
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

export function summarizeGeminiFileApiRequestForTrace(params: {
  requestBody: unknown;
  uploadedFiles: UploadedGeminiFile[];
  cleanupResults?: Awaited<ReturnType<typeof cleanupGeminiFiles>>;
}) {
  return {
    request_body: params.requestBody,
    uploaded_files: params.uploadedFiles.map((file) => ({
      uri: file.uri,
      name: file.name ?? null,
      mime_type: file.mimeType,
      size_bytes: file.sizeBytes,
      display_name: file.displayName,
    })),
    pipeline_concurrency: getGeminiFilePipelineConcurrency(),
    cleanup_results: params.cleanupResults
      ? summarizeCleanupResults(params.cleanupResults)
      : [],
  };
}
