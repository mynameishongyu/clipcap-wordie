import { Agent, fetch as undiciFetch } from 'undici';
import type {
  ExtractionParagraph,
  TemplatePdfEvidenceResult,
} from '@/src/app/api/types/template-slot-extraction';
import { getOptionalEnv } from '@/src/lib/llm/env';
import type { PdfVisionPageInput } from '@/src/lib/llm/fill-template-from-pdf';
import {
  callGeminiNativeChatCompletion,
  summarizeGeminiNativeRequestForTrace,
} from '@/src/lib/llm/gemini-native';
import {
  geminiTemplatePdfLocateResponseSchema,
  withProviderJsonResponseFormat,
} from '@/src/lib/llm/gemini-json-schemas';
import {
  buildJsonParseCandidates,
  extractFirstCompleteJsonValue,
} from '@/src/lib/llm/json-output';
import {
  buildChatCompletionHeaders,
  buildChatCompletionBody,
  getLlmRuntimeConfig,
  getLlmRuntimeTraceConfig,
  type LlmProvider,
} from '@/src/lib/llm/provider';
import {
  recordLlmUsageFromPayload,
  type LlmUsageAccumulator,
} from '@/src/lib/llm/usage';
import { getExtractionItemSlotKey } from '@/src/lib/templates/slot-key';

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
  | {
      type: 'gemini_file';
      gemini_file: NonNullable<PdfVisionPageInput['gemini_file']>;
    }
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
const PDF_SLOT_EXTRACTION_VISION_LLM_REASONING_EFFORT_ENV =
  'PDF_SLOT_EXTRACTION_VISION_LLM_REASONING_EFFORT';
const PDF_SLOT_EXTRACTION_LLM_OPTIONS = {
  reasoningEffortEnvName: PDF_SLOT_EXTRACTION_VISION_LLM_REASONING_EFFORT_ENV,
};
const TEMPLATE_PDF_LOCATE_MODEL_BUSY_MESSAGE = '模型繁忙，稍后再试。';

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isTemplatePdfLocateModelBusyError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes('gemini generatecontent request failed (429)') ||
    message.includes('gemini generatecontent request failed (428)') ||
    message.includes('resource_exhausted') ||
    message.includes('rate limit')
  );
}

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

function buildLlmTraceConfigPayload(
  traceConfig: ReturnType<typeof getLlmRuntimeTraceConfig>,
  extra?: Record<string, unknown>,
) {
  return {
    [traceConfig.modelEnvName]: traceConfig.model,
    [traceConfig.thinkingEnabledEnvName]: traceConfig.thinkingEnabled,
    ...(traceConfig.reasoningEffortEnvName
      ? { [traceConfig.reasoningEffortEnvName]: traceConfig.reasoningEffort }
      : {}),
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

    if (part.type === 'gemini_file') {
      return {
        type: 'gemini_file',
        gemini_file: {
          uri: part.gemini_file.uri,
          name: part.gemini_file.name ?? null,
          mime_type: part.gemini_file.mimeType,
          size_bytes: part.gemini_file.sizeBytes,
          display_name: part.gemini_file.displayName,
        },
      };
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

function splitPagesByConcurrency<T>(items: T[], concurrency: number) {
  const chunks: T[][] = [];
  const workerCount = Math.min(
    Math.max(1, concurrency),
    Math.max(1, items.length),
  );
  const chunkSize = Math.ceil(items.length / workerCount);

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
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

function buildLocalJsonRepairCandidates(rawContent: string) {
  return buildJsonParseCandidates(rawContent);
}

function buildJsonParseFailureMessage(error: unknown, rawContent: string) {
  const preview = extractFirstCompleteJsonValue(rawContent).slice(0, 240);
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
  usageAccumulator?: LlmUsageAccumulator;
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
    const requestBody = withProviderJsonResponseFormat(
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
      {
        provider: llmConfig.provider,
        model: llmConfig.model,
        name: 'template_pdf_locate_json_repair',
        schema: geminiTemplatePdfLocateResponseSchema,
      },
    );
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
        `Vision location JSON repair request failed (${upstream.status}): ${details}`,
      );
    }

    const payload = (await upstream.json()) as {
      usage?: unknown;
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    recordLlmUsageFromPayload(input.usageAccumulator, {
      phase: 'pdf_evidence_location_json_repair',
      provider: llmConfig.provider,
      model: llmConfig.model,
      requestLabel: 'template_pdf_locate_json_repair',
      payload,
    });
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
  usageAccumulator?: LlmUsageAccumulator;
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
      usageAccumulator: input.usageAccumulator,
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
          slot_key: getExtractionItemSlotKey(
            item,
            paragraphResultIndex,
            itemIndex,
          ),
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

const PDF_BBOX_SYSTEM_PROMPT_ZH =
  '你是一个精确的视觉文档版面定位助手。请在扫描 PDF 页面图片中定位给定槽位值，并按照指定的 bbox_target_mode 返回 bounding boxes。只返回紧凑且合法的 JSON，不要返回 markdown 或解释文字。如果返回的 box 与 evidence_text 在空间上不对应同一个请求值，请省略该 match。';
const PDF_BBOX_SYSTEM_PROMPT =
  'You are a precise visual document layout localization assistant. Locate the requested DOCX template slot values in scanned PDF page images, and return bounding boxes according to the specified bbox_target_mode. Return compact valid JSON only. Do not return Markdown or explanations. If a returned box is not spatially aligned with the same requested value reported in evidence_text, omit that match.';

function getProviderBboxFormatZh(provider: LlmProvider) {
  if (provider === 'qwen' || provider === 'kimi' || provider === 'doubao') {
    const providerHint =
      provider === 'doubao'
        ? '这遵循 Seed/Doubao visual grounding 语义：等价于 <bbox>x1 y1 x2 y2</bbox>，但必须以 JSON bbox_2d 返回。'
        : '使用 x-first visual-grounding 格式。';

    return {
      field: 'bbox_2d',
      coordinateSystem: `${providerHint} bbox_2d 必须是 [x1, y1, x2, y2]，相对于整张图片归一化为 0 到 999 或 0 到 1000 的整数。`,
      example: [100, 200, 400, 240],
    } as const;
  }

  if (provider === 'gemini') {
    return {
      field: 'box_2d',
      coordinateSystem:
        '使用 Gemini bounding-box 格式：box_2d 必须是 [ymin, xmin, ymax, xmax]，相对于整张图片归一化为 0 到 1000 的整数。',
      example: [200, 100, 240, 400],
    } as const;
  }

  return {
    field: 'bbox',
    coordinateSystem:
      '使用归一化 bbox object 格式：bbox 必须是 {x, y, width, height}，所有值都是相对于整张图片的 0 到 1 比例。',
    example: {
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.04,
    },
  } as const;
}

function getTargetModeRulesZh(input: {
  bboxField: string;
  targetMode: PdfBboxTargetMode;
}) {
  if (input.targetMode === 'cell') {
    return [
      `bbox_target_mode 为 "cell" 时，${input.bboxField} 应框住包含请求值的表格单元格或紧凑证据区域，而不是只框住值本身的文字笔画。`,
      `如果值位于表格中，${input.bboxField} 应尽量贴近可见单元格边界；必要时可以包含同一单元格内的 label/value 文本。`,
      '对于表格中的金额、日期、状态字段、小数字等值，优先返回完整包含该值的单元格，而不是很小的 text-only box。',
      '对于页眉、页脚、系统时间戳、截图或角落元数据，返回包含该值的局部紧凑证据区域，不要只框几个字符。',
      `${input.bboxField} 可以包含同一单元格/证据区域内的字段标签、表格边框和空白，但不能跨到相邻单元格、相邻行或无关区域。`,
      'evidence_text 应描述选中单元格或证据区域中的可见值和附近标签/上下文，例如 "overdue installment fee: 3400"。',
      `如果值处于多行单元格或证据区域，${input.bboxField} 可以覆盖整个单元格/区域，但不能包含无关的相邻单元格。`,
    ];
  }

  return [
    `bbox_target_mode 为 "text" 时，${input.bboxField} 只能框住槽位值文字本身。`,
    '不要包含姓名、性别、出生日期、地址、金额、电话、身份证号等字段标签，也不要包含附近表单标签。',
    '不要包含相邻行、相邻列、解释性文字、表格边框、印章、照片、图标或空白区域，除非值文字本身在视觉上确实需要这些区域。',
    `每个 match 都应返回围绕可见值文字的最紧凑可用 ${input.bboxField}，不要框住整行、整张卡片、整个单元格或整页。`,
    `如果值跨多行，${input.bboxField} 只可覆盖这些值所在行；如果值在单行，box 也必须停留在该行。`,
  ];
}

function getTargetModeNegativeExamplesZh(input: {
  bboxField: string;
  targetMode: PdfBboxTargetMode;
}) {
  if (input.targetMode === 'cell') {
    return [
      '对于表格金额值，如果包含它的单元格边界清晰可见，不要只框很小的金额文字笔画。',
      '对于表格单元格，不要跨到相邻行或相邻列。',
      '对于角落里的系统日期/时间，不要框整页或整个截图，只框局部角落证据区域。',
      '对于 original_value "18803308383"，不要返回 evidence_text "0311-66568703"，因为这是另一个电话号码。',
      `如果某页中 proposed ${input.bboxField} 内没有可见打印或手写的 original_value 文本，不要返回 evidence_text 等于 original_value。`,
    ];
  }

  return [
    '对于姓名值，只框人名本身，不要框“姓名”等标签。',
    '对于性别值，只框性别值本身，不要框性别标签或相邻民族值。',
    '对于出生日期，只框日期值本身，不要框出生日期标签或下一行地址。',
    '对于地址，只框地址文本本身，不要框地址标签、出生日期行、身份证号行或照片。',
    '对于 original_value "18803308383"，不要返回 evidence_text "0311-66568703"，因为这是另一个电话号码。',
    `对于 original_value "18103108407"，如果可见号码实际在右侧个人电话区域，不要返回 evidence_text "18103108407" 但把 ${input.bboxField} 框在左侧公司电话/印章区域。`,
    `如果某页中 proposed ${input.bboxField} 内没有可见打印或手写的 original_value 文本，不要返回 evidence_text 等于 original_value。`,
    `对于有多个电话标签的页面，${input.bboxField} 必须覆盖精确的电话号码字符，而不是只覆盖最近的电话标签或另一条电话行。`,
  ];
}

function buildPdfBboxLocatePromptZh(input: {
  pdfFileName: string;
  pageNumbers: number[];
  provider: LlmProvider;
  targetMode: PdfBboxTargetMode;
  slots: TemplatePdfLocateSlot[];
}) {
  const bboxFormat = getProviderBboxFormatZh(input.provider);

  return {
    task:
      input.targetMode === 'cell'
        ? '请直接在这些 PDF 页面图片中定位给定的 DOCX 槽位值。每个匹配值应返回包含它的表格单元格或紧凑证据区域。不要 OCR 整页。只返回紧凑且合法的 JSON。'
        : '请直接在这些 PDF 页面图片中定位给定的 DOCX 槽位值。不要 OCR 整页。只返回紧凑且合法的 JSON。',
    document_name: input.pdfFileName,
    page_numbers: input.pageNumbers,
    provider: input.provider,
    bbox_target_mode: input.targetMode,
    coordinate_system: bboxFormat.coordinateSystem,
    json_output_rules: [
      '只返回一个紧凑 JSON object，不要返回其他内容。',
      '响应必须以 {"matches": 开头，并且必须能被 JSON.parse 直接解析。',
      '不要使用 markdown fences、注释、解释、行前缀、尾随逗号、单引号、中文标点作为 JSON 分隔符、NaN、Infinity 或 undefined。',
      '如果没有可信匹配，返回 {"matches":[]}。',
    ],
    strict_requirements: [
      `每个 match 必须使用字段名 ${bboxFormat.field}，不要使用其他 bbox 字段名。`,
      `每个 match 必须包含 bbox_target，且值必须精确等于 "${input.targetMode}"。`,
      '只有当视觉页面图片中包含精确值或视觉上等价的值时，才返回 match。',
      '仅字段标签匹配或字段类型匹配是不够的。可见值在格式归一化后必须匹配 original_value。',
      '对于电话号码，先移除空格、连字符、括号和国家区号格式，再比较数字序列。不要因为某个号码靠近电话标签，就返回另一个电话号码。',
      '对于身份证号、日期和金额，可见值在归一化常见格式后必须匹配输入值，例如空格、逗号、中文日期单位和货币符号。',
      '对于日期，当年月日相同，中文日期文本和斜杠/短横线/点号数字格式视为等价。例如 original_value 的 year=2026、month=3、day=30，可以匹配可见文本 "2026/3/30"、"2026-3-30"、"2026.3.30"、"2026/03/30" 和 "2026-03-30"。',
      '对于日期，比较时忽略月/日的前导零，但 evidence_text 仍必须是 PDF 图片中的精确可见日期文本。',
      '如果页面包含相同标签但值不同，请从 matches 中省略该槽位。',
      `空间一致性是强制要求：${bboxFormat.field} 必须在物理位置上包含 evidence_text 中报告的精确可见值。`,
      `页面一致性是强制要求：page_number 必须是 ${bboxFormat.field} 和 evidence_text 实际可见所在的页面图片。不要从其他页面、其他槽位、记忆或文档上下文复制值。`,
      `evidence_text 只能转写同一 page_number 图片中、位于返回 ${bboxFormat.field} 内部或紧贴其边缘的可见字符。`,
      '如果 original_value 来自输入，但当前页面图片中不可见，不要把它作为该页的 evidence_text 返回。',
      `不要返回正确的 evidence_text，却把 ${bboxFormat.field} 框在另一个附近值、另一个电话号码、另一个签名块、印章、标签或空白区域上。`,
      `返回 match 前必须视觉复查 proposed ${bboxFormat.field}：如果它不包含请求的可见值，请省略该 match。`,
      `如果你能在页面某处读到该值，但不能按照 bbox_target_mode 可信地绘制 ${bboxFormat.field}，请省略该 match，不要猜 box。`,
      ...getTargetModeRulesZh({
        bboxField: bboxFormat.field,
        targetMode: input.targetMode,
      }),
      '如果同一个值出现多次，选择最符合字段标签或上下文的那个出现位置。',
      '如果精确槽位值不可见，但可见缩写或格式等价值，只定位该可见等价值，并将可见文本放入 evidence_text。',
      `evidence_text 必须是 ${bboxFormat.field} 内部或紧贴其边缘的可见文本。它应包含定位到的值，而不只是字段标签。`,
      '如果不确定，请省略 match，不要猜测。',
    ],
    negative_examples: getTargetModeNegativeExamplesZh({
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

function getProviderBboxFormat(provider: LlmProvider) {
  if (provider === 'qwen' || provider === 'kimi' || provider === 'doubao') {
    const providerHint =
      provider === 'doubao'
        ? 'This follows Seed/Doubao visual-grounding semantics: equivalent to <bbox>x1 y1 x2 y2</bbox>, but it must be returned as JSON bbox_2d.'
        : 'Use the x-first visual-grounding format.';

    return {
      field: 'bbox_2d',
      coordinateSystem: `${providerHint} bbox_2d must be [x1, y1, x2, y2], normalized against the whole image as integers from 0 to 999 or 0 to 1000.`,
      example: [100, 200, 400, 240],
    } as const;
  }

  if (provider === 'gemini') {
    return {
      field: 'box_2d',
      coordinateSystem:
        'Use Gemini bounding-box format: box_2d must be [ymin, xmin, ymax, xmax], normalized against the whole image as integers from 0 to 1000.',
      example: [200, 100, 240, 400],
    } as const;
  }

  return {
    field: 'bbox',
    coordinateSystem:
      'Use normalized bbox object format: bbox must be {x, y, width, height}; all values are ratios from 0 to 1 relative to the whole image.',
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
      `When bbox_target_mode is "cell", ${input.bboxField} should enclose the table cell or compact evidence region containing the requested value, not only the text strokes of the value itself.`,
      `If the value is in a table, ${input.bboxField} should follow the visible cell boundary as closely as possible. It may include label/value text within the same cell when needed.`,
      'For table amount, date, status, and small numeric values, prefer the complete cell containing the value instead of a tiny text-only box.',
      'For headers, footers, system timestamps, screenshots, or corner metadata, return the local compact evidence region containing the value. Do not box the whole page or whole screenshot.',
      `${input.bboxField} may include the field label, table border, and whitespace inside the same cell/evidence region, but must not cross into adjacent cells, adjacent rows, or unrelated regions.`,
      'evidence_text should describe the visible value and nearby label/context inside the selected cell or evidence region, for example "overdue installment fee: 3400".',
      `If the value is inside a multi-line cell or evidence region, ${input.bboxField} may cover the whole cell/region, but must not include unrelated adjacent cells.`,
    ];
  }

  return [
    `When bbox_target_mode is "text", ${input.bboxField} must enclose only the slot value text itself.`,
    'Do not include field labels such as name, gender, birth date, address, amount, phone, or ID number, and do not include nearby form labels.',
    'Do not include adjacent rows, adjacent columns, explanatory text, table borders, stamps, photos, icons, or blank regions unless the value text visually requires that area.',
    `Each match should return the tightest usable ${input.bboxField} around the visible value text. Do not box the whole row, whole card, whole cell, or whole page.`,
    `If the value spans multiple lines, ${input.bboxField} may cover only those value lines. If the value is on one line, the box must stay on that line.`,
  ];
}

function getTargetModeNegativeExamples(input: {
  bboxField: string;
  targetMode: PdfBboxTargetMode;
}) {
  if (input.targetMode === 'cell') {
    return [
      'For a table amount value, do not box only tiny amount text strokes when the containing cell boundary is clearly visible.',
      'For table cells, do not cross into adjacent rows or adjacent columns.',
      'For a system date/time in a corner, do not box the whole page or whole screenshot; box only the local corner evidence region.',
      'For original_value "18803308383", do not return evidence_text "0311-66568703", because that is another phone number.',
      `If the proposed ${input.bboxField} on a page does not contain visible printed or handwritten original_value text, do not return evidence_text equal to original_value.`,
    ];
  }

  return [
    'For a name value, box only the person name itself; do not box the "name" label.',
    'For a gender value, box only the gender value itself; do not box the gender label or adjacent ethnicity value.',
    'For a birth date, box only the date value itself; do not box the birth-date label or the next address line.',
    'For an address, box only the address text itself; do not box the address label, birth-date line, ID-number line, or photo.',
    'For original_value "18803308383", do not return evidence_text "0311-66568703", because that is another phone number.',
    `For original_value "18103108407", if the visible number is actually in the right-side personal phone area, do not return evidence_text "18103108407" while placing ${input.bboxField} on the left-side company phone/stamp area.`,
    `If the proposed ${input.bboxField} on a page does not contain visible printed or handwritten original_value text, do not return evidence_text equal to original_value.`,
    `For pages with multiple phone labels, ${input.bboxField} must cover the exact phone-number characters, not only the nearest phone label or another phone line.`,
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
        ? 'Directly locate the given DOCX template slot values in these PDF page images. Each matched value should return the containing table cell or compact evidence region. Do not OCR the whole page. Return compact valid JSON only.'
        : 'Directly locate the given DOCX template slot values in these PDF page images. Do not OCR the whole page. Return compact valid JSON only.',
    document_name: input.pdfFileName,
    page_numbers: input.pageNumbers,
    provider: input.provider,
    bbox_target_mode: input.targetMode,
    coordinate_system: bboxFormat.coordinateSystem,
    json_output_rules: [
      'Return exactly one compact JSON object and nothing else.',
      'The response must start with {"matches": and must be directly parseable by JSON.parse.',
      'Do not use Markdown fences, comments, explanations, line prefixes, trailing commas, single quotes, non-JSON punctuation as separators, NaN, Infinity, or undefined.',
      'If there is no trustworthy match, return {"matches":[]}.',
    ],
    strict_requirements: [
      `Each match must use the field name ${bboxFormat.field}; do not use any other bbox field name.`,
      `Each match must include bbox_target, and its value must be exactly "${input.targetMode}".`,
      'Return a match only when the visual page image contains the exact value or a visually equivalent value.',
      'Matching only the field label or field type is not sufficient. The visible value must match original_value after common format normalization.',
      'For phone numbers, first ignore spaces, hyphens, parentheses, and country-code formatting when comparing digit sequences. Do not return another phone number just because it is near a phone label.',
      'For ID numbers, dates, and amounts, the visible value must match the input value after normalizing common formatting such as spaces, commas, Chinese date units, and currency symbols.',
      'For dates, Chinese date text and slash/hyphen/dot numeric formats are equivalent when year, month, and day are the same. For example, original_value year=2026, month=3, day=30 can match visible text "2026/3/30", "2026-3-30", "2026.3.30", "2026/03/30", and "2026-03-30".',
      'For dates, ignore leading zeros in month/day during comparison, but evidence_text must still be the exact visible date text from the PDF image.',
      'If a page contains the same label with a different value, omit that slot from matches.',
      `Spatial consistency is mandatory: ${bboxFormat.field} must physically contain the exact visible value reported in evidence_text.`,
      `Page consistency is mandatory: page_number must be the page image where ${bboxFormat.field} and evidence_text are actually visible. Do not copy values from other pages, other slots, memory, or document context.`,
      `evidence_text may only transcribe visible characters on the same page_number image that are inside, or immediately adjacent to, the returned ${bboxFormat.field}.`,
      'If original_value comes from the input but is not visible in the current page image, do not return it as evidence_text for that page.',
      `Do not return correct evidence_text while placing ${bboxFormat.field} on another nearby value, another phone number, another signature block, stamp, label, or blank region.`,
      `Before returning a match, visually re-check the proposed ${bboxFormat.field}. If it does not contain the requested visible value, omit the match.`,
      `If you can read the value somewhere on the page but cannot draw a trustworthy ${bboxFormat.field} according to bbox_target_mode, omit the match instead of guessing the box.`,
      ...getTargetModeRules({
        bboxField: bboxFormat.field,
        targetMode: input.targetMode,
      }),
      'If the same value appears multiple times, choose the occurrence that best matches the field label or surrounding context.',
      'If the exact slot value is not visible but a visible abbreviation or format-equivalent value is visible, locate that visible equivalent and put the visible text in evidence_text.',
      `evidence_text must be visible text inside, or immediately adjacent to, ${bboxFormat.field}. It should include the located value, not only the field label.`,
      'If uncertain, omit the match instead of guessing.',
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
  usageAccumulator?: LlmUsageAccumulator;
}) {
  const llmConfig = getLlmRuntimeConfig(
    'vision',
    PDF_SLOT_EXTRACTION_LLM_OPTIONS,
  );
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, TEMPLATE_PDF_LOCATE_REQUEST_TIMEOUT_MS);

  const pageNumbers = input.pageBatch.map((page) => page.page_number);
  const pageSizeSummary = input.pageBatch.map((page) => {
    const imageBytes =
      page.gemini_file?.sizeBytes ?? estimateDataUrlBytes(page.image_data_url);

    return {
      label: `Page ${page.page_number}`,
      page_number: page.page_number,
      has_image_data_url: !page.gemini_file,
      has_gemini_file: Boolean(page.gemini_file),
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
    const traceConfig = getLlmRuntimeTraceConfig(
      'vision',
      PDF_SLOT_EXTRACTION_LLM_OPTIONS,
    );

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
      if (page.gemini_file) {
        content.push({
          type: 'gemini_file',
          gemini_file: page.gemini_file,
        });
      } else {
        content.push({
          type: 'image_url',
          image_url: {
            url: page.image_url ?? page.image_data_url,
          },
        });
      }
    });

    const requestBody = withProviderJsonResponseFormat(
      buildChatCompletionBody(llmConfig, {
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
      }),
      {
        provider: llmConfig.provider,
        model: llmConfig.model,
        name: 'template_pdf_locate',
        schema: geminiTemplatePdfLocateResponseSchema,
      },
    );

    let payload: {
      usage?: unknown;
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };

    if (llmConfig.provider === 'gemini') {
      const geminiResult = await callGeminiNativeChatCompletion({
        config: llmConfig,
        body: requestBody,
        requestLabel,
        dispatcher: visionLocateFetchDispatcher,
        signal: controller.signal,
        structuredOutput: {
          responseMimeType: 'application/json',
          responseSchema: geminiTemplatePdfLocateResponseSchema,
        },
        onGenerateContentRequestBody: async ({
          requestBody: geminiRequestBody,
        }) => {
          await input.onTrace?.({
            message:
              `[Template PDF Locate][VisionRequestBody][Batch ${input.pageBatchIndex + 1}/${input.totalPageBatches}] ` +
              JSON.stringify({
                route: '/api/template-extraction-tasks/[taskId]/process',
                config_scope: 'VISION_LLM',
                model: llmConfig.model,
                provider: traceConfig.provider,
                request_label: requestLabel,
                request_mode: 'gemini_native_generate_content_proxy_url',
                ...summarizeGeminiNativeRequestForTrace({
                  requestBody: geminiRequestBody,
                }),
              }),
          });
        },
        onTrace: input.onTrace,
      });

      recordLlmUsageFromPayload(input.usageAccumulator, {
        phase: 'pdf_evidence_location',
        provider: llmConfig.provider,
        model: llmConfig.model,
        requestLabel,
        payload: geminiResult.responsePayload,
      });
      payload = geminiResult.payload;
    } else {
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
              'image_url.url is summarized for browser console and storage logs; the actual VISION_LLM request keeps the original image URL.',
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

      payload = (await upstream.json()) as typeof payload;
      recordLlmUsageFromPayload(input.usageAccumulator, {
        phase: 'pdf_evidence_location',
        provider: llmConfig.provider,
        model: llmConfig.model,
        requestLabel,
        payload,
      });
    }
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
      usageAccumulator: input.usageAccumulator,
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
  usageAccumulator?: LlmUsageAccumulator;
}): Promise<TemplatePdfEvidenceResult> {
  const slots = buildLocateSlots(input.extractionResult);
  const targetMode = getTemplatePdfBboxTargetMode();
  const visionConfig = getLlmRuntimeConfig(
    'vision',
    PDF_SLOT_EXTRACTION_LLM_OPTIONS,
  );
  const visionTraceConfig = getLlmRuntimeTraceConfig(
    'vision',
    PDF_SLOT_EXTRACTION_LLM_OPTIONS,
  );
  const visionProvider = visionConfig.provider;
  const llmConcurrency = getTemplatePdfLocateLlmConcurrency();
  const pageBatches = splitPagesByConcurrency(
    input.visionPages,
    llmConcurrency,
  );

  await input.onTrace?.({
    message:
      `[Template PDF Locate] Visual location started for ${input.pdfFileName} ` +
      `(pages: ${input.visionPages.length}, batches: ${pageBatches.length}, slots: ${slots.length}, ` +
      `llm_concurrency: ${llmConcurrency}, provider: ${visionProvider}, model: ${visionConfig.model}, bbox_target_mode: ${targetMode}).`,
  });
  await input.onTrace?.({
    message:
      `[Template PDF Locate][Vision LLM Config] ` +
      JSON.stringify(
        buildLlmTraceConfigPayload(visionTraceConfig, {
          PDF_BBOX_TARGET_MODE: targetMode,
          TEMPLATE_PDF_LOCATION_LLM_CONCURRENCY: llmConcurrency,
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

  const settledBatchResults = await Promise.all(
    pageBatches.map(async (pageBatch, pageBatchIndex) => {
      try {
        const rawMatches = await locateSlotsInPageBatch({
          pdfFileName: input.pdfFileName,
          pageBatch,
          pageBatchIndex,
          totalPageBatches: pageBatches.length,
          slots,
          targetMode,
          onTrace: input.onTrace,
          usageAccumulator: input.usageAccumulator,
        });

        return { pageBatchIndex, rawMatches };
      } catch (error) {
        const failedMessage =
          `[Template PDF Locate] Visual location batch ${pageBatchIndex + 1}/${pageBatches.length} skipped after failure: ` +
          `${getErrorMessage(error)}`;
        console.error(failedMessage);
        await input.onTrace?.({ message: failedMessage });

        if (isTemplatePdfLocateModelBusyError(error)) {
          await input.onTrace?.({
            message: `[Template PDF Locate] ${TEMPLATE_PDF_LOCATE_MODEL_BUSY_MESSAGE}`,
          });
          throw new Error(TEMPLATE_PDF_LOCATE_MODEL_BUSY_MESSAGE);
        }

        return { pageBatchIndex, rawMatches: [] };
      }
    }),
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
        slot_key: slot.slot_key,
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
