import { fetch as undiciFetch } from 'undici';
import type { LlmRuntimeConfig } from '@/src/lib/llm/provider';

type UndiciFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;
type GeminiNativeDispatcher = UndiciFetchInit['dispatcher'];

type GeminiNativeMessagePart =
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

interface GeminiNativeChatCompletionBody {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | GeminiNativeMessagePart[];
  }>;
}

interface GeminiNativeStructuredOutputConfig {
  responseMimeType: 'application/json';
  responseSchema?: unknown;
}

function toGeminiResponseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => toGeminiResponseSchema(item));
  }

  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const source = schema as Record<string, unknown>;
  const converted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === 'type') {
      const rawType = Array.isArray(value)
        ? value.find((entry) => entry !== 'null')
        : value;

      converted.type =
        typeof rawType === 'string' ? rawType.toUpperCase() : rawType;
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      converted.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([propertyKey, propertySchema]) => [
            propertyKey,
            toGeminiResponseSchema(propertySchema),
          ],
        ),
      );
      continue;
    }

    converted[key] = toGeminiResponseSchema(value);
  }

  return converted;
}

function resolveGeminiGenerateBaseUrl(config: LlmRuntimeConfig) {
  const url = new URL(config.baseUrl || 'https://generativelanguage.googleapis.com');

  return `${url.origin}/v1beta`;
}

function normalizeGeminiModelForPath(model: string) {
  return model.trim().replace(/^models\//, '');
}

function parseDataImageUrl(url: string) {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s);

  if (!match?.[1] || !match?.[2]) {
    throw new Error('Gemini native image_url must be a data:image/... base64 URL.');
  }

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function buildGeminiNativeRequestBody(
  body: GeminiNativeChatCompletionBody,
  structuredOutput?: GeminiNativeStructuredOutputConfig,
) {
  const systemTexts: string[] = [];
  const contents = body.messages
    .flatMap((message) => {
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
          : message.content.map((part: GeminiNativeMessagePart) => {
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

              const image = parseDataImageUrl(part.image_url.url);

              return {
                inline_data: {
                  mime_type: image.mimeType,
                  data: image.data,
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
    ...(structuredOutput
      ? {
          generationConfig: {
            response_mime_type: structuredOutput.responseMimeType,
            ...(structuredOutput.responseSchema
              ? {
                  response_schema: toGeminiResponseSchema(
                    structuredOutput.responseSchema,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
}

type GeminiNativeRequestBody = ReturnType<typeof buildGeminiNativeRequestBody>;

export async function callGeminiNativeChatCompletion(params: {
  config: LlmRuntimeConfig;
  body: GeminiNativeChatCompletionBody;
  requestLabel?: string;
  dispatcher?: GeminiNativeDispatcher;
  signal?: AbortSignal;
  structuredOutput?: GeminiNativeStructuredOutputConfig;
  onGenerateContentRequestBody?: (entry: {
    requestBody: GeminiNativeRequestBody;
  }) => Promise<void> | void;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  const requestLabel = params.requestLabel ?? 'gemini native vision request';
  const callStartedAt = Date.now();
  const requestBody = buildGeminiNativeRequestBody(
    params.body,
    params.structuredOutput,
  );

  await params.onGenerateContentRequestBody?.({ requestBody });
  await params.onTrace?.({
    message: `[Gemini Native][GenerateContentStart] ${JSON.stringify({
      request_label: requestLabel,
      model: params.config.model,
      content_count: requestBody.contents.length,
      structured_output: params.structuredOutput
        ? {
            response_mime_type: params.structuredOutput.responseMimeType,
            has_response_schema: Boolean(params.structuredOutput.responseSchema),
          }
        : null,
    })}`,
  });

  const generateBaseUrl = resolveGeminiGenerateBaseUrl(params.config);
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

  const responsePayload = (await upstream.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };
  const generateContentDurationMs = Date.now() - generateContentStartedAt;

  await params.onTrace?.({
    message: `[Gemini Native][GenerateContentComplete] ${JSON.stringify({
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

  const text =
    responsePayload.candidates?.[0]?.content?.parts
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
    responsePayload,
    timings: {
      generateContentDurationMs,
      totalDurationMs: Date.now() - callStartedAt,
    },
  };
}

export function summarizeGeminiNativeRequestForTrace(params: {
  requestBody: unknown;
}) {
  return {
    request_body: params.requestBody,
  };
}
