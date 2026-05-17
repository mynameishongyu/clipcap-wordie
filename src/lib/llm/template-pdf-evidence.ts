import { Agent, fetch as undiciFetch } from 'undici';
import type {
  ExtractionParagraph,
  TemplatePdfEvidenceResult,
} from '@/src/app/api/types/template-slot-extraction';
import { getOptionalEnv } from '@/src/lib/llm/env';
import type { PdfVisionPageInput } from '@/src/lib/llm/fill-template-from-pdf';
import {
  buildChatCompletionHeaders,
  buildChatCompletionBody,
  getLlmRuntimeConfig,
  getLlmRuntimeTraceConfig,
  type LlmProvider,
} from '@/src/lib/llm/provider';

type UndiciFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

interface TemplatePdfLocateSlot {
  slot_key: string;
  paragraph_result_index: number;
  item_index: number;
  sequence: number;
  paragraph_index: number | null;
  field_category: string;
  original_value: string;
  meaning_to_applicant: string;
}

interface VisionLocateCandidate {
  slot_key?: string;
  page_number?: number;
  bbox?:
    | {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      }
    | { bbox_2d?: unknown; box_2d?: unknown }
    | null;
  bbox_2d?: unknown;
  box_2d?: unknown;
  bbox_target?: string;
  evidence_text?: string;
  confidence?: number;
}

interface VisionLocateModelResponse {
  matches?: VisionLocateCandidate[];
}

type VisionMessageContentPart =
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'text'; text: string };

const visionLocateFetchDispatcher = new Agent({
  connect: {
    timeout: 30_000,
  },
});

const TEMPLATE_PDF_LOCATE_REQUEST_TIMEOUT_MS = 180_000;
const TEMPLATE_PDF_LOCATE_JSON_REPAIR_TIMEOUT_MS = 90_000;
const TEMPLATE_PDF_LOCATE_RAW_RESPONSE_TRACE_CHUNK_SIZE = 8000;
const DEFAULT_TEMPLATE_PDF_LOCATION_LLM_CONCURRENCY = 1;
const MAX_TEMPLATE_PDF_LOCATION_LLM_CONCURRENCY = 8;
const DEFAULT_TEMPLATE_PDF_LOCATION_PAGES_PER_REQUEST = 8;
const MAX_TEMPLATE_PDF_LOCATION_PAGES_PER_REQUEST = 12;

function getTemplatePdfLocateLlmConcurrency() {
  const rawValue = getOptionalEnv('TEMPLATE_PDF_LOCATION_LLM_CONCURRENCY');
  const parsedValue = rawValue
    ? Number(rawValue)
    : DEFAULT_TEMPLATE_PDF_LOCATION_LLM_CONCURRENCY;

  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    return DEFAULT_TEMPLATE_PDF_LOCATION_LLM_CONCURRENCY;
  }

  return Math.min(MAX_TEMPLATE_PDF_LOCATION_LLM_CONCURRENCY, parsedValue);
}

function getTemplatePdfLocationPagesPerRequest() {
  const rawValue = getOptionalEnv('TEMPLATE_PDF_LOCATION_PAGES_PER_REQUEST');
  const parsedValue = rawValue
    ? Number(rawValue)
    : DEFAULT_TEMPLATE_PDF_LOCATION_PAGES_PER_REQUEST;

  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    return DEFAULT_TEMPLATE_PDF_LOCATION_PAGES_PER_REQUEST;
  }

  return Math.min(MAX_TEMPLATE_PDF_LOCATION_PAGES_PER_REQUEST, parsedValue);
}

function buildLlmTraceConfigPayload(
  traceConfig: ReturnType<typeof getLlmRuntimeTraceConfig>,
  extra?: Record<string, unknown>,
) {
  return {
    [traceConfig.modelEnvName]: traceConfig.model,
    [traceConfig.thinkingEnabledEnvName]: traceConfig.thinkingEnabled,
    [traceConfig.reasoningEffortEnvName]: traceConfig.reasoningEffort,
    provider: traceConfig.provider,
    effective_extra_body: traceConfig.extraBody,
    ...extra,
  };
}

function estimateDataUrlBytes(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(',');

  if (commaIndex < 0) {
    return 0;
  }

  const base64Payload = dataUrl.slice(commaIndex + 1);
  const paddingLength = base64Payload.endsWith('==')
    ? 2
    : base64Payload.endsWith('=')
      ? 1
      : 0;

  return Math.max(
    0,
    Math.floor((base64Payload.length * 3) / 4) - paddingLength,
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function splitTraceTextIntoChunks(text: string, chunkSize: number) {
  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }

  return chunks;
}

function summarizeImageUrlForTrace(url: string) {
  if (!url.startsWith('data:')) {
    return {
      kind: 'url',
      url,
      bytes: url.length,
      size: formatBytes(url.length),
    };
  }

  const commaIndex = url.indexOf(',');
  const metadata = commaIndex >= 0 ? url.slice(0, commaIndex) : 'data:';
  const mimeTypeMatch = metadata.match(/^data:([^;]+)/);
  const base64Length =
    commaIndex >= 0 ? Math.max(0, url.length - commaIndex - 1) : 0;
  const bytes = estimateDataUrlBytes(url);

  return {
    kind: 'data_url',
    mime_type: mimeTypeMatch?.[1] ?? 'application/octet-stream',
    bytes,
    size: formatBytes(bytes),
    prefix: `${url.slice(0, Math.min(url.length, 80))}...`,
    omitted_base64_chars: Math.max(0, base64Length - 32),
  };
}

function summarizeVisionMessageContentForTrace(
  content: string | VisionMessageContentPart[],
) {
  if (typeof content === 'string') {
    return content;
  }

  return content.map((part) => {
    if (part.type === 'text') {
      return part;
    }

    return {
      type: 'image_url',
      image_url: summarizeImageUrlForTrace(part.image_url.url),
    };
  });
}

function summarizeChatCompletionBodyForTrace(
  body: ReturnType<typeof buildChatCompletionBody>,
) {
  return {
    ...body,
    messages: body.messages.map((message) => ({
      ...message,
      content: summarizeVisionMessageContentForTrace(
        message.content as string | VisionMessageContentPart[],
      ),
    })),
  };
}

function chunkItems<T>(items: T[], chunkSize: number) {
  const chunks: T[][] = [];
  const normalizedChunkSize = Math.max(1, Math.floor(chunkSize));

  for (let index = 0; index < items.length; index += normalizedChunkSize) {
    chunks.push(items.slice(index, index + normalizedChunkSize));
  }

  return chunks;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
) {
  const results: Array<R | undefined> = Array.from({ length: items.length });
  let nextIndex = 0;
  const workerCount = Math.min(
    Math.max(1, Math.floor(concurrency)),
    Math.max(1, items.length),
  );

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const currentItem = items[currentIndex];

        if (!currentItem) {
          continue;
        }

        results[currentIndex] = await worker(currentItem, currentIndex);
      }
    }),
  );

  return results.filter((result): result is R => typeof result !== 'undefined');
}

function normalizeJsonText(rawContent: string) {
  const trimmed = rawContent.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  return fencedMatch?.[1]?.trim() ?? trimmed;
}

function tryParseJson<T>(rawContent: string) {
  try {
    return {
      data: JSON.parse(rawContent) as T,
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error,
    };
  }
}

function extractJsonObjectCandidate(rawContent: string) {
  const firstBraceIndex = rawContent.indexOf('{');
  const lastBraceIndex = rawContent.lastIndexOf('}');

  if (
    firstBraceIndex < 0 ||
    lastBraceIndex < 0 ||
    lastBraceIndex <= firstBraceIndex
  ) {
    return rawContent;
  }

  return rawContent.slice(firstBraceIndex, lastBraceIndex + 1);
}

function balanceJsonClosers(rawContent: string) {
  let inString = false;
  let escaped = false;
  const stack: Array<'}' | ']'> = [];

  for (const character of rawContent) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === '\\') {
      escaped = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === '{') {
      stack.push('}');
      continue;
    }

    if (character === '[') {
      stack.push(']');
      continue;
    }

    if (character === '}' || character === ']') {
      const expected = stack.at(-1);

      if (expected === character) {
        stack.pop();
      }
    }
  }

  const withoutDanglingSeparator = rawContent.replace(/[\s,\uFF0C]+$/u, '');

  return `${withoutDanglingSeparator}${stack.reverse().join('')}`;
}

function buildLocalJsonRepairCandidates(rawContent: string) {
  const normalized = normalizeJsonText(rawContent);
  const extracted = extractJsonObjectCandidate(normalized);
  const normalizedPunctuation = extracted
    .replace(/\uFF0C/gu, ',')
    .replace(/\uFF1A/gu, ':');
  const withoutTrailingCommas = normalizedPunctuation.replace(
    /,\s*([}\]])/gu,
    '$1',
  );

  return Array.from(
    new Set([
      normalized,
      extracted,
      normalizedPunctuation,
      withoutTrailingCommas,
      balanceJsonClosers(withoutTrailingCommas),
    ]),
  );
}

function buildJsonParseFailureMessage(error: unknown, rawContent: string) {
  const preview = normalizeJsonText(rawContent).slice(0, 240);
  const reason = error instanceof Error ? error.message : String(error);

  return `Vision location JSON parse failed: ${reason}. Snippet: ${preview}`;
}

function parseModelJsonWithLocalRepair<T>(rawContent: string) {
  let lastError: unknown = null;
  const candidates = buildLocalJsonRepairCandidates(rawContent);

  for (const [candidateIndex, candidate] of candidates.entries()) {
    const parsed = tryParseJson<T>(candidate);

    if (!parsed.error) {
      return {
        data: parsed.data as T,
        usedRepair: candidateIndex > 0,
      };
    }

    lastError = parsed.error;
  }

  throw new Error(buildJsonParseFailureMessage(lastError, rawContent));
}

async function repairVisionLocationJsonWithLlm(input: {
  rawContent: string;
  parseError: Error;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  const llmConfig = getLlmRuntimeConfig('text');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, TEMPLATE_PDF_LOCATE_JSON_REPAIR_TIMEOUT_MS);

  const startedMessage =
    '[Template PDF Locate] Local JSON repair failed; requesting one LLM JSON repair pass.';
  console.info(startedMessage);
  await input.onTrace?.({ message: startedMessage });

  try {
    const upstream = await undiciFetch(llmConfig.chatCompletionsUrl, {
      method: 'POST',
      headers: buildChatCompletionHeaders(llmConfig),
      dispatcher: visionLocateFetchDispatcher,
      signal: controller.signal,
      body: JSON.stringify(
        buildChatCompletionBody(llmConfig, {
          messages: [
            {
              role: 'system',
              content:
                'You repair malformed JSON. Return compact valid JSON only. Do not add markdown, comments, explanations, or fields that were not implied by the input.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                task: 'Repair this malformed vision-location response into JSON that can be parsed by JSON.parse. Preserve all valid matches. If a trailing match is incomplete, drop only that incomplete match. Output exactly {"matches":[...]} and nothing else.',
                parse_error: input.parseError.message,
                required_schema:
                  '{"matches":[{"slot_key":"string","page_number":number,"bbox_target":"text|cell","bbox":{"x":number,"y":number,"width":number,"height":number},"box_2d":[number,number,number,number],"bbox_2d":[number,number,number,number],"evidence_text":"string","confidence":number}]}',
                malformed_json: input.rawContent,
              }),
            },
          ],
        }),
      ),
    } as UndiciFetchInit);

    if (!upstream.ok) {
      const details = await upstream.text();
      throw new Error(
        `Vision location JSON repair request failed (${upstream.status}): ${details}`,
      );
    }

    const payload = (await upstream.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    const repairedContent = payload?.choices?.[0]?.message?.content;

    if (typeof repairedContent !== 'string' || !repairedContent.trim()) {
      throw new Error('Vision location JSON repair returned empty content.');
    }

    const repaired =
      parseModelJsonWithLocalRepair<VisionLocateModelResponse>(repairedContent);
    const completedMessage = `[Template PDF Locate] LLM JSON repair completed with ${repaired.data.matches?.length ?? 0} match(es).`;
    console.info(completedMessage);
    await input.onTrace?.({ message: completedMessage });

    return repaired.data;
  } catch (error) {
    const failedMessage = `[Template PDF Locate] LLM JSON repair failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(failedMessage);
    await input.onTrace?.({ message: failedMessage });
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseVisionLocationResponse(input: {
  rawContent: string;
  pageBatchIndex: number;
  totalPageBatches: number;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  try {
    const parsed = parseModelJsonWithLocalRepair<VisionLocateModelResponse>(
      input.rawContent,
    );

    if (parsed.usedRepair) {
      const repairedMessage =
        `[Template PDF Locate] Local JSON repair completed for visual location batch ${input.pageBatchIndex + 1}/${input.totalPageBatches} ` +
        `with ${parsed.data.matches?.length ?? 0} match(es).`;
      console.info(repairedMessage);
      await input.onTrace?.({ message: repairedMessage });
    }

    return parsed.data;
  } catch (error) {
    const parseError =
      error instanceof Error ? error : new Error(String(error));

    return repairVisionLocationJsonWithLlm({
      rawContent: input.rawContent,
      parseError,
      onTrace: input.onTrace,
    });
  }
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

type PdfBboxTargetMode = 'text' | 'cell';

function getTemplatePdfBboxTargetMode(): PdfBboxTargetMode {
  const rawValue = getOptionalEnv('PDF_BBOX_TARGET_MODE')?.trim().toLowerCase();

  return rawValue === 'cell' ? 'cell' : 'text';
}

function normalizeProviderBboxCoordinate(value: unknown) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return clamp01(numericValue > 1 ? numericValue / 1000 : numericValue);
}

function normalizeXFirstBbox(box: unknown) {
  if (!Array.isArray(box) || box.length !== 4) {
    return null;
  }

  const [rawX1, rawY1, rawX2, rawY2] = box;
  const x1 = normalizeProviderBboxCoordinate(rawX1);
  const y1 = normalizeProviderBboxCoordinate(rawY1);
  const x2 = normalizeProviderBboxCoordinate(rawX2);
  const y2 = normalizeProviderBboxCoordinate(rawY2);

  if (x1 === null || y1 === null || x2 === null || y2 === null) {
    return null;
  }

  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x,
    y,
    width: clamp01(Math.min(width, 1 - x)),
    height: clamp01(Math.min(height, 1 - y)),
  };
}

function normalizeYFirstBbox(box: unknown) {
  if (!Array.isArray(box) || box.length !== 4) {
    return null;
  }

  const [rawY1, rawX1, rawY2, rawX2] = box;
  const x1 = normalizeProviderBboxCoordinate(rawX1);
  const y1 = normalizeProviderBboxCoordinate(rawY1);
  const x2 = normalizeProviderBboxCoordinate(rawX2);
  const y2 = normalizeProviderBboxCoordinate(rawY2);

  if (x1 === null || y1 === null || x2 === null || y2 === null) {
    return null;
  }

  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x,
    y,
    width: clamp01(Math.min(width, 1 - x)),
    height: clamp01(Math.min(height, 1 - y)),
  };
}

function normalizeLegacyBbox(bbox: unknown) {
  if (!bbox || typeof bbox !== 'object' || Array.isArray(bbox)) {
    return null;
  }

  const candidate = bbox as {
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
  };
  const x = clamp01(Number(candidate.x));
  const y = clamp01(Number(candidate.y));
  const width = clamp01(Number(candidate.width));
  const height = clamp01(Number(candidate.height));

  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x,
    y,
    width: clamp01(Math.min(width, 1 - x)),
    height: clamp01(Math.min(height, 1 - y)),
  };
}

function getNestedBbox(
  candidate: VisionLocateCandidate,
  fieldName: 'bbox_2d' | 'box_2d',
) {
  const bbox = candidate.bbox;

  if (!bbox || typeof bbox !== 'object' || Array.isArray(bbox)) {
    return null;
  }

  return (bbox as { bbox_2d?: unknown; box_2d?: unknown })[fieldName] ?? null;
}

function normalizeBbox(
  candidate: VisionLocateCandidate,
  provider: LlmProvider,
) {
  if (provider === 'gemini') {
    return (
      normalizeYFirstBbox(candidate.box_2d) ??
      normalizeYFirstBbox(getNestedBbox(candidate, 'box_2d')) ??
      normalizeLegacyBbox(candidate.bbox)
    );
  }

  if (provider === 'kimi' || provider === 'qwen' || provider === 'doubao') {
    return (
      normalizeXFirstBbox(candidate.bbox_2d) ??
      normalizeXFirstBbox(getNestedBbox(candidate, 'bbox_2d')) ??
      normalizeLegacyBbox(candidate.bbox)
    );
  }

  return normalizeLegacyBbox(candidate.bbox);
}

function normalizeConfidence(value: unknown) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0.5;
  }

  return clamp01(numericValue);
}

function normalizeLooseText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeDigits(value: string) {
  return value.replace(/\D/gu, '');
}

function normalizeIdentityValue(value: string) {
  return value.replace(/[^0-9x]/giu, '').toUpperCase();
}

function getPhoneVariants(value: string) {
  const digits = normalizeDigits(value);
  const variants = new Set<string>();

  if (digits) {
    variants.add(digits);
  }

  if (digits.startsWith('86') && digits.length > 11) {
    variants.add(digits.slice(2));
  }

  if (digits.startsWith('0086') && digits.length > 13) {
    variants.add(digits.slice(4));
  }

  return variants;
}

function hasMatchingVariant(leftValues: Set<string>, rightValues: Set<string>) {
  for (const leftValue of leftValues) {
    for (const rightValue of rightValues) {
      if (
        leftValue &&
        rightValue &&
        (leftValue.includes(rightValue) || rightValue.includes(leftValue))
      ) {
        return true;
      }
    }
  }

  return false;
}

function getDateCandidates(value: string) {
  const candidates = new Set<string>();
  const datePattern = /(\d{4})\D{0,4}(\d{1,2})\D{0,4}(\d{1,2})/gu;
  let match: RegExpExecArray | null;

  while ((match = datePattern.exec(value)) !== null) {
    const [, year, month, day] = match;
    const numericMonth = Number(month);
    const numericDay = Number(day);

    if (
      year &&
      numericMonth >= 1 &&
      numericMonth <= 12 &&
      numericDay >= 1 &&
      numericDay <= 31
    ) {
      candidates.add(
        `${year}${String(numericMonth).padStart(2, '0')}${String(numericDay).padStart(2, '0')}`,
      );
    }
  }

  const digits = normalizeDigits(value);

  for (let index = 0; index <= digits.length - 8; index += 1) {
    const candidate = digits.slice(index, index + 8);
    const year = Number(candidate.slice(0, 4));
    const month = Number(candidate.slice(4, 6));
    const day = Number(candidate.slice(6, 8));

    if (year >= 1900 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      candidates.add(candidate);
    }
  }

  return candidates;
}

function getAmountCandidates(value: string) {
  const normalized = value.replace(/,/gu, '');
  const candidates = new Set<string>();
  const amountPattern = /-?\d+(?:\.\d+)?/gu;
  let match: RegExpExecArray | null;

  while ((match = amountPattern.exec(normalized)) !== null) {
    const numericValue = Number(match[0]);

    if (Number.isFinite(numericValue)) {
      candidates.add(numericValue.toFixed(2));
      candidates.add(String(numericValue));
    }
  }

  return candidates;
}

function hasMatchingAmountCandidate(
  leftValues: Set<string>,
  rightValues: Set<string>,
) {
  for (const leftValue of leftValues) {
    const leftNumber = Number(leftValue);

    if (!Number.isFinite(leftNumber)) {
      continue;
    }

    for (const rightValue of rightValues) {
      const rightNumber = Number(rightValue);

      if (!Number.isFinite(rightNumber)) {
        continue;
      }

      if (Math.abs(leftNumber - rightNumber) < 0.005) {
        return true;
      }
    }
  }

  return false;
}

function isDateLikeSlot(slot: TemplatePdfLocateSlot) {
  const metadata = `${slot.field_category} ${slot.meaning_to_applicant}`;

  return (
    /(?:\u65e5\u671f|\u65f6\u95f4|\u51fa\u751f|\u7b7e\u8ba2|\u7b7e\u7f72|\u622a\u6b62|\u652f\u4ed8\u65e5|\u5e74\u6708\u65e5|date|time)/iu.test(
      metadata,
    ) || getDateCandidates(slot.original_value).size > 0
  );
}

function isIdentityLikeSlot(slot: TemplatePdfLocateSlot) {
  const metadata = `${slot.field_category} ${slot.meaning_to_applicant}`;
  const identityValue = normalizeIdentityValue(slot.original_value);

  return (
    /(?:\u8eab\u4efd\u8bc1|\u8bc1\u4ef6|\u516c\u6c11\u8eab\u4efd|\u8eab\u4efd\u53f7\u7801|id\s*number)/iu.test(
      metadata,
    ) || /^\d{15}$|^\d{17}[\dX]$/u.test(identityValue)
  );
}

function isAmountLikeSlot(slot: TemplatePdfLocateSlot) {
  const metadata = `${slot.field_category} ${slot.meaning_to_applicant}`;

  return (
    /(?:\u91d1\u989d|\u672c\u91d1|\u5229\u606f|\u8fdd\u7ea6\u91d1|\u624b\u7eed\u8d39|\u8d39\u7528|\u4ef7\u683c|\u4ef7\u6b3e|\u4eba\u6c11\u5e01|\u5143|\u6b3e)/u.test(
      metadata,
    ) ||
    /[\u00a5\uffe5\u5143]|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2}/u.test(
      slot.original_value,
    )
  );
}

function normalizeEthnicityValue(value: string) {
  return normalizeLooseText(value)
    .replace(/(?:民?族)$/u, '')
    .replace(/(?:族)$/u, '');
}

function isEthnicityLikeSlot(slot: TemplatePdfLocateSlot) {
  const metadata = `${slot.field_category} ${slot.meaning_to_applicant}`;

  return /(?:民族|族别|ethnicity|nation)/iu.test(metadata);
}

function isPhoneLikeSlot(slot: TemplatePdfLocateSlot) {
  const metadata = `${slot.field_category} ${slot.meaning_to_applicant}`;
  const digits = normalizeDigits(slot.original_value);

  return (
    /(?:\u7535\u8bdd|\u624b\u673a|\u8054\u7cfb\u65b9\u5f0f|\u8054\u7cfb\u7535\u8bdd|\u8054\u7cfb\u53f7\u7801|phone|mobile|tel)/iu.test(
      metadata,
    ) ||
    (digits.length >= 7 && digits.length <= 13 && !isDateLikeSlot(slot))
  );
}

function validateVisionEvidenceValue(input: {
  slot: TemplatePdfLocateSlot;
  candidate: VisionLocateCandidate;
}) {
  const evidenceText =
    typeof input.candidate.evidence_text === 'string'
      ? input.candidate.evidence_text.trim()
      : '';
  const originalValue = input.slot.original_value.trim();

  if (!originalValue) {
    return { valid: true, reason: 'empty_original_value' };
  }

  if (isAmountLikeSlot(input.slot)) {
    const originalAmounts = getAmountCandidates(originalValue);
    const evidenceAmounts = getAmountCandidates(evidenceText);

    return {
      valid:
        originalAmounts.size > 0 &&
        hasMatchingAmountCandidate(originalAmounts, evidenceAmounts),
      reason: 'amount_value_mismatch',
    };
  }

  if (isIdentityLikeSlot(input.slot)) {
    const originalIdentity = normalizeIdentityValue(originalValue);
    const evidenceIdentity = normalizeIdentityValue(evidenceText);

    return {
      valid:
        Boolean(evidenceIdentity) &&
        (evidenceIdentity.includes(originalIdentity) ||
          originalIdentity.includes(evidenceIdentity)),
      reason: 'identity_value_mismatch',
    };
  }

  if (isDateLikeSlot(input.slot)) {
    const originalDates = getDateCandidates(originalValue);
    const evidenceDates = getDateCandidates(evidenceText);

    return {
      valid:
        originalDates.size > 0 &&
        hasMatchingVariant(originalDates, evidenceDates),
      reason: 'date_value_mismatch',
    };
  }

  if (isPhoneLikeSlot(input.slot)) {
    const originalPhones = getPhoneVariants(originalValue);
    const evidencePhones = getPhoneVariants(evidenceText);

    return {
      valid:
        originalPhones.size > 0 &&
        hasMatchingVariant(originalPhones, evidencePhones),
      reason: 'phone_digits_mismatch',
    };
  }

  if (isEthnicityLikeSlot(input.slot)) {
    const normalizedOriginal = normalizeEthnicityValue(originalValue);
    const normalizedEvidence = normalizeEthnicityValue(evidenceText);

    return {
      valid:
        Boolean(normalizedOriginal) &&
        Boolean(normalizedEvidence) &&
        (normalizedOriginal.includes(normalizedEvidence) ||
          normalizedEvidence.includes(normalizedOriginal)),
      reason: 'ethnicity_value_mismatch',
    };
  }

  if (!evidenceText) {
    return { valid: true, reason: 'empty_evidence_text_for_generic_slot' };
  }

  const normalizedOriginal = normalizeLooseText(originalValue);
  const normalizedEvidence = normalizeLooseText(evidenceText);
  const minimumUsefulEvidenceLength = Math.min(
    normalizedOriginal.length,
    Math.max(2, Math.ceil(normalizedOriginal.length * 0.35)),
  );

  return {
    valid:
      normalizedEvidence.includes(normalizedOriginal) ||
      (normalizedEvidence.length >= minimumUsefulEvidenceLength &&
        normalizedOriginal.includes(normalizedEvidence)),
    reason: 'evidence_text_value_mismatch',
  };
}

function buildLocateSlots(extractionResult: ExtractionParagraph[]) {
  return extractionResult.flatMap((paragraph, paragraphResultIndex) =>
    paragraph.items.flatMap((item, itemIndex) => {
      const originalValue = item.original_value.trim();

      if (!originalValue) {
        return [];
      }

      return [
        {
          slot_key: `${paragraphResultIndex}-${itemIndex}-${item.sequence}`,
          paragraph_result_index: paragraphResultIndex,
          item_index: itemIndex,
          sequence: item.sequence,
          paragraph_index:
            item.paragraph_index ?? paragraph.paragraph_index ?? null,
          field_category: item.field_category,
          original_value: originalValue,
          meaning_to_applicant: item.meaning_to_applicant,
        },
      ];
    }),
  );
}

const PDF_BBOX_SYSTEM_PROMPT =
  'You are a precise visual document layout locator. Return compact valid JSON only, with no markdown or explanations. Locate visible slot values in scanned PDF page images and return bounding boxes according to the requested bbox_target_mode. If the returned box and evidence_text are not spatially related to the same requested value, omit the match.';

function getProviderBboxFormat(provider: LlmProvider) {
  if (provider === 'qwen' || provider === 'kimi' || provider === 'doubao') {
    const providerHint =
      provider === 'doubao'
        ? 'This follows Seed/Doubao visual grounding semantics: equivalent to <bbox>x1 y1 x2 y2</bbox>, but return it as JSON bbox_2d.'
        : 'Use x-first visual-grounding format.';

    return {
      field: 'bbox_2d',
      coordinateSystem: `${providerHint} bbox_2d must be [x1, y1, x2, y2], normalized to integers from 0 to 999 or 0 to 1000 relative to the full image.`,
      example: [100, 200, 400, 240],
    } as const;
  }

  if (provider === 'gemini') {
    return {
      field: 'box_2d',
      coordinateSystem:
        'Use Gemini bounding-box format: box_2d must be [ymin, xmin, ymax, xmax], normalized to integers from 0 to 1000 relative to the full image.',
      example: [200, 100, 240, 400],
    } as const;
  }

  return {
    field: 'bbox',
    coordinateSystem:
      'Use normalized bbox object format: bbox must be {x, y, width, height}, and all values must be ratios from 0 to 1 relative to the full image.',
    example: {
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.04,
    },
  } as const;
}

function getTargetModeRules(input: {
  bboxField: string;
  targetMode: PdfBboxTargetMode;
}) {
  if (input.targetMode === 'cell') {
    return [
      `bbox_target_mode is "cell": ${input.bboxField} should enclose the table cell or compact evidence region that contains the requested value, not just the value glyphs.`,
      `If the value is inside a table, ${input.bboxField} should follow the visual cell boundary as closely as possible and include the label/value text inside that same cell when useful.`,
      'For table values such as amounts, dates, status fields, and small numbers, prefer the complete containing cell over a tiny text-only box.',
      'For page headers, footers, system timestamps, screenshots, or corner metadata, return a compact local evidence region containing the value instead of only the characters.',
      `The ${input.bboxField} may include the field label, table borders, and whitespace inside the same cell/evidence region, but must not cross into adjacent cells, adjacent rows, or unrelated areas.`,
      'evidence_text should describe the visible value and nearby label/context inside the selected cell or evidence region, for example "overdue installment fee: 3400".',
      `If the value is in a multi-line cell or evidence region, ${input.bboxField} may cover that whole cell/region but must not include unrelated adjacent cells.`,
    ];
  }

  return [
    `bbox_target_mode is "text": ${input.bboxField} must enclose only the slot value text itself.`,
    'Do not include field labels such as name, gender, birth date, address, amount, phone, ID number, or nearby form labels.',
    'Do not include adjacent rows, adjacent columns, explanatory text, table borders, stamps, photos, icons, or blank whitespace unless the value text itself visually requires it.',
    `For each match, return the tightest practical ${input.bboxField} around the visible value text, not around the entire row, card, table cell, or page.`,
    `If the value spans multiple lines, ${input.bboxField} may cover those value lines only; if the value is on one line, it must stay on that line only.`,
  ];
}

function getTargetModeNegativeExamples(input: {
  bboxField: string;
  targetMode: PdfBboxTargetMode;
}) {
  if (input.targetMode === 'cell') {
    return [
      'For a table amount value, do not box only the tiny amount glyphs if the containing table cell boundary is visible.',
      'For a table cell, do not cross into the adjacent row or adjacent column.',
      'For a corner system date/time, do not box the whole page or the whole screenshot; box only the local corner evidence region.',
      'For original_value "18803308383", never return evidence_text "0311-66568703" because it is a different phone number.',
      `Never return evidence_text equal to original_value on a page where that text is not visibly printed or handwritten inside the proposed ${input.bboxField}.`,
    ];
  }

  return [
    'For a name value, box only the person name, not the name label.',
    'For a gender value, box only the gender value, not the gender label or neighboring nationality value.',
    'For a birth date, box only the date value, not the birth-date label or the address line below it.',
    'For an address, box only the address text, not the address label, birth date line, ID number line, or photo.',
    'For original_value "18803308383", never return evidence_text "0311-66568703" because it is a different phone number.',
    `For original_value "18103108407", never return evidence_text "18103108407" with ${input.bboxField} around the left-side company phone/stamp area if the visible number is actually on the right-side person phone area.`,
    `Never return evidence_text equal to original_value on a page where that text is not visibly printed or handwritten inside the proposed ${input.bboxField}.`,
    `For pages with multiple phone labels, ${input.bboxField} must cover the exact phone number characters, not merely the nearest phone label or a different phone line.`,
  ];
}

function buildPdfBboxLocatePrompt(input: {
  pdfFileName: string;
  pageNumbers: number[];
  provider: LlmProvider;
  targetMode: PdfBboxTargetMode;
  slots: TemplatePdfLocateSlot[];
}) {
  const bboxFormat = getProviderBboxFormat(input.provider);

  return {
    task:
      input.targetMode === 'cell'
        ? 'Locate the provided DOCX slot values directly on these PDF page images. Return the containing table cell or compact evidence region for each matched value. Do not OCR the whole page. Return compact valid JSON only.'
        : 'Locate the provided DOCX slot values directly on these PDF page images. Do not OCR the whole page. Return compact valid JSON only.',
    document_name: input.pdfFileName,
    page_numbers: input.pageNumbers,
    provider: input.provider,
    bbox_target_mode: input.targetMode,
    coordinate_system: bboxFormat.coordinateSystem,
    json_output_rules: [
      'Return exactly one compact JSON object and nothing else.',
      'The response must start with {"matches": and must be directly parseable by JSON.parse.',
      'Do not use markdown fences, comments, explanations, line prefixes, trailing commas, single quotes, Chinese punctuation as JSON delimiters, NaN, Infinity, or undefined.',
      'If there are no confident matches, return {"matches":[]}.',
    ],
    strict_requirements: [
      `Every match must use the field named ${bboxFormat.field}. Do not use any other bbox field name.`,
      `Every match must include bbox_target with the exact value "${input.targetMode}".`,
      'Only return a match when the visual page image contains the exact value or a visually equivalent value.',
      'A matching field label or matching field type is not enough. The visible value must match original_value after normalizing formatting.',
      'For phone numbers, compare digit sequences after removing spaces, hyphens, parentheses, and country-code formatting. Do not return a different phone number just because it is near a phone label.',
      'For ID numbers, dates, and amounts, the visible value must match the input value after normalizing common formatting such as spaces, commas, Chinese date units, and currency symbols.',
      'For dates, treat Chinese date text and numeric slash/dash/dot formats as equivalent when the year, month, and day are the same. For example, original_value with year=2026, month=3, day=30 matches visible text "2026/3/30", "2026-3-30", "2026.3.30", "2026/03/30", and "2026-03-30".',
      'For dates, ignore leading zeros in month/day during comparison, but evidence_text must still be the exact visible date text from the PDF image.',
      'If the page contains the same label but a different value, omit that slot from matches.',
      `Spatial consistency is mandatory: ${bboxFormat.field} must physically contain the exact visible value reported in evidence_text.`,
      `Page consistency is mandatory: page_number must be the page image where ${bboxFormat.field} and evidence_text are visibly present. Do not copy a value from another page, another slot, memory, or document context.`,
      `evidence_text must be transcribed only from the visible characters inside or immediately touching the returned ${bboxFormat.field} on the same page_number image.`,
      'If original_value is known from the input but is not visibly present on the current page image, do not return it as evidence_text for that page.',
      `Do not return a correct evidence_text with ${bboxFormat.field} around another nearby value, another phone number, another signature block, a stamp, a label, or blank space.`,
      `Before returning a match, visually re-check the proposed ${bboxFormat.field}: if it does not contain the requested visible value, omit the match.`,
      `If you can read the value somewhere on the page but cannot confidently draw ${bboxFormat.field} according to bbox_target_mode, omit the match instead of guessing a box.`,
      ...getTargetModeRules({
        bboxField: bboxFormat.field,
        targetMode: input.targetMode,
      }),
      'If a value appears multiple times, choose the occurrence that best matches the field label or context.',
      'If the exact slot value is not visible but a shortened or formatted equivalent is visible, locate only that visible equivalent and put the visible text in evidence_text.',
      `evidence_text must be the visible text inside or immediately touching ${bboxFormat.field}. It should include the located value, not just the field label.`,
      'If you are unsure, omit the match instead of guessing.',
    ],
    negative_examples: getTargetModeNegativeExamples({
      bboxField: bboxFormat.field,
      targetMode: input.targetMode,
    }),
    slots: input.slots.map((slot) => ({
      slot_key: slot.slot_key,
      field_category: slot.field_category,
      original_value: slot.original_value,
      meaning_to_applicant: slot.meaning_to_applicant,
    })),
    output_schema: {
      matches: [
        {
          slot_key: 'slot key from input slots',
          page_number: 'one of the provided page_numbers',
          bbox_target: input.targetMode,
          [bboxFormat.field]: bboxFormat.example,
          evidence_text: 'short visible text around the located value',
          confidence: 0.85,
        },
      ],
    },
  };
}

async function locateSlotsInPageBatch(input: {
  pdfFileName: string;
  pageBatch: PdfVisionPageInput[];
  pageBatchIndex: number;
  totalPageBatches: number;
  slots: TemplatePdfLocateSlot[];
  targetMode: PdfBboxTargetMode;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  const llmConfig = getLlmRuntimeConfig('vision');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, TEMPLATE_PDF_LOCATE_REQUEST_TIMEOUT_MS);

  const pageNumbers = input.pageBatch.map((page) => page.page_number);
  const pageSizeSummary = input.pageBatch.map((page) => {
    const imageBytes = estimateDataUrlBytes(page.image_data_url);

    return {
      label: `Page ${page.page_number}`,
      page_number: page.page_number,
      has_image_data_url: true,
      image_bytes: imageBytes,
      image_size: formatBytes(imageBytes),
    };
  });
  const totalImageBytes = pageSizeSummary.reduce(
    (sum, page) => sum + page.image_bytes,
    0,
  );
  const startedMessage =
    `[Template PDF Locate] Starting visual location batch ${input.pageBatchIndex + 1}/${input.totalPageBatches} ` +
    `for ${input.pdfFileName} (pages: ${pageNumbers.join(', ')}, slots: ${input.slots.length}).`;
  console.info(startedMessage);
  await input.onTrace?.({ message: startedMessage });

  try {
    const promptPayload = buildPdfBboxLocatePrompt({
      pdfFileName: input.pdfFileName,
      pageNumbers,
      provider: llmConfig.provider,
      targetMode: input.targetMode,
      slots: input.slots,
    });
    const requestLabel = `visual location batch ${input.pageBatchIndex + 1}/${input.totalPageBatches}`;
    const traceConfig = getLlmRuntimeTraceConfig('vision');

    await input.onTrace?.({
      message:
        `[Template PDF Locate][VisionPrompt][Batch ${input.pageBatchIndex + 1}/${input.totalPageBatches}] ` +
        JSON.stringify({
          route: '/api/template-extraction-tasks/[taskId]/process',
          config_scope: 'VISION_LLM',
          model: llmConfig.model,
          provider: traceConfig.provider,
          request_label: requestLabel,
          page_numbers: pageNumbers,
          slot_count: input.slots.length,
          image_payload: {
            uploaded_pdf_page_count: pageSizeSummary.length,
            uploaded_pdf_image_total_bytes: totalImageBytes,
            uploaded_pdf_image_total_size: formatBytes(totalImageBytes),
          },
          messages: [
            {
              role: 'system',
              content: PDF_BBOX_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: promptPayload,
            },
          ],
          image_placeholders: pageSizeSummary,
        }),
    });

    const content: VisionMessageContentPart[] = [
      {
        type: 'text',
        text: JSON.stringify(promptPayload),
      },
    ];

    input.pageBatch.forEach((page) => {
      content.push({
        type: 'text',
        text: `Page ${page.page_number}`,
      });
      content.push({
        type: 'image_url',
        image_url: {
          url: page.image_data_url,
        },
      });
    });

    const requestBody = buildChatCompletionBody(llmConfig, {
      messages: [
        {
          role: 'system',
          content: PDF_BBOX_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content,
        },
      ],
    });

    await input.onTrace?.({
      message:
        `[Template PDF Locate][VisionRequestBody][Batch ${input.pageBatchIndex + 1}/${input.totalPageBatches}] ` +
        JSON.stringify({
          route: '/api/template-extraction-tasks/[taskId]/process',
          config_scope: 'VISION_LLM',
          model: llmConfig.model,
          provider: traceConfig.provider,
          request_label: requestLabel,
          request_body: summarizeChatCompletionBodyForTrace(requestBody),
          image_url_note:
            'image_url.url is summarized for browser console and storage logs; the actual VISION_LLM request uses the full data:image/... base64 URL.',
        }),
    });

    const upstream = await undiciFetch(llmConfig.chatCompletionsUrl, {
      method: 'POST',
      headers: buildChatCompletionHeaders(llmConfig),
      dispatcher: visionLocateFetchDispatcher,
      signal: controller.signal,
      body: JSON.stringify(requestBody),
    } as UndiciFetchInit);

    if (!upstream.ok) {
      const details = await upstream.text();
      throw new Error(
        `Vision location request failed (${upstream.status}): ${details}`,
      );
    }

    const payload = (await upstream.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    const rawContent = payload?.choices?.[0]?.message?.content;

    if (typeof rawContent !== 'string' || !rawContent.trim()) {
      return [] as VisionLocateCandidate[];
    }

    const rawResponseChunks = splitTraceTextIntoChunks(
      rawContent,
      TEMPLATE_PDF_LOCATE_RAW_RESPONSE_TRACE_CHUNK_SIZE,
    );

    for (const [chunkIndex, rawResponseChunk] of rawResponseChunks.entries()) {
      await input.onTrace?.({
        message:
          `[Template PDF Locate][LLM Raw Response][Batch ${input.pageBatchIndex + 1}/${input.totalPageBatches}][Chunk ${chunkIndex + 1}/${rawResponseChunks.length}] ` +
          JSON.stringify({
            pdf_file_name: input.pdfFileName,
            page_numbers: pageNumbers,
            raw_response_chunk: rawResponseChunk,
            raw_response_length: rawContent.length,
            chunk_index: chunkIndex + 1,
            total_chunks: rawResponseChunks.length,
          }),
      });
    }

    const normalized = await parseVisionLocationResponse({
      rawContent,
      pageBatchIndex: input.pageBatchIndex,
      totalPageBatches: input.totalPageBatches,
      onTrace: input.onTrace,
    });

    await input.onTrace?.({
      message:
        `[Template PDF Locate][LLM Parsed Matches][Batch ${input.pageBatchIndex + 1}/${input.totalPageBatches}] ` +
        JSON.stringify({
          pdf_file_name: input.pdfFileName,
          page_numbers: pageNumbers,
          matches: normalized.matches ?? [],
        }),
    });

    const completedMessage =
      `[Template PDF Locate] Completed visual location batch ${input.pageBatchIndex + 1}/${input.totalPageBatches} ` +
      `for ${input.pdfFileName} with ${normalized.matches?.length ?? 0} raw match(es).`;
    console.info(completedMessage);
    await input.onTrace?.({ message: completedMessage });

    return normalized.matches ?? [];
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function buildTemplatePdfEvidence(input: {
  pdfFileName: string;
  extractionResult: ExtractionParagraph[];
  visionPages: PdfVisionPageInput[];
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}): Promise<TemplatePdfEvidenceResult> {
  const slots = buildLocateSlots(input.extractionResult);
  const targetMode = getTemplatePdfBboxTargetMode();
  const visionConfig = getLlmRuntimeConfig('vision');
  const visionTraceConfig = getLlmRuntimeTraceConfig('vision');
  const visionProvider = visionConfig.provider;
  const llmConcurrency = getTemplatePdfLocateLlmConcurrency();
  const pagesPerRequest = getTemplatePdfLocationPagesPerRequest();
  const pageBatches = chunkItems(
    input.visionPages,
    pagesPerRequest,
  );

  await input.onTrace?.({
    message:
      `[Template PDF Locate] Visual location started for ${input.pdfFileName} ` +
      `(pages: ${input.visionPages.length}, batches: ${pageBatches.length}, slots: ${slots.length}, ` +
      `pages_per_request: ${pagesPerRequest}, llm_concurrency: ${llmConcurrency}, provider: ${visionProvider}, ` +
      `model: ${visionConfig.model}, bbox_target_mode: ${targetMode}).`,
  });
  await input.onTrace?.({
    message:
      `[Template PDF Locate][Vision LLM Config] ` +
      JSON.stringify(
        buildLlmTraceConfigPayload(visionTraceConfig, {
          PDF_BBOX_TARGET_MODE: targetMode,
          TEMPLATE_PDF_LOCATION_LLM_CONCURRENCY: llmConcurrency,
          TEMPLATE_PDF_LOCATION_PAGES_PER_REQUEST: pagesPerRequest,
        }),
      ),
  });

  const slotByKey = new Map(slots.map((slot) => [slot.slot_key, slot]));
  const pageNumberSet = new Set(
    input.visionPages.map((page) => page.page_number),
  );
  const matchesBySlotKey = new Map<
    string,
    TemplatePdfEvidenceResult['matches'][number]
  >();

  const settledBatchResults = await runWithConcurrency(
    pageBatches,
    llmConcurrency,
    async (pageBatch, pageBatchIndex) => {
      try {
        const rawMatches = await locateSlotsInPageBatch({
          pdfFileName: input.pdfFileName,
          pageBatch,
          pageBatchIndex,
          totalPageBatches: pageBatches.length,
          slots,
          targetMode,
          onTrace: input.onTrace,
        });

        return { pageBatchIndex, rawMatches };
      } catch (error) {
        const failedMessage =
          `[Template PDF Locate] Visual location batch ${pageBatchIndex + 1}/${pageBatches.length} skipped after failure: ` +
          `${error instanceof Error ? error.message : String(error)}`;
        console.error(failedMessage);
        await input.onTrace?.({ message: failedMessage });
        return { pageBatchIndex, rawMatches: [] };
      }
    },
  );

  for (const { rawMatches } of settledBatchResults) {
    for (const candidate of rawMatches) {
      const slotKey = String(candidate.slot_key ?? '');
      const slot = slotByKey.get(slotKey);
      const pageNumber = Number(candidate.page_number);
      const bbox = normalizeBbox(candidate, visionProvider);

      if (
        !slot ||
        !Number.isInteger(pageNumber) ||
        !pageNumberSet.has(pageNumber) ||
        !bbox
      ) {
        continue;
      }

      const validation = validateVisionEvidenceValue({ slot, candidate });

      if (!validation.valid) {
        const rejectedMessage =
          `[Template PDF Locate] Rejected visual match for ${slot.field_category} slot_key=${slot.slot_key} because ${validation.reason}: ` +
          `original="${slot.original_value}", evidence="${typeof candidate.evidence_text === 'string' ? candidate.evidence_text.trim() : ''}", page=${pageNumber}.`;
        console.warn(rejectedMessage);
        await input.onTrace?.({ message: rejectedMessage });
        continue;
      }

      const nextMatch = {
        paragraph_result_index: slot.paragraph_result_index,
        item_index: slot.item_index,
        sequence: slot.sequence,
        paragraph_index: slot.paragraph_index,
        field_category: slot.field_category,
        original_value: slot.original_value,
        page_number: pageNumber,
        bbox,
        evidence_text:
          typeof candidate.evidence_text === 'string'
            ? candidate.evidence_text.trim()
            : '',
        confidence: normalizeConfidence(candidate.confidence),
        match_type: 'vision_bbox' as const,
      };
      const previousMatch = matchesBySlotKey.get(slotKey);

      if (!previousMatch || nextMatch.confidence > previousMatch.confidence) {
        matchesBySlotKey.set(slotKey, nextMatch);
      }
    }
  }

  const matches = Array.from(matchesBySlotKey.values());

  await input.onTrace?.({
    message:
      `[Template PDF Locate] Visual location completed for ${input.pdfFileName}: ` +
      `${matches.length}/${slots.length} slot value(s) located with bounding boxes.`,
  });

  return {
    pdf_file_name: input.pdfFileName,
    pdf_pages: [],
    matches,
  };
}
