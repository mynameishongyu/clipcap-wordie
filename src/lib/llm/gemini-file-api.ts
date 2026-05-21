import { fetch as undiciFetch } from 'undici';
import type { LlmRuntimeConfig } from '@/src/lib/llm/provider';
import {
  cleanupGeminiFiles,
  getGeminiFilePipelineConcurrency,
  normalizeGeminiModelForPath,
  resolveGeminiApiOrigins,
  runWithConcurrency,
  summarizeCleanupResults,
  uploadGeminiFile,
  type GeminiFileApiDispatcher,
  type UploadedGeminiFile,
} from '@/src/lib/llm/gemini-file-api-upload';

export {
  cleanupGeminiUploadedFiles,
  getGeminiFilePipelineConcurrency,
  uploadGeminiFileBytes,
  uploadGeminiFilesToFileApi,
} from '@/src/lib/llm/gemini-file-api-upload';
export type {
  GeminiFileApiDispatcher,
  UploadedGeminiFile,
} from '@/src/lib/llm/gemini-file-api-upload';

type UndiciFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

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

export interface GeminiFileApiTimingSummary {
  uploadDurationMs: number;
  generateContentDurationMs: number | null;
  cleanupDurationMs: number | null;
  totalDurationMs: number;
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

type GeminiNativeRequestBody = ReturnType<typeof buildGeminiNativeRequestBody>;

export async function callGeminiFileApiChatCompletion(params: {
  config: LlmRuntimeConfig;
  body: GeminiFileApiChatCompletionBody;
  requestLabel?: string;
  dispatcher?: UndiciFetchInit['dispatcher'];
  signal?: AbortSignal;
  cleanupUploadedFiles?: boolean;
  onGenerateContentRequestBody?: (entry: {
    requestBody: GeminiNativeRequestBody;
    uploadedFiles: UploadedGeminiFile[];
  }) => Promise<void> | void;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  const imageParts = collectImageParts(params.body);
  const requestLabel = params.requestLabel ?? 'gemini file api vision request';
  const callStartedAt = Date.now();
  let uploadedFiles: UploadedGeminiFile[] = [];
  let requestBody: GeminiNativeRequestBody | null = null;
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
    if (imageParts.length > 0) {
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
    }

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
    await params.onGenerateContentRequestBody?.({
      requestBody,
      uploadedFiles,
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

    if (uploadedFiles.length > 0 && shouldCleanupUploadedFiles) {
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
    } else if (uploadedFiles.length > 0) {
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
