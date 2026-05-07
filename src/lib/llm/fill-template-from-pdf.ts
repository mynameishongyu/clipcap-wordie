import { z } from 'zod';
import { Agent, fetch as undiciFetch } from 'undici';
import { getTextLlmModel, getVisionLlmModel } from '@/src/lib/llm/env';
import {
  buildChatCompletionBody,
  getLlmRuntimeConfig,
} from '@/src/lib/llm/provider';

export interface GenerationSlotSchemaItem {
  slot_key: string;
  field_category: string;
  meaning_to_applicant: string;
}

export interface PdfPageInput {
  page_number: number;
  text: string;
}

export interface PdfVisionPageInput {
  page_number: number;
  image_data_url: string;
  original_page_number?: number;
}

interface ModelMatch {
  value?: string;
  snippet?: string;
  page_number?: number | null;
}

interface ModelResultCandidate {
  slot_key?: string;
  slot_name?: string;
  final_value?: string;
  matches?: ModelMatch[];
}

const generationExtractedItemSchema = z.object({
  slot_key: z.string(),
  field_category: z.string(),
  meaning_to_applicant: z.string(),
  original_value: z.string(),
  evidence: z.string().nullable().optional(),
  evidence_page_numbers: z.array(z.number().int()).optional().default([]),
  notes: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

const generationPdfFillResultSchema = z.object({
  document_summary: z.string().nullable().optional(),
  extracted_items: z
    .array(generationExtractedItemSchema)
    .optional()
    .default([]),
});

const PDF_SLOT_FILL_TEXT_TIMEOUT_BASE_MS = 120000;
const PDF_SLOT_FILL_TEXT_TIMEOUT_PER_PAGE_MS = 20000;
const PDF_SLOT_FILL_TEXT_TIMEOUT_PER_1000_CHARS_MS = 20000;
const PDF_SLOT_FILL_TEXT_TIMEOUT_MAX_MS = 300000;
const MAX_TEXT_REQUEST_RETRIES = 2;
const PDF_SLOT_FILL_VISION_TIMEOUT_BASE_MS = 300000;
const PDF_SLOT_FILL_VISION_TIMEOUT_PER_PAGE_MS = 15000;
const PDF_SLOT_FILL_VISION_TIMEOUT_PER_SLOT_MS = 20000;
const PDF_SLOT_FILL_VISION_TIMEOUT_MAX_MS = 300000;
const MAX_VISION_REQUEST_RETRIES = 2;
const MAX_TEXT_PAGES_PER_CHUNK = 8;
const MAX_TEXT_CHARS_PER_CHUNK = 12000;
const MAX_VISION_PAGES_PER_REQUEST = 2;
const MAX_VISION_OCR_BATCH_CONCURRENCY = 6;
const MAX_TEXT_SLOT_BATCH_CONCURRENCY = 2;
const MAX_TEXT_SLOTS_PER_REQUEST = 10;
const PROCESS_HARD_TIMEOUT_MS = 300000;
const PROCESS_OCR_SLOT_FILL_RESERVE_MS = 60000;
const LLM_CONNECT_TIMEOUT_MS = 60000;
const PROCESS_ROUTE_FINALIZATION_RESERVE_MS = 15000;
type UndiciFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;
const llmFetchDispatcher = new Agent({
  connect: {
    timeout: LLM_CONNECT_TIMEOUT_MS,
  },
});

function normalizeJsonText(rawContent: string) {
  const trimmed = rawContent.trim();
  const withoutCodeFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (withoutCodeFence.startsWith('{') || withoutCodeFence.startsWith('[')) {
    return withoutCodeFence;
  }

  const firstBrace = withoutCodeFence.indexOf('{');
  const lastBrace = withoutCodeFence.lastIndexOf('}');

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return withoutCodeFence.slice(firstBrace, lastBrace + 1);
  }

  return withoutCodeFence;
}

function repairCommonJsonBarewords(rawJson: string) {
  return rawJson
    .replace(
      /(:\s*)(无|空|未知|未提及|未找到|暂无|缺失|没有)(?=\s*[,}\]])/g,
      '$1null',
    )
    .replace(
      /([\[,]\s*)(无|空|未知|未提及|未找到|暂无|缺失|没有)(?=\s*[,}\]])/g,
      '$1null',
    );
}

function escapeControlCharactersInsideJsonStrings(rawJson: string) {
  let result = '';
  let inString = false;
  let escaping = false;

  for (let index = 0; index < rawJson.length; index += 1) {
    const char = rawJson[index]!;

    if (escaping) {
      result += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      result += char;
      escaping = true;
      continue;
    }

    if (char === '"') {
      result += char;
      inString = !inString;
      continue;
    }

    if (inString) {
      if (char === '\n') {
        result += '\\n';
        continue;
      }

      if (char === '\r') {
        result += '\\r';
        continue;
      }

      if (char === '\t') {
        result += '\\t';
        continue;
      }

      const code = char.charCodeAt(0);

      if (code >= 0 && code <= 0x1f) {
        result += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
    }

    result += char;
  }

  return result;
}

function parseModelJson<T>(rawContent: string): T {
  const normalized = normalizeJsonText(rawContent);
  const repaired = escapeControlCharactersInsideJsonStrings(
    repairCommonJsonBarewords(normalized),
  );

  try {
    return JSON.parse(repaired) as T;
  } catch (error) {
    const preview = repaired.slice(0, 240);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Model JSON parse failed: ${reason}. Snippet: ${preview}`);
  }
}

function normalizeSlotIdentifier(value: string | null | undefined) {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。,、“”"'`（）()\[\]【】{}<>《》\-_/]/g, '');
}

function findResultForSlot(
  slot: GenerationSlotSchemaItem,
  results: ModelResultCandidate[] | undefined,
  options?: { fallbackToSingleResult?: boolean },
) {
  if (!results?.length) {
    return null;
  }

  const normalizedSlotKey = normalizeSlotIdentifier(slot.slot_key);
  const normalizedSlotName = normalizeSlotIdentifier(slot.field_category);

  const bySlotKey = results.find(
    (candidate) =>
      normalizeSlotIdentifier(candidate.slot_key) === normalizedSlotKey,
  );

  if (bySlotKey) {
    return bySlotKey;
  }

  const byExactName = results.find(
    (candidate) =>
      normalizeSlotIdentifier(candidate.slot_name) === normalizedSlotName,
  );

  if (byExactName) {
    return byExactName;
  }

  const byLooseName = results.find((candidate) => {
    const normalizedCandidateName = normalizeSlotIdentifier(
      candidate.slot_name,
    );

    return (
      Boolean(normalizedCandidateName) &&
      (normalizedCandidateName.includes(normalizedSlotName) ||
        normalizedSlotName.includes(normalizedCandidateName))
    );
  });

  if (byLooseName) {
    return byLooseName;
  }

  if (options?.fallbackToSingleResult && results.length === 1) {
    return results[0] ?? null;
  }

  return null;
}

function formatElapsedMs(ms: number) {
  const seconds = (ms / 1000).toFixed(2);
  return `${seconds}s`;
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

function formatOcrTraceText(text: string) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const escaped = normalized.replace(/\n/g, '\\n');

  if (escaped.length <= 1500) {
    return escaped;
  }

  return `${escaped.slice(0, 1500)}...(truncated)`;
}

function stringifyTraceJson(value: unknown) {
  return JSON.stringify(value);
}

export function buildTextSlotFillPromptPayload(input: {
  documentName: string;
  slots: GenerationSlotSchemaItem[];
  pageNumbers: number[];
  chunkText: string;
}) {
  return {
    document_name: input.documentName,
    slot_names: input.slots.map((slot) => slot.field_category),
    slot_definitions: input.slots.map((slot) => ({
      slot_key: slot.slot_key,
      slot_name: slot.field_category,
      slot_meaning:
        slot.meaning_to_applicant || getSlotSemanticHint(slot.field_category),
    })),
    strict_requirement:
      'Return the exact same slot_key copied from slot_definitions. final_value must be the exact value used for filling. The first match.value must equal final_value. The first match.snippet must contain final_value as a direct quote from the PDF text chunk. For any date field, always return the final_value in Chinese date format like 2026年1月14日. Do not return date values as 2026-01-14, 2026/01/14, or 2026.01.14.',
    page_numbers: input.pageNumbers,
    content: input.chunkText,
    output_schema: {
      results: input.slots.map((slot) => ({
        slot_key: slot.slot_key,
        slot_name: slot.field_category,
        final_value: 'final extracted value',
        matches: [
          {
            value: 'matched value',
            snippet: 'short supporting quote from the PDF text',
            page_number: 1,
          },
        ],
      })),
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeNetworkError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.message];
  const cause = (error as Error & { cause?: unknown }).cause;

  if (cause && typeof cause === 'object') {
    const causeRecord = cause as Record<string, unknown>;
    const causeParts: string[] = [];

    if (typeof causeRecord.code === 'string') {
      causeParts.push(`code=${causeRecord.code}`);
    }

    if (typeof causeRecord.errno === 'number') {
      causeParts.push(`errno=${causeRecord.errno}`);
    }

    if (typeof causeRecord.syscall === 'string') {
      causeParts.push(`syscall=${causeRecord.syscall}`);
    }

    if (typeof causeRecord.address === 'string') {
      causeParts.push(`address=${causeRecord.address}`);
    }

    if (typeof causeRecord.port === 'number') {
      causeParts.push(`port=${causeRecord.port}`);
    }

    if (typeof causeRecord.host === 'string') {
      causeParts.push(`host=${causeRecord.host}`);
    }

    if (
      typeof causeRecord.message === 'string' &&
      causeRecord.message !== error.message
    ) {
      causeParts.push(`cause=${causeRecord.message}`);
    }

    if (causeParts.length > 0) {
      parts.push(`(${causeParts.join(', ')})`);
    }
  }

  return parts.join(' ');
}

function wrapFetchFailure(
  error: unknown,
  input: {
    stage: 'vision-ocr' | 'text-slot-fill';
    documentName: string;
    model: string;
    baseUrl: string;
    attempt: number;
  },
) {
  if (!(error instanceof Error)) {
    return error;
  }

  if (!error.message.includes('fetch failed')) {
    return error;
  }

  return new Error(
    `${input.stage} upstream fetch failed for ${input.documentName} ` +
      `(model=${input.model}, baseUrl=${input.baseUrl}, attempt=${input.attempt}): ${describeNetworkError(error)}`,
  );
}

function getVisionRequestTimeoutMs(input: {
  pageCount: number;
  slotCount: number;
  attempt: number;
}) {
  const computedTimeout =
    PDF_SLOT_FILL_VISION_TIMEOUT_BASE_MS +
    input.pageCount * PDF_SLOT_FILL_VISION_TIMEOUT_PER_PAGE_MS +
    input.slotCount * PDF_SLOT_FILL_VISION_TIMEOUT_PER_SLOT_MS +
    (input.attempt - 1) * 60000;

  return Math.min(computedTimeout, PDF_SLOT_FILL_VISION_TIMEOUT_MAX_MS);
}

function getTextRequestTimeoutMs(input: {
  pageCount: number;
  charCount: number;
  attempt: number;
}) {
  const computedTimeout =
    PDF_SLOT_FILL_TEXT_TIMEOUT_BASE_MS +
    input.pageCount * PDF_SLOT_FILL_TEXT_TIMEOUT_PER_PAGE_MS +
    Math.ceil(input.charCount / 1000) *
      PDF_SLOT_FILL_TEXT_TIMEOUT_PER_1000_CHARS_MS +
    (input.attempt - 1) * 30000;

  return Math.min(computedTimeout, PDF_SLOT_FILL_TEXT_TIMEOUT_MAX_MS);
}

function shouldRetryVisionRequest(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes('fetch failed') ||
    error.message.includes('Vision model request failed (429)') ||
    error.message.includes('Vision model request failed (500)') ||
    error.message.includes('Vision model request failed (502)') ||
    error.message.includes('Vision model request failed (503)') ||
    error.message.includes('Vision model request failed (504)')
  );
}

function shouldRetryTextRequest(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes('fetch failed') ||
    error.message.includes('Text model request failed (429)') ||
    error.message.includes('Text model request failed (500)') ||
    error.message.includes('Text model request failed (502)') ||
    error.message.includes('Text model request failed (503)') ||
    error.message.includes('Text model request failed (504)')
  );
}

function getSlotSemanticHint(slotName: string) {
  if (slotName.includes('身份证')) {
    return 'Target field is a Chinese identity card number or certificate number.';
  }

  if (
    slotName.includes('电话') ||
    slotName.includes('手机') ||
    slotName.includes('联系')
  ) {
    return 'Target field is a contact phone number or mobile number.';
  }

  if (slotName.includes('出生')) {
    return 'Target field is a birth date.';
  }

  if (slotName.includes('住址') || slotName.includes('地址')) {
    return 'Target field is an address or residence.';
  }

  return 'Find the value that best matches the meaning of this slot.';
}

function getSlotKeywords(slotName: string) {
  const base = [
    slotName,
    '被申请人',
    '被告',
    '借款人',
    '乙方',
    '客户',
    '共同借款人',
  ];

  if (slotName.includes('身份证')) {
    return [...base, '身份证', '公民身份号码', '身份证号', '证件号码'];
  }

  if (
    slotName.includes('电话') ||
    slotName.includes('手机') ||
    slotName.includes('联系')
  ) {
    return [...base, '电话', '手机', '联系电话', '联系方式', '手机号'];
  }

  if (slotName.includes('出生')) {
    return [...base, '出生', '出生日期', '生日', '生于'];
  }

  if (slotName.includes('住址') || slotName.includes('地址')) {
    return [
      ...base,
      '住址',
      '地址',
      '住所地',
      '联系地址',
      '通讯地址',
      '户籍地址',
    ];
  }

  return base;
}

function scorePageForSlot(slotName: string, page: PdfPageInput) {
  const keywords = getSlotKeywords(slotName);
  let score = 0;

  for (const keyword of keywords) {
    if (page.text.includes(keyword)) {
      score += keyword === slotName ? 4 : 1;
    }
  }

  if (
    page.text.includes('身份证') ||
    page.text.includes('借款人') ||
    page.text.includes('客户') ||
    page.text.includes('申请人') ||
    page.text.includes('姓名') ||
    page.text.includes('地址') ||
    page.text.includes('电话')
  ) {
    score += 1;
  }

  return score;
}

function buildSlotContexts(slotName: string, pages: PdfPageInput[]) {
  const rankedPages = pages
    .map((page) => ({
      page,
      score: scorePageForSlot(slotName, page),
    }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.page.page_number - right.page.page_number,
    );

  const sourcePages =
    rankedPages.length > 0 ? rankedPages.map((item) => item.page) : pages;
  const orderedPages = [...sourcePages].sort(
    (left, right) => left.page_number - right.page_number,
  );
  const contexts: Array<{ pageNumbers: number[]; chunkText: string }> = [];
  let currentPages: number[] = [];
  let currentText = '';

  const flush = () => {
    if (!currentPages.length || !currentText.trim()) {
      return;
    }

    contexts.push({
      pageNumbers: [...currentPages],
      chunkText: currentText.trim(),
    });
    currentPages = [];
    currentText = '';
  };

  for (const page of orderedPages) {
    const pageText = `[Page ${page.page_number}]\n${page.text}\n`;

    if (
      currentPages.length >= MAX_TEXT_PAGES_PER_CHUNK ||
      currentText.length + pageText.length > MAX_TEXT_CHARS_PER_CHUNK
    ) {
      flush();
    }

    currentPages.push(page.page_number);
    currentText += pageText;
  }

  flush();
  return contexts;
}

async function extractSlotWithTextModel(input: {
  documentName: string;
  slot: GenerationSlotSchemaItem;
  pageNumbers: number[];
  chunkText: string;
}) {
  for (let attempt = 1; attempt <= MAX_TEXT_REQUEST_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      getTextRequestTimeoutMs({
        pageCount: input.pageNumbers.length,
        charCount: input.chunkText.length,
        attempt,
      }),
    );

    try {
      const llmConfig = getLlmRuntimeConfig('text');
      const upstream = await undiciFetch(llmConfig.chatCompletionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        dispatcher: llmFetchDispatcher,
        signal: controller.signal,
        body: JSON.stringify(
          buildChatCompletionBody(llmConfig, {
            messages: [
              {
                role: 'system',
                content:
                  'You are a PDF slot filling assistant. Extract only the current slot from the provided PDF text chunk. Return JSON only.',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  document_name: input.documentName,
                  slot_key: input.slot.slot_key,
                  slot_name: input.slot.field_category,
                  slot_hint:
                    input.slot.meaning_to_applicant ||
                    getSlotSemanticHint(input.slot.field_category),
                  strict_requirement:
                    'Return the exact same slot_key in results[0].slot_key. final_value must be the exact value used for filling. matches[0].value must equal final_value. matches[0].snippet must contain final_value as a direct quote from the PDF text chunk.',
                  page_numbers: input.pageNumbers,
                  content: input.chunkText,
                  output_schema: {
                    results: [
                      {
                        slot_key: input.slot.slot_key,
                        slot_name: input.slot.field_category,
                        final_value: 'final extracted value',
                        matches: [
                          {
                            value: 'matched value',
                            snippet: 'short supporting quote from the PDF text',
                            page_number: 1,
                          },
                        ],
                      },
                    ],
                  },
                }),
              },
            ],
          }),
        ),
      } as UndiciFetchInit);

      if (!upstream.ok) {
        const details = await upstream.text();
        throw new Error(
          `Text model request failed (${upstream.status}): ${details}`,
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
        return {
          extracted_items: [],
          document_summary: '',
        };
      }

      const normalized = parseModelJson<{
        results?: ModelResultCandidate[];
      }>(rawContent);

      const firstResult = findResultForSlot(input.slot, normalized.results, {
        fallbackToSingleResult: true,
      });
      const firstMatch = firstResult?.matches?.find(
        (match) =>
          typeof match?.value === 'string' &&
          Boolean(match.value.trim()) &&
          typeof match?.snippet === 'string' &&
          Boolean(match.snippet.trim()),
      );

      if (!firstResult && !firstMatch) {
        return {
          extracted_items: [],
          document_summary: '',
        };
      }

      const extractedValue = resolveExtractedValue(
        input.slot,
        firstResult,
        firstMatch,
      );

      return {
        document_summary: '',
        extracted_items: [
          {
            slot_key: input.slot.slot_key,
            field_category: input.slot.field_category,
            meaning_to_applicant: input.slot.meaning_to_applicant,
            original_value: extractedValue,
            evidence: resolveEvidenceSnippet(extractedValue, firstMatch),
            evidence_page_numbers:
              typeof firstMatch?.page_number === 'number'
                ? [firstMatch.page_number]
                : input.pageNumbers,
            notes: '',
            confidence: null,
          },
        ],
      };
    } catch (error) {
      const normalizedError = wrapFetchFailure(error, {
        stage: 'text-slot-fill',
        documentName: input.documentName,
        model: getLlmRuntimeConfig('text').model,
        baseUrl: getLlmRuntimeConfig('text').baseUrl,
        attempt,
      });
      const shouldRetry =
        attempt < MAX_TEXT_REQUEST_RETRIES && shouldRetryTextRequest(error);

      if (!shouldRetry) {
        if (
          normalizedError instanceof DOMException &&
          normalizedError.name === 'AbortError'
        ) {
          throw new Error(
            'Text slot extraction timed out after multiple attempts.',
          );
        }

        throw normalizedError;
      }

      await sleep(1500 * attempt);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error('Text slot extraction failed after multiple attempts.');
}

async function extractTextFromVisionPages(input: {
  documentName: string;
  visionPages: PdfVisionPageInput[];
  totalVisionPages?: number;
  batchIndex?: number;
  totalBatches?: number;
  processStartedAtMs?: number;
  processHardTimeoutMs?: number;
  processReserveMs?: number;
  onTrace?: (trace: { message: string }) => Promise<void> | void;
}) {
  for (let attempt = 1; attempt <= MAX_VISION_REQUEST_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const batchStartedAt = Date.now();
    const requestTimeoutMs = getVisionRequestTimeoutMs({
      pageCount: input.visionPages.length,
      slotCount: 1,
      attempt,
    });
    const pageSizeSummary = input.visionPages.map((page) => ({
      pageNumber: page.page_number,
      bytes: estimateDataUrlBytes(page.image_data_url),
    }));
    const totalImageBytes = pageSizeSummary.reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
    let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;
    let budgetAbortTriggered = false;

    try {
      const batchLabel =
        typeof input.batchIndex === 'number' &&
        typeof input.totalBatches === 'number'
          ? `batch ${input.batchIndex + 1}/${input.totalBatches}`
          : 'batch';
      const startingBudgetSnapshot = getProcessBudgetSnapshot({
        processStartedAtMs: input.processStartedAtMs,
        processHardTimeoutMs: input.processHardTimeoutMs,
      });

      if (
        startingBudgetSnapshot &&
        startingBudgetSnapshot.remainingBudgetMs <=
          (input.processReserveMs ?? PROCESS_OCR_SLOT_FILL_RESERVE_MS)
      ) {
        throw new Error(
          'Skipping OCR batch because remaining /process budget is too low; continuing to slot fill with OCR pages that already succeeded.',
        );
      }
      const batchStartedMessage =
        `[PDF Fill][OCR] Starting ${batchLabel} for ${input.documentName} ` +
        `(attempt ${attempt}/${MAX_VISION_REQUEST_RETRIES}, pages: ${input.visionPages
          .map((page) => page.page_number)
          .join(
            ',',
          )}, vision pages: ${input.totalVisionPages ?? input.visionPages.length}, concurrency: ${MAX_VISION_OCR_BATCH_CONCURRENCY}, each_concurrency_size: ${MAX_VISION_PAGES_PER_REQUEST}, current_batch_size: ${input.visionPages.length}, timeout: ${formatElapsedMs(requestTimeoutMs)}, total image size: ${formatBytes(totalImageBytes)}, page image sizes: ${pageSizeSummary
          .map((entry) => `${entry.pageNumber}=${formatBytes(entry.bytes)}`)
          .join('; ')}${formatProcessBudgetSuffix({
          processStartedAtMs: input.processStartedAtMs,
          processHardTimeoutMs: input.processHardTimeoutMs,
        })}).`;
      console.info(batchStartedMessage);
      await input.onTrace?.({ message: batchStartedMessage });
      heartbeatIntervalId = setInterval(() => {
        const elapsedMs = Date.now() - batchStartedAt;
        const budgetSnapshot = getProcessBudgetSnapshot({
          processStartedAtMs: input.processStartedAtMs,
          processHardTimeoutMs: input.processHardTimeoutMs,
        });

        if (
          budgetSnapshot &&
          !budgetAbortTriggered &&
          budgetSnapshot.remainingBudgetMs <=
            (input.processReserveMs ?? PROCESS_OCR_SLOT_FILL_RESERVE_MS)
        ) {
          budgetAbortTriggered = true;
          const budgetAbortMessage =
            `[PDF Fill][OCR] Aborting ${batchLabel} for ${input.documentName} early ` +
            `to preserve ${formatElapsedMs(
              input.processReserveMs ?? PROCESS_OCR_SLOT_FILL_RESERVE_MS,
            )} for slot fill (process elapsed: ${formatElapsedMs(
              budgetSnapshot.totalElapsedMs,
            )}, remaining /process budget: ${formatElapsedMs(
              budgetSnapshot.remainingBudgetMs,
            )}).`;
          console.warn(budgetAbortMessage);
          void input.onTrace?.({ message: budgetAbortMessage });
          controller.abort();
          return;
        }

        const heartbeatMessage =
          `[PDF Fill][OCR] Waiting on ${batchLabel} for ${input.documentName} ` +
          `(attempt ${attempt}/${MAX_VISION_REQUEST_RETRIES}, vision pages: ${input.totalVisionPages ?? input.visionPages.length}, concurrency: ${MAX_VISION_OCR_BATCH_CONCURRENCY}, each_concurrency_size: ${MAX_VISION_PAGES_PER_REQUEST}, current_batch_size: ${input.visionPages.length}, elapsed: ${formatElapsedMs(elapsedMs)} / timeout: ${formatElapsedMs(requestTimeoutMs)}, total image size: ${formatBytes(totalImageBytes)}${formatProcessBudgetSuffix(
            {
              processStartedAtMs: input.processStartedAtMs,
              processHardTimeoutMs: input.processHardTimeoutMs,
            },
          )}).`;
        console.info(heartbeatMessage);
        void input.onTrace?.({ message: heartbeatMessage });
      }, 15000);

      const content: Array<
        | { type: 'image_url'; image_url: { url: string } }
        | { type: 'text'; text: string }
      > = [];

      content.push({
        type: 'text',
        text: JSON.stringify({
          task: 'Please OCR every provided PDF page image into clean plain text. Return JSON only. Keep page_number exactly as provided. Preserve visible text order as much as possible. Do not summarize. Do not omit visible numbers, dates, money amounts, ID numbers, account numbers, contract numbers, page numbers, or table cell values. For screenshot-like pages and management-system pages, carefully transcribe every visible field label and its numeric value, even when the value is short, isolated, or appears inside a table row.',
          document_name: input.documentName,
          page_numbers: input.visionPages.map((page) => page.page_number),
          strict_requirements: [
            'Every visible digit sequence must be preserved exactly, including decimal points, commas, slashes, hyphens, and date separators.',
            'Do not skip numeric values that appear after labels such as 客户编号, 证件号码, 放款金额, 放款日期, 到期日期, 本金余额, 利息余额, 罚息余额, 合计, 最近还款日期, 最近还款金额, 下次还款日期, 下次还款金额.',
            'If a page contains a table, preserve each visible row in reading order and keep adjacent numeric values on the same line as their labels or row entries whenever possible.',
          ],
          output_schema: {
            pages: input.visionPages.map((page) => ({
              page_number: page.page_number,
              text: 'plain text OCR result for this page',
            })),
          },
        }),
      });

      input.visionPages.forEach((page) => {
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

      const llmConfig = getLlmRuntimeConfig('vision');
      const upstream = await undiciFetch(llmConfig.chatCompletionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        dispatcher: llmFetchDispatcher,
        signal: controller.signal,
        body: JSON.stringify(
          buildChatCompletionBody(llmConfig, {
            messages: [
              {
                role: 'system',
                content:
                  'You are an OCR assistant for scanned PDF pages, screenshots, and financial system interfaces. Return JSON only. Be extremely careful with small digits, dates, amounts, identifiers, and table values. Never omit visible numeric content.',
              },
              {
                role: 'user',
                content,
              },
            ],
          }),
        ),
      } as UndiciFetchInit);

      if (!upstream.ok) {
        const details = await upstream.text();
        throw new Error(
          `Vision model request failed (${upstream.status}): ${details}`,
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
        return [] as PdfPageInput[];
      }

      const normalized = parseModelJson<{
        pages?: Array<{
          page_number?: number;
          text?: string;
        }>;
      }>(rawContent);
      const originalPageNumberByUploadedPageNumber = new Map(
        input.visionPages.map((page) => [
          page.page_number,
          page.original_page_number ?? page.page_number,
        ]),
      );

      const ocrPages = (normalized.pages ?? [])
        .filter(
          (page): page is { page_number: number; text: string } =>
            typeof page.page_number === 'number' &&
            typeof page.text === 'string',
        )
        .map((page) => ({
          page_number: page.page_number,
          text: page.text.trim(),
          original_page_number:
            originalPageNumberByUploadedPageNumber.get(page.page_number) ??
            page.page_number,
        }));

      const batchElapsedMs = Date.now() - batchStartedAt;
      const batchCompletedMessage =
        `[PDF Fill][OCR] Completed ${batchLabel} for ${input.documentName} ` +
        `(attempt ${attempt}, vision pages: ${input.totalVisionPages ?? input.visionPages.length}, concurrency: ${MAX_VISION_OCR_BATCH_CONCURRENCY}, each_concurrency_size: ${MAX_VISION_PAGES_PER_REQUEST}, current_batch_size: ${input.visionPages.length}) with ${ocrPages.length} OCR text pages in ${formatElapsedMs(batchElapsedMs)}, total image size: ${formatBytes(totalImageBytes)}${formatProcessBudgetSuffix(
          {
            processStartedAtMs: input.processStartedAtMs,
            processHardTimeoutMs: input.processHardTimeoutMs,
          },
        )}).`;
      console.info(batchCompletedMessage);
      await input.onTrace?.({ message: batchCompletedMessage });
      for (const page of ocrPages) {
        const pageTraceDataMessage = `[PDF Fill][OCR][PageData ${page.page_number}] ${stringifyTraceJson(
          {
            original_page_number: page.original_page_number ?? page.page_number,
            text: page.text,
          },
        )}`;
        console.info(pageTraceDataMessage);
        await input.onTrace?.({ message: pageTraceDataMessage });
      }

      return ocrPages;
    } catch (error) {
      const normalizedError = wrapFetchFailure(error, {
        stage: 'vision-ocr',
        documentName: input.documentName,
        model: getLlmRuntimeConfig('vision').model,
        baseUrl: getLlmRuntimeConfig('vision').baseUrl,
        attempt,
      });
      const shouldRetry =
        attempt < MAX_VISION_REQUEST_RETRIES && shouldRetryVisionRequest(error);
      const batchLabel =
        typeof input.batchIndex === 'number' &&
        typeof input.totalBatches === 'number'
          ? `batch ${input.batchIndex + 1}/${input.totalBatches}`
          : 'batch';

      const batchElapsedMs = Date.now() - batchStartedAt;
      const batchFailedMessage =
        `[PDF Fill][OCR] Failed ${batchLabel} for ${input.documentName} ` +
        `(attempt ${attempt}/${MAX_VISION_REQUEST_RETRIES}, vision pages: ${input.totalVisionPages ?? input.visionPages.length}, concurrency: ${MAX_VISION_OCR_BATCH_CONCURRENCY}, each_concurrency_size: ${MAX_VISION_PAGES_PER_REQUEST}, current_batch_size: ${input.visionPages.length}) after ${formatElapsedMs(batchElapsedMs)}, total image size: ${formatBytes(totalImageBytes)}, reason: ${getErrorMessage(normalizedError)}${formatProcessBudgetSuffix(
          {
            processStartedAtMs: input.processStartedAtMs,
            processHardTimeoutMs: input.processHardTimeoutMs,
          },
        )}).`;
      console.error(batchFailedMessage, normalizedError);
      await input.onTrace?.({ message: batchFailedMessage });

      if (!shouldRetry || budgetAbortTriggered) {
        if (budgetAbortTriggered) {
          throw new Error(
            'OCR batch stopped early because remaining /process budget was too low; continuing with successful OCR batches only.',
          );
        }

        if (
          normalizedError instanceof DOMException &&
          normalizedError.name === 'AbortError'
        ) {
          throw new Error(
            'Vision model processing timed out after multiple attempts.',
          );
        }

        throw normalizedError;
      }

      await sleep(2000 * attempt);
    } finally {
      if (heartbeatIntervalId) {
        clearInterval(heartbeatIntervalId);
      }
      clearTimeout(timeoutId);
    }
  }

  throw new Error('Vision model processing failed after multiple attempts.');
}

function mergeSlotResults(
  slots: GenerationSlotSchemaItem[],
  results: z.infer<typeof generationPdfFillResultSchema>[],
) {
  return {
    document_summary: '',
    extracted_items: slots.map((slot) => {
      const slotMatches = results.flatMap((result) =>
        result.extracted_items.filter(
          (item) => item.slot_key === slot.slot_key,
        ),
      );
      const preferLatestEvidence =
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes(
          '日期',
        ) ||
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes(
          '金额',
        ) ||
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes(
          '截止',
        ) ||
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes(
          '截至',
        ) ||
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes(
          '本息',
        ) ||
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes(
          '本金',
        ) ||
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes(
          '利息',
        ) ||
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes(
          '违约金',
        ) ||
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes(
          '手续费',
        ) ||
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes(
          '费用',
        ) ||
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes(
          '欠款',
        ) ||
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes(
          '逾期',
        ) ||
        `${slot.field_category} ${slot.meaning_to_applicant}`.includes('还款');
      const preferredMatch =
        slotMatches
          .filter((item) => item.original_value.trim())
          .sort((left, right) => {
            const leftMaxPage =
              left.evidence_page_numbers.length > 0
                ? Math.max(...left.evidence_page_numbers)
                : 0;
            const rightMaxPage =
              right.evidence_page_numbers.length > 0
                ? Math.max(...right.evidence_page_numbers)
                : 0;

            if (preferLatestEvidence && rightMaxPage !== leftMaxPage) {
              return rightMaxPage - leftMaxPage;
            }

            if (!preferLatestEvidence && leftMaxPage !== rightMaxPage) {
              return leftMaxPage - rightMaxPage;
            }

            const leftEvidenceScore =
              (left.evidence?.includes(left.original_value) ? 1 : 0) +
              (left.evidence?.trim() ? 1 : 0);
            const rightEvidenceScore =
              (right.evidence?.includes(right.original_value) ? 1 : 0) +
              (right.evidence?.trim() ? 1 : 0);

            return rightEvidenceScore - leftEvidenceScore;
          })[0] ?? null;

      return {
        slot_key: slot.slot_key,
        field_category: slot.field_category,
        meaning_to_applicant: slot.meaning_to_applicant,
        original_value: preferredMatch?.original_value ?? '',
        evidence: preferredMatch?.evidence ?? '',
        evidence_page_numbers: Array.from(
          new Set(
            results
              .flatMap((result) =>
                result.extracted_items.filter(
                  (item) => item.slot_key === slot.slot_key,
                ),
              )
              .flatMap((item) => item.evidence_page_numbers ?? []),
          ),
        ).sort((left, right) => left - right),
        notes: preferredMatch?.notes ?? '',
        confidence: preferredMatch?.confidence ?? null,
      };
    }),
  };
}

function hasFilledValue(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function buildVisionPageBatches(visionPages: PdfVisionPageInput[]) {
  const batches: PdfVisionPageInput[][] = [];
  const batchSize = MAX_VISION_PAGES_PER_REQUEST;

  for (let index = 0; index < visionPages.length; index += batchSize) {
    batches.push(visionPages.slice(index, index + batchSize));
  }

  return batches;
}

function isDateSlot(
  slot: Pick<
    GenerationSlotSchemaItem,
    'field_category' | 'meaning_to_applicant'
  >,
) {
  const combined = `${slot.field_category} ${slot.meaning_to_applicant ?? ''}`;
  return /日期|年月日|出生|签署|签署日|签订|放款|开户|到期|截止|还款/.test(
    combined,
  );
}

function normalizeDateValue(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  const fullDateMatch = trimmed.match(
    /^(\d{4})[.\-/年]\s*(\d{1,2})[.\-/月]\s*(\d{1,2})(?:日)?$/,
  );

  if (fullDateMatch) {
    const [, year, month, day] = fullDateMatch;
    return `${year}年${Number(month)}月${Number(day)}日`;
  }

  const compactDateMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);

  if (compactDateMatch) {
    const [, year, month, day] = compactDateMatch;
    return `${year}年${Number(month)}月${Number(day)}日`;
  }

  return trimmed;
}

function resolveExtractedValue(
  slot: Pick<
    GenerationSlotSchemaItem,
    'field_category' | 'meaning_to_applicant'
  >,
  result: ModelResultCandidate | null,
  firstMatch?: ModelMatch,
) {
  const rawValue =
    result?.final_value?.trim() || firstMatch?.value?.trim() || '';

  if (!rawValue) {
    return '';
  }

  if (isDateSlot(slot)) {
    return normalizeDateValue(rawValue);
  }

  return rawValue;
}

function resolveEvidenceSnippet(
  extractedValue: string,
  firstMatch?: ModelMatch,
) {
  const snippet = firstMatch?.snippet?.trim() || '';

  if (!snippet) {
    return extractedValue;
  }

  if (extractedValue && !snippet.includes(extractedValue)) {
    return extractedValue;
  }

  return snippet;
}

function buildSlotBatches<T>(items: T[], batchSize: number) {
  const batches: T[][] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }

  return batches;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildTraceErrorDetails(
  error: unknown,
  extra?: Record<string, unknown>,
) {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeRecord =
      cause && typeof cause === 'object'
        ? (cause as Record<string, unknown>)
        : null;

    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack ?? null,
      errorCause:
        typeof cause === 'string'
          ? cause
          : causeRecord && typeof causeRecord.message === 'string'
            ? causeRecord.message
            : null,
      errorCode:
        causeRecord && typeof causeRecord.code === 'string'
          ? causeRecord.code
          : null,
      errorErrno:
        causeRecord && typeof causeRecord.errno === 'number'
          ? causeRecord.errno
          : null,
      errorSyscall:
        causeRecord && typeof causeRecord.syscall === 'string'
          ? causeRecord.syscall
          : null,
      errorAddress:
        causeRecord && typeof causeRecord.address === 'string'
          ? causeRecord.address
          : null,
      errorPort:
        causeRecord && typeof causeRecord.port === 'number'
          ? causeRecord.port
          : null,
      ...(extra ?? {}),
    };
  }

  return {
    errorName: 'UnknownError',
    errorMessage:
      typeof error === 'string'
        ? error
        : error && typeof error === 'object'
          ? JSON.stringify(error)
          : String(error),
    errorStack: null,
    ...(extra ?? {}),
  };
}

function getProcessBudgetSnapshot(input: {
  processStartedAtMs?: number;
  processHardTimeoutMs?: number;
}) {
  if (
    typeof input.processStartedAtMs !== 'number' ||
    typeof input.processHardTimeoutMs !== 'number'
  ) {
    return null;
  }

  const totalElapsedMs = Math.max(0, Date.now() - input.processStartedAtMs);
  const remainingBudgetMs = Math.max(
    0,
    input.processHardTimeoutMs - totalElapsedMs,
  );

  return {
    totalElapsedMs,
    remainingBudgetMs,
  };
}

function formatProcessBudgetSuffix(input: {
  processStartedAtMs?: number;
  processHardTimeoutMs?: number;
}) {
  const snapshot = getProcessBudgetSnapshot(input);

  if (!snapshot) {
    return '';
  }

  return (
    `, process elapsed: ${formatElapsedMs(snapshot.totalElapsedMs)}, ` +
    `remaining /process budget: ${formatElapsedMs(snapshot.remainingBudgetMs)}`
  );
}

function chooseTextSlotFillStrategy(input: {
  slotCount: number;
  pageCount: number;
  charCount: number;
}) {
  const reasons: string[] = [];

  if (input.slotCount > MAX_TEXT_SLOTS_PER_REQUEST) {
    reasons.push(`slotCount>${MAX_TEXT_SLOTS_PER_REQUEST}`);
  }

  if (input.pageCount > MAX_TEXT_PAGES_PER_CHUNK) {
    reasons.push(`pageCount>${MAX_TEXT_PAGES_PER_CHUNK}`);
  }

  if (input.charCount > MAX_TEXT_CHARS_PER_CHUNK) {
    reasons.push(`charCount>${MAX_TEXT_CHARS_PER_CHUNK}`);
  }

  return {
    useSlotBatches: reasons.length > 0,
    reasons,
  };
}

async function extractAllSlotsWithTextModel(input: {
  documentName: string;
  slots: GenerationSlotSchemaItem[];
  pageNumbers: number[];
  chunkText: string;
  requestLabel?: string;
  onTrace?: (trace: { message: string }) => Promise<void> | void;
  processStartedAtMs?: number;
  processHardTimeoutMs?: number;
  processReserveMs?: number;
}) {
  for (let attempt = 1; attempt <= MAX_TEXT_REQUEST_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const requestStartedAt = Date.now();
    const requestTimeoutMs = getTextRequestTimeoutMs({
      pageCount: input.pageNumbers.length,
      charCount: input.chunkText.length,
      attempt,
    });
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
    let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;
    let budgetAbortTriggered = false;

    try {
      const requestLabel = input.requestLabel ?? 'full-text slot request';
      const startingBudgetSnapshot = getProcessBudgetSnapshot({
        processStartedAtMs: input.processStartedAtMs,
        processHardTimeoutMs: input.processHardTimeoutMs,
      });

      if (
        startingBudgetSnapshot &&
        startingBudgetSnapshot.remainingBudgetMs <=
          (input.processReserveMs ?? PROCESS_ROUTE_FINALIZATION_RESERVE_MS)
      ) {
        throw new Error(
          'Skipping text slot fill request because remaining /process budget is too low; handing off to manual review.',
        );
      }
      const promptPayload = buildTextSlotFillPromptPayload({
        documentName: input.documentName,
        slots: input.slots,
        pageNumbers: input.pageNumbers,
        chunkText: input.chunkText,
      });
      await input.onTrace?.({
        message: `[PDF Fill][TextPrompt][${requestLabel}] ${stringifyTraceJson({
          route: '/api/generation-task-items/[taskItemId]/slot-fill',
          model: getTextLlmModel(),
          request_label: requestLabel,
          messages: [
            {
              role: 'system',
              content:
                'You are a PDF slot filling assistant. Extract slot values from the provided PDF text chunk. Return JSON only.',
            },
            {
              role: 'user',
              content: promptPayload,
            },
          ],
        })}`,
      });
      const requestStartedMessage =
        `[PDF Fill][Text] Starting ${requestLabel} for ${input.documentName} ` +
        `(attempt ${attempt}/${MAX_TEXT_REQUEST_RETRIES}, slots: ${input.slots.length}, pages: ${input.pageNumbers.length}, char count: ${input.chunkText.length}, timeout: ${formatElapsedMs(requestTimeoutMs)}${formatProcessBudgetSuffix(
          {
            processStartedAtMs: input.processStartedAtMs,
            processHardTimeoutMs: input.processHardTimeoutMs,
          },
        )}).`;
      console.info(requestStartedMessage);
      await input.onTrace?.({ message: requestStartedMessage });
      heartbeatIntervalId = setInterval(() => {
        const elapsedMs = Date.now() - requestStartedAt;
        const budgetSnapshot = getProcessBudgetSnapshot({
          processStartedAtMs: input.processStartedAtMs,
          processHardTimeoutMs: input.processHardTimeoutMs,
        });

        if (
          budgetSnapshot &&
          !budgetAbortTriggered &&
          budgetSnapshot.remainingBudgetMs <=
            (input.processReserveMs ?? PROCESS_ROUTE_FINALIZATION_RESERVE_MS)
        ) {
          budgetAbortTriggered = true;
          const budgetAbortMessage =
            `[PDF Fill][Text] Aborting ${requestLabel} for ${input.documentName} early ` +
            `to preserve ${formatElapsedMs(
              input.processReserveMs ?? PROCESS_ROUTE_FINALIZATION_RESERVE_MS,
            )} for route finalization (process elapsed: ${formatElapsedMs(
              budgetSnapshot.totalElapsedMs,
            )}, remaining /process budget: ${formatElapsedMs(
              budgetSnapshot.remainingBudgetMs,
            )}).`;
          console.warn(budgetAbortMessage);
          void input.onTrace?.({ message: budgetAbortMessage });
          controller.abort();
          return;
        }

        const heartbeatMessage =
          `[PDF Fill][Text] Waiting on ${requestLabel} for ${input.documentName} ` +
          `(attempt ${attempt}/${MAX_TEXT_REQUEST_RETRIES}, elapsed: ${formatElapsedMs(elapsedMs)} / timeout: ${formatElapsedMs(requestTimeoutMs)}, slots: ${input.slots.length}, pages: ${input.pageNumbers.length}, char count: ${input.chunkText.length}${formatProcessBudgetSuffix(
            {
              processStartedAtMs: input.processStartedAtMs,
              processHardTimeoutMs: input.processHardTimeoutMs,
            },
          )}).`;
        console.info(heartbeatMessage);
        void input.onTrace?.({ message: heartbeatMessage });
      }, 15000);

      const llmConfig = getLlmRuntimeConfig('text');
      const upstream = await undiciFetch(llmConfig.chatCompletionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        dispatcher: llmFetchDispatcher,
        signal: controller.signal,
        body: JSON.stringify(
          buildChatCompletionBody(llmConfig, {
            messages: [
              {
                role: 'system',
                content:
                  'You are a PDF slot filling assistant. Extract slot values from the provided PDF text chunk. Return JSON only.',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  document_name: input.documentName,
                  slot_names: input.slots.map((slot) => slot.field_category),
                  slot_definitions: input.slots.map((slot) => ({
                    slot_key: slot.slot_key,
                    slot_name: slot.field_category,
                    slot_meaning:
                      slot.meaning_to_applicant ||
                      getSlotSemanticHint(slot.field_category),
                  })),
                  strict_requirement:
                    'Return the exact same slot_key copied from slot_definitions. final_value must be the exact value used for filling. The first match.value must equal final_value. The first match.snippet must contain final_value as a direct quote from the PDF text chunk. For any date field, always return the final_value in Chinese date format like 2026年1月14日. Do not return date values as 2026-01-14, 2026/01/14, or 2026.01.14.',
                  page_numbers: input.pageNumbers,
                  content: input.chunkText,
                  output_schema: {
                    results: input.slots.map((slot) => ({
                      slot_key: slot.slot_key,
                      slot_name: slot.field_category,
                      final_value: 'final extracted value',
                      matches: [
                        {
                          value: 'matched value',
                          snippet: 'short supporting quote from the PDF text',
                          page_number: 1,
                        },
                      ],
                    })),
                  },
                }),
              },
            ],
          }),
        ),
      } as UndiciFetchInit);

      if (!upstream.ok) {
        const details = await upstream.text();
        throw new Error(
          `Text model request failed (${upstream.status}): ${details}`,
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
        return {
          extracted_items: [],
          document_summary: '',
        };
      }

      const normalized = parseModelJson<{
        results?: ModelResultCandidate[];
      }>(rawContent);

      const result = {
        document_summary: '',
        extracted_items: input.slots.flatMap((slot) => {
          const firstResult = findResultForSlot(slot, normalized.results, {
            fallbackToSingleResult: input.slots.length === 1,
          });
          const firstMatch = firstResult?.matches?.find(
            (match) =>
              typeof match?.value === 'string' &&
              Boolean(match.value.trim()) &&
              typeof match?.snippet === 'string' &&
              Boolean(match.snippet.trim()),
          );

          if (!firstResult && !firstMatch) {
            return [];
          }

          const extractedValue = resolveExtractedValue(
            slot,
            firstResult,
            firstMatch,
          );

          return [
            {
              slot_key: slot.slot_key,
              field_category: slot.field_category,
              meaning_to_applicant: slot.meaning_to_applicant,
              original_value: extractedValue,
              evidence: resolveEvidenceSnippet(extractedValue, firstMatch),
              evidence_page_numbers:
                firstResult?.matches
                  ?.map((match) => match?.page_number)
                  .filter(
                    (value): value is number => typeof value === 'number',
                  ) ??
                (typeof firstMatch?.page_number === 'number'
                  ? [firstMatch.page_number]
                  : input.pageNumbers),
              notes: '',
              confidence: null,
            },
          ];
        }),
      };
      const requestElapsedMs = Date.now() - requestStartedAt;
      const requestCompletedMessage =
        `[PDF Fill][Text] Completed ${requestLabel} for ${input.documentName} ` +
        `(attempt ${attempt}) with ${result.extracted_items.filter((item) => hasFilledValue(item.original_value)).length}/${input.slots.length} filled slots in ${formatElapsedMs(requestElapsedMs)}${formatProcessBudgetSuffix(
          {
            processStartedAtMs: input.processStartedAtMs,
            processHardTimeoutMs: input.processHardTimeoutMs,
          },
        )}).`;
      console.info(requestCompletedMessage);
      await input.onTrace?.({ message: requestCompletedMessage });

      return result;
    } catch (error) {
      const normalizedError = wrapFetchFailure(error, {
        stage: 'text-slot-fill',
        documentName: input.documentName,
        model: getLlmRuntimeConfig('text').model,
        baseUrl: getLlmRuntimeConfig('text').baseUrl,
        attempt,
      });
      const requestLabel = input.requestLabel ?? 'full-text slot request';
      const requestElapsedMs = Date.now() - requestStartedAt;
      const requestFailedMessage =
        `[PDF Fill][Text] Failed ${requestLabel} for ${input.documentName} ` +
        `(attempt ${attempt}/${MAX_TEXT_REQUEST_RETRIES}) after ${formatElapsedMs(requestElapsedMs)}, slots: ${input.slots.length}, pages: ${input.pageNumbers.length}, char count: ${input.chunkText.length}${formatProcessBudgetSuffix(
          {
            processStartedAtMs: input.processStartedAtMs,
            processHardTimeoutMs: input.processHardTimeoutMs,
          },
        )}, reason: ${getErrorMessage(normalizedError)}).`;
      console.error(requestFailedMessage, normalizedError);
      await input.onTrace?.({ message: requestFailedMessage });
      const shouldRetry =
        attempt < MAX_TEXT_REQUEST_RETRIES &&
        shouldRetryTextRequest(normalizedError);

      if (!shouldRetry || budgetAbortTriggered) {
        if (budgetAbortTriggered) {
          throw new Error(
            'Text slot fill request stopped early because remaining /process budget was too low; handing off to manual review.',
          );
        }

        if (
          normalizedError instanceof DOMException &&
          normalizedError.name === 'AbortError'
        ) {
          throw new Error(
            'Text slot extraction timed out after multiple attempts.',
          );
        }

        throw normalizedError;
      }

      await sleep(1500 * attempt);
    } finally {
      if (heartbeatIntervalId) {
        clearInterval(heartbeatIntervalId);
      }
      clearTimeout(timeoutId);
    }
  }

  throw new Error('Text slot extraction failed after multiple attempts.');
}

export async function fillSlotsFromTextPages(params: {
  pdfFileName: string;
  slots: GenerationSlotSchemaItem[];
  pages: PdfPageInput[];
  processStartedAtMs?: number;
  processHardTimeoutMs?: number;
  processReserveMs?: number;
  onProgress?: (progress: {
    completedSlots: number;
    totalSlots: number;
  }) => Promise<void> | void;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  const allPageNumbers = [...params.pages]
    .sort((left, right) => left.page_number - right.page_number)
    .map((page) => page.page_number);
  const fullDocumentText = [...params.pages]
    .sort((left, right) => left.page_number - right.page_number)
    .map((page) => `[Page ${page.page_number}]\n${page.text}`)
    .join('\n');
  const fullTextInputPayload = {
    document_name: params.pdfFileName,
    page_numbers: allPageNumbers,
    slot_definitions: params.slots.map((slot) => ({
      slot_key: slot.slot_key,
      slot_name: slot.field_category,
      slot_meaning:
        slot.meaning_to_applicant || getSlotSemanticHint(slot.field_category),
    })),
    content: fullDocumentText,
  };

  await params.onTrace?.({
    message: `[PDF Fill][TextInputData][Full] ${stringifyTraceJson(fullTextInputPayload)}`,
  });

  const strategyMessage = `[PDF Fill] Text slot fill strategy for ${params.pdfFileName}: full-text all-slot request.`;
  console.info(strategyMessage);
  await params.onTrace?.({ message: strategyMessage });

  const fullDocumentResult = await extractAllSlotsWithTextModel({
    documentName: params.pdfFileName,
    slots: params.slots,
    pageNumbers: allPageNumbers,
    chunkText: fullDocumentText,
    requestLabel: 'full-text all-slot request',
    onTrace: params.onTrace,
    processStartedAtMs: params.processStartedAtMs,
    processHardTimeoutMs: params.processHardTimeoutMs,
    processReserveMs: params.processReserveMs,
  });

  const completedSlots = fullDocumentResult.extracted_items.filter((item) =>
    hasFilledValue(item.original_value),
  ).length;

  await params.onProgress?.({
    completedSlots,
    totalSlots: params.slots.length,
  });

  return fullDocumentResult;
}

export async function extractPdfTextFromVisionPages(params: {
  pdfFileName: string;
  slots: GenerationSlotSchemaItem[];
  visionPages: PdfVisionPageInput[];
  processStartedAtMs?: number;
  processHardTimeoutMs?: number;
  processReserveMs?: number;
  onTrace?: (trace: { message: string }) => Promise<void> | void;
  onProgress?: (progress: {
    completedSlots: number;
    totalSlots: number;
  }) => Promise<void> | void;
}) {
  const visionPageBatches = buildVisionPageBatches(params.visionPages);
  await params.onProgress?.({
    completedSlots: 0,
    totalSlots: params.slots.length,
  });

  const ocrStartedAt = Date.now();
  const ocrStartedMessage =
    `[PDF Fill] OCR started for ${params.pdfFileName} ` +
    `(vision pages: ${params.visionPages.length}, concurrency: ${MAX_VISION_OCR_BATCH_CONCURRENCY}, each_concurrency_size: ${MAX_VISION_PAGES_PER_REQUEST}).`;
  console.info(ocrStartedMessage);
  await params.onTrace?.({ message: ocrStartedMessage });
  let ocrBatchResults: PdfPageInput[][];

  try {
    const settledOcrBatchResults = await runWithConcurrencySettled({
      items: visionPageBatches,
      concurrency: MAX_VISION_OCR_BATCH_CONCURRENCY,
      worker: async (visionPageBatch, batchIndex) =>
        extractTextFromVisionPages({
          documentName: params.pdfFileName,
          visionPages: visionPageBatch,
          totalVisionPages: params.visionPages.length,
          batchIndex,
          totalBatches: visionPageBatches.length,
          processStartedAtMs: params.processStartedAtMs,
          processHardTimeoutMs:
            params.processHardTimeoutMs ?? PROCESS_HARD_TIMEOUT_MS,
          processReserveMs:
            params.processReserveMs ?? PROCESS_OCR_SLOT_FILL_RESERVE_MS,
          onTrace: params.onTrace,
        }),
    });
    const successfulOcrBatchResults: PdfPageInput[][] = [];
    const failedOcrBatchResults: Array<{ index: number; error: unknown }> = [];

    for (const batchResult of settledOcrBatchResults) {
      if (batchResult.ok) {
        successfulOcrBatchResults.push(batchResult.value);
        continue;
      }

      failedOcrBatchResults.push({
        index: batchResult.index,
        error: batchResult.error,
      });
    }

    if (failedOcrBatchResults.length > 0) {
      for (const failedOcrBatchResult of failedOcrBatchResults) {
        const failedBatchMessage =
          `[PDF Fill][OCR] Continuing after failed batch ${failedOcrBatchResult.index + 1}/${visionPageBatches.length} ` +
          `for ${params.pdfFileName}: ${getErrorMessage(failedOcrBatchResult.error)}`;
        console.error(failedBatchMessage, failedOcrBatchResult.error);
        await params.onTrace?.({ message: failedBatchMessage });
        await params.onTrace?.({
          message:
            `[PDF Fill][OCR][ErrorDetails][Batch ${failedOcrBatchResult.index + 1}/${visionPageBatches.length}] ` +
            `${JSON.stringify(
              buildTraceErrorDetails(failedOcrBatchResult.error, {
                documentName: params.pdfFileName,
              }),
            )}`,
        });
      }

      const partialSummaryMessage =
        `[PDF Fill][OCR] Partial success for ${params.pdfFileName}: ` +
        `${successfulOcrBatchResults.length}/${visionPageBatches.length} OCR batches succeeded, ` +
        `${failedOcrBatchResults.length} failed. Continuing with successful OCR pages only.`;
      console.info(partialSummaryMessage);
      await params.onTrace?.({ message: partialSummaryMessage });
    }

    if (successfulOcrBatchResults.length === 0) {
      throw new Error(
        'All OCR batches failed; no OCR text could be extracted.',
      );
    }

    ocrBatchResults = successfulOcrBatchResults;
    const ocrElapsedMs = Date.now() - ocrStartedAt;
    const ocrCompletedMessage =
      `[PDF Fill] OCR completed for ${params.pdfFileName} in ${formatElapsedMs(ocrElapsedMs)} ` +
      `(vision pages: ${params.visionPages.length}, concurrency: ${MAX_VISION_OCR_BATCH_CONCURRENCY}, each_concurrency_size: ${MAX_VISION_PAGES_PER_REQUEST}).`;
    console.info(ocrCompletedMessage);
    await params.onTrace?.({ message: ocrCompletedMessage });
  } catch (error) {
    const ocrElapsedMs = Date.now() - ocrStartedAt;
    const ocrFailedMessage =
      `[PDF Fill] OCR failed for ${params.pdfFileName} after ${formatElapsedMs(ocrElapsedMs)}: ` +
      `${getErrorMessage(error)}`;
    console.error(ocrFailedMessage, error);
    await params.onTrace?.({ message: ocrFailedMessage });
    await params.onTrace?.({
      message:
        `[PDF Fill][OCR][ErrorDetails][TopLevel] ` +
        `${JSON.stringify(
          buildTraceErrorDetails(error, {
            documentName: params.pdfFileName,
          }),
        )}`,
    });
    throw error;
  }

  const ocrPages = ocrBatchResults
    .flat()
    .filter((page) => page.text.trim().length > 0)
    .sort((left, right) => left.page_number - right.page_number);

  const mergedOcrMessage = `[PDF Fill][OCR] Merged OCR pages for ${params.pdfFileName}: ${ocrPages.length} pages with usable text.`;
  console.info(mergedOcrMessage);
  await params.onTrace?.({ message: mergedOcrMessage });

  if (ocrPages.length === 0) {
    throw new Error(
      'Vision OCR returned no usable text for the selected PDF pages.',
    );
  }

  return ocrPages;
}

async function runWithConcurrency<TInput, TOutput>(params: {
  items: TInput[];
  concurrency: number;
  worker: (item: TInput, index: number) => Promise<TOutput>;
}) {
  const { items, concurrency, worker } = params;

  if (items.length === 0) {
    return [] as TOutput[];
  }

  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  async function consume() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(
        items[currentIndex] as TInput,
        currentIndex,
      );
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
  return results;
}

type SettledConcurrencyResult<TOutput> =
  | { ok: true; index: number; value: TOutput }
  | { ok: false; index: number; error: unknown };

async function runWithConcurrencySettled<TInput, TOutput>(params: {
  items: TInput[];
  concurrency: number;
  worker: (item: TInput, index: number) => Promise<TOutput>;
}) {
  const { items, concurrency, worker } = params;

  if (items.length === 0) {
    return [] as SettledConcurrencyResult<TOutput>[];
  }

  const results = new Array<SettledConcurrencyResult<TOutput>>(items.length);
  let nextIndex = 0;

  async function consume() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      try {
        const value = await worker(items[currentIndex] as TInput, currentIndex);
        results[currentIndex] = {
          ok: true,
          index: currentIndex,
          value,
        };
      } catch (error) {
        results[currentIndex] = {
          ok: false,
          index: currentIndex,
          error,
        };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
  return results;
}

export async function fillTemplateSlotsFromPdf(params: {
  pdfFileName: string;
  templateName: string;
  templatePrompt: string;
  slots: GenerationSlotSchemaItem[];
  pages: PdfPageInput[];
  visionPages?: PdfVisionPageInput[];
  likelyScanned?: boolean;
  totalTextLength?: number;
  forceOcr?: boolean;
  processStartedAtMs?: number;
  processHardTimeoutMs?: number;
  onTrace?: (trace: { message: string }) => Promise<void> | void;
  onProgress?: (progress: {
    completedSlots: number;
    totalSlots: number;
  }) => Promise<void> | void;
}) {
  if (params.slots.length === 0) {
    return {
      document_summary: '',
      extracted_items: [],
    };
  }

  const validPages = params.pages.filter((page) => page.text.trim().length > 0);
  const validVisionPages = (params.visionPages ?? []).filter((page) =>
    page.image_data_url.startsWith('data:image/'),
  );

  const shouldUseVision =
    validVisionPages.length > 0 &&
    (params.forceOcr === true ||
      params.likelyScanned === true ||
      validPages.length === 0 ||
      validPages.every((page) => page.text.trim().length <= 10) ||
      (typeof params.totalTextLength === 'number' &&
        params.totalTextLength <= Math.max(20, validPages.length * 10)));

  if (shouldUseVision) {
    const ocrPages = await extractPdfTextFromVisionPages({
      pdfFileName: params.pdfFileName,
      slots: params.slots,
      visionPages: validVisionPages,
      processStartedAtMs: params.processStartedAtMs,
      processHardTimeoutMs: params.processHardTimeoutMs,
      onTrace: params.onTrace,
      onProgress: params.onProgress,
    });

    const textFillStartedAt = Date.now();
    const textFillStartedMessage =
      `[PDF Fill] Text slot fill started for ${params.pdfFileName} ` +
      `(ocr pages with text: ${ocrPages.length}, slots: ${params.slots.length}).`;
    console.info(textFillStartedMessage);
    await params.onTrace?.({ message: textFillStartedMessage });
    try {
      const result = await fillSlotsFromTextPages({
        pdfFileName: params.pdfFileName,
        slots: params.slots,
        pages: ocrPages,
        processStartedAtMs: params.processStartedAtMs,
        processHardTimeoutMs: params.processHardTimeoutMs,
        onProgress: params.onProgress,
        onTrace: params.onTrace,
      });
      const textFillElapsedMs = Date.now() - textFillStartedAt;
      const textFillCompletedMessage =
        `[PDF Fill] Text slot fill completed for ${params.pdfFileName} in ${formatElapsedMs(textFillElapsedMs)} ` +
        `(ocr pages with text: ${ocrPages.length}, slots: ${params.slots.length}).`;
      console.info(textFillCompletedMessage);
      await params.onTrace?.({ message: textFillCompletedMessage });
      return result;
    } catch (error) {
      const textFillElapsedMs = Date.now() - textFillStartedAt;
      const textFillFailedMessage =
        `[PDF Fill] Text slot fill failed for ${params.pdfFileName} after ${formatElapsedMs(textFillElapsedMs)}: ` +
        `${getErrorMessage(error)}`;
      console.error(textFillFailedMessage, error);
      await params.onTrace?.({ message: textFillFailedMessage });
      await params.onTrace?.({
        message:
          `[PDF Fill][Text][ErrorDetails][TopLevel] ` +
          `${JSON.stringify(
            buildTraceErrorDetails(error, {
              documentName: params.pdfFileName,
            }),
          )}`,
      });
      throw error;
    }
  }

  const textFillStartedAt = Date.now();
  const textFillStartedMessage =
    `[PDF Fill] Text slot fill started for ${params.pdfFileName} ` +
    `(text pages: ${validPages.length}, slots: ${params.slots.length}).`;
  console.info(textFillStartedMessage);
  await params.onTrace?.({ message: textFillStartedMessage });
  try {
    const result = await fillSlotsFromTextPages({
      pdfFileName: params.pdfFileName,
      slots: params.slots,
      pages: validPages,
      processStartedAtMs: params.processStartedAtMs,
      processHardTimeoutMs: params.processHardTimeoutMs,
      onProgress: params.onProgress,
      onTrace: params.onTrace,
    });
    const textFillElapsedMs = Date.now() - textFillStartedAt;
    const textFillCompletedMessage =
      `[PDF Fill] Text slot fill completed for ${params.pdfFileName} in ${formatElapsedMs(textFillElapsedMs)} ` +
      `(text pages: ${validPages.length}, slots: ${params.slots.length}).`;
    console.info(textFillCompletedMessage);
    await params.onTrace?.({ message: textFillCompletedMessage });
    return result;
  } catch (error) {
    const textFillElapsedMs = Date.now() - textFillStartedAt;
    const textFillFailedMessage =
      `[PDF Fill] Text slot fill failed for ${params.pdfFileName} after ${formatElapsedMs(textFillElapsedMs)}: ` +
      `${getErrorMessage(error)}`;
    console.error(textFillFailedMessage, error);
    await params.onTrace?.({ message: textFillFailedMessage });
    await params.onTrace?.({
      message:
        `[PDF Fill][Text][ErrorDetails][TopLevel] ` +
        `${JSON.stringify(
          buildTraceErrorDetails(error, {
            documentName: params.pdfFileName,
          }),
        )}`,
    });
    throw error;
  }
}
