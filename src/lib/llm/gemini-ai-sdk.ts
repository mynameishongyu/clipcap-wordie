import { createGoogleGenerativeAI } from '@ai-sdk/google';
import {
  generateObject,
  generateText,
  jsonSchema,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai';
import { parseModelJsonOutput } from '@/src/lib/llm/json-output';
import type { LlmRuntimeConfig } from '@/src/lib/llm/provider';

export type GeminiAiSdkJsonResult<T> = {
  object: T;
  rawText: string;
  usage: LanguageModelUsage | null;
  finishReason?: string;
  providerMetadata?: unknown;
  responseBody?: unknown;
  usedGenerateTextFallback: boolean;
  durationMs: number;
};

export type GeminiAiSdkTraceSource = {
  bucket?: string | null;
  storage_path?: string | null;
  page_number?: number | null;
  original_page_number?: number | null;
  mime_type?: string | null;
};

export type GeminiAiSdkConvertibleMessage = {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string }; media_type?: string }
        | {
            type: 'gemini_file';
            gemini_file: {
              uri: string;
              mime_type?: string | null;
              mimeType?: string | null;
            };
          }
      >;
};

type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

function normalizeGeminiAiSdkBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/openai\/?$/u, '').replace(/\/+$/u, '');
}

function getGeminiThinkingLevel(config: LlmRuntimeConfig) {
  const rawEffort = config.extraBody.reasoning_effort;

  if (typeof rawEffort !== 'string') {
    return null;
  }

  const normalized = rawEffort.trim().toLowerCase();

  if (
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high'
  ) {
    return normalized satisfies GeminiThinkingLevel;
  }

  return null;
}

function buildGoogleProviderOptions(config: LlmRuntimeConfig) {
  const thinkingLevel = getGeminiThinkingLevel(config);
  const googleOptions: Record<string, JSONValue> = {
    structuredOutputs: true,
  };

  if (thinkingLevel) {
    googleOptions.thinkingConfig = {
      thinkingLevel,
    };
  }

  return {
    google: googleOptions,
  };
}

function appendJsonFallbackInstruction(messages: ModelMessage[], schema: object) {
  return [
    ...messages,
    {
      role: 'user',
      content:
        'Return compact valid JSON only. The JSON must match this schema exactly: ' +
        JSON.stringify(schema),
    } satisfies ModelMessage,
  ];
}

function summarizeImageTraceSources(sources?: GeminiAiSdkTraceSource[]) {
  return (sources ?? []).map((source) => ({
    bucket: source.bucket ?? null,
    storage_path: source.storage_path ?? null,
    page_number: source.page_number ?? null,
    original_page_number: source.original_page_number ?? null,
    mime_type: source.mime_type ?? null,
  }));
}

export function convertMessagesToGeminiAiSdkMessages(
  messages: GeminiAiSdkConvertibleMessage[],
) {
  return messages.map((message) => {
    if (message.role === 'system') {
      return {
        role: 'system',
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n'),
      } satisfies ModelMessage;
    }

    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n'),
      } satisfies ModelMessage;
    }

    if (typeof message.content === 'string') {
      return {
        role: 'user',
        content: message.content,
      } satisfies ModelMessage;
    }

    return {
      role: 'user',
      content: message.content.map((part) => {
        if (part.type === 'text') {
          return {
            type: 'text',
            text: part.text,
          } as const;
        }

        if (part.type === 'gemini_file') {
          return {
            type: 'image',
            image: new URL(part.gemini_file.uri),
            mediaType:
              part.gemini_file.mime_type ??
              part.gemini_file.mimeType ??
              'image/jpeg',
          } as const;
        }

        return {
          type: 'image',
          image: new URL(part.image_url.url),
          mediaType: part.media_type ?? 'image/jpeg',
        } as const;
      }),
    } satisfies ModelMessage;
  });
}

export async function callGeminiAiSdkJson<T>(params: {
  config: LlmRuntimeConfig;
  messages: ModelMessage[];
  schema: object;
  schemaName: string;
  requestLabel: string;
  abortSignal?: AbortSignal;
  imageTraceSources?: GeminiAiSdkTraceSource[];
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  const startedAt = Date.now();
  const baseURL = normalizeGeminiAiSdkBaseUrl(params.config.baseUrl);
  const google = createGoogleGenerativeAI({
    apiKey: params.config.apiKey,
    baseURL,
  });
  const providerOptions = buildGoogleProviderOptions(params.config);
  const imageSources = summarizeImageTraceSources(params.imageTraceSources);

  await params.onTrace?.({
    message: `[Gemini AI SDK][GenerateObjectStart] ${JSON.stringify({
      request_label: params.requestLabel,
      provider_package: '@ai-sdk/google',
      model: params.config.model,
      base_url: baseURL,
      schema_name: params.schemaName,
      image_count: imageSources.length,
      image_url_mode: imageSources.length ? 'supabase_signed_url' : null,
      image_sources: imageSources,
      provider_options: providerOptions,
    })}`,
  });

  try {
    const result = await generateObject({
      model: google(params.config.model),
      messages: params.messages,
      output: 'object',
      schema: jsonSchema(
        params.schema as Parameters<typeof jsonSchema>[0],
      ),
      schemaName: params.schemaName,
      abortSignal: params.abortSignal,
      providerOptions,
    });
    const durationMs = Date.now() - startedAt;

    await params.onTrace?.({
      message: `[Gemini AI SDK][GenerateObjectComplete] ${JSON.stringify({
        request_label: params.requestLabel,
        model: params.config.model,
        finish_reason: result.finishReason,
        duration_ms: durationMs,
        usage: result.usage,
      })}`,
    });

    return {
      object: result.object as T,
      rawText: JSON.stringify(result.object),
      usage: result.usage,
      finishReason: result.finishReason,
      providerMetadata: result.providerMetadata,
      responseBody: result.response.body,
      usedGenerateTextFallback: false,
      durationMs,
    } satisfies GeminiAiSdkJsonResult<T>;
  } catch (objectError) {
    await params.onTrace?.({
      message: `[Gemini AI SDK][GenerateObjectFailed] ${JSON.stringify({
        request_label: params.requestLabel,
        model: params.config.model,
        error_message:
          objectError instanceof Error ? objectError.message : String(objectError),
        fallback: 'generateText',
      })}`,
    });

    const textResult = await generateText({
      model: google(params.config.model),
      messages: appendJsonFallbackInstruction(params.messages, params.schema),
      abortSignal: params.abortSignal,
      providerOptions: {
        google: {
          ...providerOptions.google,
          structuredOutputs: false,
        },
      },
    });
    const parsed = parseModelJsonOutput<T>(textResult.text, {
      context: `Gemini AI SDK ${params.schemaName}`,
    });
    const durationMs = Date.now() - startedAt;

    await params.onTrace?.({
      message: `[Gemini AI SDK][GenerateTextFallbackComplete] ${JSON.stringify({
        request_label: params.requestLabel,
        model: params.config.model,
        finish_reason: textResult.finishReason,
        duration_ms: durationMs,
        usage: textResult.usage,
        used_json_repair: parsed.usedRepair,
      })}`,
    });

    return {
      object: parsed.data,
      rawText: textResult.text,
      usage: textResult.usage,
      finishReason: textResult.finishReason,
      providerMetadata: textResult.providerMetadata,
      responseBody: textResult.response.body,
      usedGenerateTextFallback: true,
      durationMs,
    } satisfies GeminiAiSdkJsonResult<T>;
  }
}
