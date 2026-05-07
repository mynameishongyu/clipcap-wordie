import mammoth from 'mammoth';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  templateSlotExtractionResultSchema,
  type TemplateSlotExtractionResult,
} from '@/src/app/api/types/template-slot-extraction';
import { getOptionalEnv, getTextLlmModel } from '@/src/lib/llm/env';
import {
  buildChatCompletionBody,
  getLlmRuntimeConfig,
} from '@/src/lib/llm/provider';
import { normalizeSlotCategoryLabel } from '@/src/lib/templates/slot-category';

const EXTRACTION_TIMEOUT_MS = 120000;
const EXTRACTION_MAX_RETRIES = 2;
const DEFAULT_MIN_PARAGRAPH_CHARACTER_COUNT = 6;
const DEFAULT_TEMPLATE_EXTRACTION_LLM_CONCURRENCY = 2;
const DEFAULT_TEMPLATE_EXTRACTION_PARAGRAPHS_PER_REQUEST = 1;
const DEFAULT_TEMPLATE_EXTRACTION_REQUEST_INTERVAL_MS = 0;
const EXTRACTION_WAIT_HEARTBEAT_MS = 15000;
const TEMPLATE_EXTRACTION_LLM_CONNECT_TIMEOUT_MS = 60000;
const MIN_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60000;
type UndiciFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;
const templateExtractionFetchDispatcher = new Agent({
  connect: {
    timeout: TEMPLATE_EXTRACTION_LLM_CONNECT_TIMEOUT_MS,
  },
});
let templateExtractionRequestQueue = Promise.resolve();
let lastTemplateExtractionRequestStartedAt = 0;

const EXTRACTION_SYSTEM_PROMPT = `
你是中文法律文书模板槽位抽取助手。

你的基础抽取任务如下：
1. 只处理当前传入的单个段落，只能依据当前段落内容抽取槽位。
2. 默认优先抽取与“被申请人 / 被告 / 借款人 / 乙方 / 客户”等目标主体直接相关的信息。
3. 默认重点关注的字段包括但不限于：姓名、身份证号、民族、性别、出生日期、住址、联系电话、金额、日期、百分比、利率、分期期数等。

抽取规则：
1. 只返回 JSON，不要返回解释、Markdown、代码块或其他多余文本。
2. 只能抽取当前段落中真实出现的信息，不要编造，也不要补全未出现的值。
3. items 必须按照原文出现顺序输出。
4. original_value 必须保留原文格式。
5. original_doc_position 必须来自当前段落、能够定位到原文的精确短语或片段。
6. 同一段中如果出现多个不同含义的日期、金额、百分比、利率等，必须分别抽取，不能合并，也不能遗漏。
7. field_category 必须返回中文，不要返回 vehicle_plate_number、vehicle_brand 这种英文字段名。
8. 除非用户明确要求，否则忽略与目标主体无关的申请人、法院、仲裁委、代理人等主体信息。

固定 JSON 结构：
{
  "document_info": {
    "document_name": "文件名"
  },
  "extraction_result": [
    {
      "paragraph_index": 0,
      "paragraph_title": "段落标题",
      "items": [
        {
          "sequence": 1,
          "paragraph_index": 0,
          "field_category": "中文字段类别",
          "original_value": "原文中的具体值",
          "meaning_to_applicant": "这个值对目标主体的含义",
          "original_doc_position": "来自原文的定位片段"
        }
      ]
    }
  ]
}`.trim();

interface ExtractedParagraph {
  paragraph_index: number;
  paragraph_title: string;
  paragraph_text: string;
}

interface ParagraphProgress {
  completedParagraphs: number;
  totalParagraphs: number;
}

interface ExtractedParagraphResult {
  paragraph_index: number;
  paragraph_title: string;
  items: Array<{
    sequence: number;
    paragraph_index?: number | null;
    field_category: string;
    original_value: string;
    meaning_to_applicant: string;
    original_doc_position: string;
  }>;
}

interface ExtractTemplateSlotsFromDocxParams {
  buffer: Buffer;
  prompt: string;
  fileName: string;
  onParagraphComplete?: (progress: ParagraphProgress) => Promise<void> | void;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getConfiguredPositiveInteger(name: string, fallback: number) {
  const rawValue = getOptionalEnv(name);

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer when configured.`);
  }

  return parsed;
}

function getConfiguredNonNegativeInteger(name: string, fallback: number) {
  const rawValue = getOptionalEnv(name);

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer when configured.`);
  }

  return parsed;
}

function getTemplateExtractionLlmConcurrency() {
  return getConfiguredPositiveInteger(
    'TEMPLATE_EXTRACTION_LLM_CONCURRENCY',
    DEFAULT_TEMPLATE_EXTRACTION_LLM_CONCURRENCY,
  );
}

function getTemplateExtractionMaxRetries() {
  return getConfiguredPositiveInteger(
    'TEMPLATE_EXTRACTION_LLM_MAX_RETRIES',
    EXTRACTION_MAX_RETRIES,
  );
}

function getTemplateExtractionMinParagraphCharacterCount() {
  return getConfiguredPositiveInteger(
    'TEMPLATE_EXTRACTION_MIN_PARAGRAPH_CHARACTER_COUNT',
    DEFAULT_MIN_PARAGRAPH_CHARACTER_COUNT,
  );
}

function getTemplateExtractionParagraphsPerRequest() {
  return getConfiguredPositiveInteger(
    'TEMPLATE_EXTRACTION_PARAGRAPHS_PER_REQUEST',
    DEFAULT_TEMPLATE_EXTRACTION_PARAGRAPHS_PER_REQUEST,
  );
}

function getTemplateExtractionRequestIntervalMs() {
  return getConfiguredNonNegativeInteger(
    'TEMPLATE_EXTRACTION_LLM_REQUEST_INTERVAL_MS',
    DEFAULT_TEMPLATE_EXTRACTION_REQUEST_INTERVAL_MS,
  );
}

async function waitForTemplateExtractionRequestSlot(input: {
  fileName: string;
  paragraphDisplayIndex: number;
  totalParagraphs: number;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  const requestIntervalMs = getTemplateExtractionRequestIntervalMs();

  if (requestIntervalMs <= 0) {
    return;
  }

  const queuedRequest = templateExtractionRequestQueue.then(async () => {
    const waitMs = Math.max(
      0,
      lastTemplateExtractionRequestStartedAt + requestIntervalMs - Date.now(),
    );

    if (waitMs > 0) {
      const waitMessage =
        `[Template Extract][LLM] Rate limit spacing before paragraph ${input.paragraphDisplayIndex + 1}/${input.totalParagraphs} ` +
        `for ${input.fileName}: waiting ${formatElapsedMs(waitMs)} (request_interval: ${formatElapsedMs(requestIntervalMs)}).`;
      console.info(waitMessage);
      await input.onTrace?.({ message: waitMessage });
      await wait(waitMs);
    }

    lastTemplateExtractionRequestStartedAt = Date.now();
  });

  templateExtractionRequestQueue = queuedRequest.catch(() => undefined);
  await queuedRequest;
}

function clampRetryDelay(ms: number) {
  return Math.min(Math.max(ms, MIN_RETRY_DELAY_MS), MAX_RETRY_DELAY_MS);
}

function parseRetryDelayMsFromText(text: string) {
  const retryDelayMatch = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);

  if (retryDelayMatch?.[1]) {
    return clampRetryDelay(Number.parseFloat(retryDelayMatch[1]) * 1000);
  }

  return null;
}

function getRetryDelayMs(input: {
  status: number;
  details: string;
  headers: { get(name: string): string | null };
  attempt: number;
}) {
  const retryAfterHeader = input.headers.get('retry-after');
  const retryAfterSeconds = retryAfterHeader
    ? Number.parseFloat(retryAfterHeader)
    : Number.NaN;

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return clampRetryDelay(retryAfterSeconds * 1000);
  }

  const retryDelayMs = parseRetryDelayMsFromText(input.details);

  if (retryDelayMs) {
    return retryDelayMs;
  }

  return clampRetryDelay(
    input.status === 429
      ? 5000 * (input.attempt + 1)
      : 1000 * (input.attempt + 1),
  );
}

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

function formatElapsedMs(ms: number) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function stringifyTraceJson(value: unknown) {
  return JSON.stringify(value);
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

async function requestTextLlmJson(input: {
  prompt: string;
  fileName: string;
  paragraphIndex: number;
  paragraphDisplayIndex: number;
  totalParagraphs: number;
  paragraphTitle: string;
  paragraphCharCount: number;
  concurrency: number;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  let lastError: unknown = null;
  const maxRetries = getTemplateExtractionMaxRetries();

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      EXTRACTION_TIMEOUT_MS,
    );
    const requestStartedAt = Date.now();
    let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

    try {
      const startedMessage =
        `[Template Extract][LLM] Starting paragraph ${input.paragraphDisplayIndex + 1}/${input.totalParagraphs} ` +
        `for ${input.fileName} (attempt ${attempt + 1}/${maxRetries + 1}, concurrency: ${input.concurrency}, source_paragraph_index: ${input.paragraphIndex}, paragraph_char_count: ${input.paragraphCharCount}, timeout: ${formatElapsedMs(EXTRACTION_TIMEOUT_MS)}).`;
      console.log(startedMessage);
      await input.onTrace?.({ message: startedMessage });
      heartbeatIntervalId = setInterval(() => {
        const waitingMessage =
          `[Template Extract][LLM] Waiting on paragraph ${input.paragraphDisplayIndex + 1}/${input.totalParagraphs} ` +
          `for ${input.fileName} (attempt ${attempt + 1}/${maxRetries + 1}, concurrency: ${input.concurrency}, source_paragraph_index: ${input.paragraphIndex}, elapsed: ${formatElapsedMs(Date.now() - requestStartedAt)} / timeout: ${formatElapsedMs(EXTRACTION_TIMEOUT_MS)}, paragraph_char_count: ${input.paragraphCharCount}).`;
        console.log(waitingMessage);
        void input.onTrace?.({ message: waitingMessage });
      }, EXTRACTION_WAIT_HEARTBEAT_MS);

      const llmConfig = getLlmRuntimeConfig('text');
      await waitForTemplateExtractionRequestSlot({
        fileName: input.fileName,
        paragraphDisplayIndex: input.paragraphDisplayIndex,
        totalParagraphs: input.totalParagraphs,
        onTrace: input.onTrace,
      });
      const upstream = await undiciFetch(llmConfig.chatCompletionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        dispatcher: templateExtractionFetchDispatcher,
        signal: controller.signal,
        body: JSON.stringify(
          buildChatCompletionBody(llmConfig, {
            messages: [
              {
                role: 'system',
                content: EXTRACTION_SYSTEM_PROMPT,
              },
              {
                role: 'user',
                content: input.prompt,
              },
            ],
          }),
        ),
      } as UndiciFetchInit);

      if (!upstream.ok) {
        const details = await upstream.text();
        const isRetryable =
          upstream.status === 408 ||
          upstream.status === 429 ||
          upstream.status >= 500;

        if (isRetryable && attempt < maxRetries) {
          const retryDelayMs = getRetryDelayMs({
            status: upstream.status,
            details,
            headers: upstream.headers,
            attempt,
          });
          const failedMessage =
            `[Template Extract][LLM] Failed paragraph ${input.paragraphDisplayIndex + 1}/${input.totalParagraphs} ` +
            `for ${input.fileName} (attempt ${attempt + 1}/${maxRetries + 1}, concurrency: ${input.concurrency}) after ${formatElapsedMs(Date.now() - requestStartedAt)}, retrying in ${formatElapsedMs(retryDelayMs)}, reason: Text LLM request failed (${upstream.status}): ${details}`;
          console.error(failedMessage);
          await input.onTrace?.({ message: failedMessage });
          await input.onTrace?.({
            message:
              `[Template Extract][LLM][ErrorDetails][Paragraph ${input.paragraphDisplayIndex + 1}/${input.totalParagraphs}] ` +
              stringifyTraceJson(
                buildTraceErrorDetails(
                  new Error(
                    `Text LLM request failed (${upstream.status}): ${details}`,
                  ),
                  {
                    fileName: input.fileName,
                    paragraphIndex: input.paragraphIndex,
                    paragraphDisplayIndex: input.paragraphDisplayIndex,
                    totalParagraphs: input.totalParagraphs,
                    paragraphTitle: input.paragraphTitle,
                    retryDelayMs,
                  },
                ),
              ),
          });
          await wait(retryDelayMs);
          continue;
        }

        throw new Error(
          `Text LLM request failed (${upstream.status}): ${details}`,
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
        throw new Error('Text LLM returned empty content.');
      }

      const completedMessage =
        `[Template Extract][LLM] Completed paragraph ${input.paragraphDisplayIndex + 1}/${input.totalParagraphs} ` +
        `for ${input.fileName} (attempt ${attempt + 1}, concurrency: ${input.concurrency}) in ${formatElapsedMs(Date.now() - requestStartedAt)}.`;
      console.log(completedMessage);
      await input.onTrace?.({ message: completedMessage });

      return normalizeJsonText(rawContent);
    } catch (error) {
      const isTimeout =
        error instanceof DOMException && error.name === 'AbortError';
      lastError = error;
      const failedMessage =
        `[Template Extract][LLM] Failed paragraph ${input.paragraphDisplayIndex + 1}/${input.totalParagraphs} ` +
        `for ${input.fileName} (attempt ${attempt + 1}/${maxRetries + 1}, concurrency: ${input.concurrency}) after ${formatElapsedMs(Date.now() - requestStartedAt)}, reason: ${describeNetworkError(error)}`;
      console.error(failedMessage, error);
      await input.onTrace?.({ message: failedMessage });
      await input.onTrace?.({
        message:
          `[Template Extract][LLM][ErrorDetails][Paragraph ${input.paragraphDisplayIndex + 1}/${input.totalParagraphs}] ` +
          stringifyTraceJson(
            buildTraceErrorDetails(error, {
              fileName: input.fileName,
              paragraphIndex: input.paragraphIndex,
              paragraphDisplayIndex: input.paragraphDisplayIndex,
              totalParagraphs: input.totalParagraphs,
              paragraphTitle: input.paragraphTitle,
            }),
          ),
      });

      if ((isTimeout || error instanceof TypeError) && attempt < maxRetries) {
        await wait(clampRetryDelay(1000 * (attempt + 1)));
        continue;
      }

      throw error;
    } finally {
      if (heartbeatIntervalId) {
        clearInterval(heartbeatIntervalId);
      }
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error('Template slot extraction failed.');
}

export async function extractTextFromDocxBuffer(buffer: Buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value.trim();
}

export async function extractHtmlFromDocxBuffer(buffer: Buffer) {
  const { value } = await mammoth.convertToHtml({ buffer });
  return value.trim();
}

function buildParagraphTitle(paragraphText: string, paragraphIndex: number) {
  const normalized = paragraphText.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return `第 ${paragraphIndex + 1} 段`;
  }

  if (normalized.length <= 24) {
    return normalized;
  }

  return `${normalized.slice(0, 24)}...`;
}

function countMeaningfulCharacters(paragraphText: string) {
  return paragraphText.replace(/\s+/g, '').length;
}

export function extractParagraphsFromRawText(
  uploadText: string,
): ExtractedParagraph[] {
  return uploadText
    .split(/\n{2,}/)
    .map((paragraphText) => paragraphText.trim())
    .filter(Boolean)
    .map((paragraphText, paragraphIndex) => ({
      paragraph_index: paragraphIndex,
      paragraph_title: buildParagraphTitle(paragraphText, paragraphIndex),
      paragraph_text: paragraphText,
    }));
}

export function filterExtractableParagraphs(paragraphs: ExtractedParagraph[]) {
  const minParagraphCharacterCount =
    getTemplateExtractionMinParagraphCharacterCount();

  return paragraphs.filter(
    (paragraph) =>
      countMeaningfulCharacters(paragraph.paragraph_text) >=
      minParagraphCharacterCount,
  );
}

export function countExtractableParagraphsFromRawText(uploadText: string) {
  return filterExtractableParagraphs(extractParagraphsFromRawText(uploadText))
    .length;
}

function chunkParagraphs(paragraphs: ExtractedParagraph[], batchSize: number) {
  const batches: ExtractedParagraph[][] = [];

  for (let index = 0; index < paragraphs.length; index += batchSize) {
    batches.push(paragraphs.slice(index, index + batchSize));
  }

  return batches;
}

async function extractSlotsForParagraph(params: {
  fileName: string;
  prompt: string;
  paragraph: ExtractedParagraph;
  paragraphDisplayIndex: number;
  totalParagraphs: number;
  concurrency: number;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  const userPrompt = [
    `文件名：${params.fileName}`,
    params.prompt
      ? `额外抽取要求：在基础抽取内容之外，还需要额外抽取以下内容：${params.prompt}`
      : '额外抽取要求：无，按基础抽取内容执行。',
    `当前段落序号：${params.paragraph.paragraph_index}`,
    `当前段落标题：${params.paragraph.paragraph_title}`,
    '请只从下面这个段落中抽取槽位。',
    params.paragraph.paragraph_text,
  ].join('\n\n');

  const rawJson = await requestTextLlmJson({
    prompt: userPrompt,
    fileName: params.fileName,
    paragraphIndex: params.paragraph.paragraph_index,
    paragraphDisplayIndex: params.paragraphDisplayIndex,
    totalParagraphs: params.totalParagraphs,
    paragraphTitle: params.paragraph.paragraph_title,
    paragraphCharCount: countMeaningfulCharacters(
      params.paragraph.paragraph_text,
    ),
    concurrency: params.concurrency,
    onTrace: params.onTrace,
  });
  const parsed = JSON.parse(rawJson);
  const object = templateSlotExtractionResultSchema.parse(parsed);
  const extractedParagraph = object.extraction_result[0];

  if (!extractedParagraph) {
    return null;
  }

  return {
    paragraph_index: params.paragraph.paragraph_index,
    paragraph_title:
      extractedParagraph.paragraph_title?.trim() ||
      params.paragraph.paragraph_title,
    items: extractedParagraph.items.map((item) => ({
      ...item,
      field_category: normalizeSlotCategoryLabel(item.field_category),
      paragraph_index: params.paragraph.paragraph_index,
    })),
  };
}

async function extractSlotsForParagraphBatch(params: {
  fileName: string;
  prompt: string;
  paragraphs: ExtractedParagraph[];
  firstParagraphDisplayIndex: number;
  totalParagraphs: number;
  concurrency: number;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}): Promise<ExtractedParagraphResult[]> {
  if (params.paragraphs.length === 1) {
    const paragraph = params.paragraphs[0]!;
    const result = await extractSlotsForParagraph({
      fileName: params.fileName,
      prompt: params.prompt,
      paragraph,
      paragraphDisplayIndex: params.firstParagraphDisplayIndex,
      totalParagraphs: params.totalParagraphs,
      concurrency: params.concurrency,
      onTrace: params.onTrace,
    });

    return result ? [result] : [];
  }

  const promptPayload = {
    document_name: params.fileName,
    extra_extraction_requirement: params.prompt || null,
    strict_requirement:
      'Process each paragraph independently. Return JSON only. Return extraction_result as an array with one entry per paragraph that has extracted items. Copy paragraph_index exactly from the input paragraph.',
    paragraphs: params.paragraphs.map((paragraph) => ({
      paragraph_index: paragraph.paragraph_index,
      paragraph_title: paragraph.paragraph_title,
      paragraph_text: paragraph.paragraph_text,
    })),
    output_schema: {
      document_info: {
        document_name: params.fileName,
      },
      extraction_result: params.paragraphs.map((paragraph) => ({
        paragraph_index: paragraph.paragraph_index,
        paragraph_title: paragraph.paragraph_title,
        items: [
          {
            sequence: 1,
            paragraph_index: paragraph.paragraph_index,
            field_category: 'Chinese field category',
            original_value: 'exact value from paragraph text',
            meaning_to_applicant: 'meaning of the value to the target subject',
            original_doc_position: 'short quote that locates the value',
          },
        ],
      })),
    },
  };
  const rawJson = await requestTextLlmJson({
    prompt: JSON.stringify(promptPayload),
    fileName: params.fileName,
    paragraphIndex: params.paragraphs[0]?.paragraph_index ?? 0,
    paragraphDisplayIndex: params.firstParagraphDisplayIndex,
    totalParagraphs: params.totalParagraphs,
    paragraphTitle:
      params.paragraphs.length === 1
        ? (params.paragraphs[0]?.paragraph_title ?? '')
        : `${params.paragraphs.length} paragraph batch`,
    paragraphCharCount: params.paragraphs.reduce(
      (sum, paragraph) =>
        sum + countMeaningfulCharacters(paragraph.paragraph_text),
      0,
    ),
    concurrency: params.concurrency,
    onTrace: params.onTrace,
  });
  const parsed = JSON.parse(rawJson);
  const object = templateSlotExtractionResultSchema.parse(parsed);
  const paragraphByIndex = new Map(
    params.paragraphs.map((paragraph) => [
      paragraph.paragraph_index,
      paragraph,
    ]),
  );

  return object.extraction_result.flatMap((extractedParagraph) => {
    const inputParagraph =
      typeof extractedParagraph.paragraph_index === 'number'
        ? paragraphByIndex.get(extractedParagraph.paragraph_index)
        : undefined;

    if (!inputParagraph || extractedParagraph.items.length === 0) {
      return [];
    }

    return [
      {
        paragraph_index: inputParagraph.paragraph_index,
        paragraph_title:
          extractedParagraph.paragraph_title?.trim() ||
          inputParagraph.paragraph_title,
        items: extractedParagraph.items.map((item) => ({
          ...item,
          field_category: normalizeSlotCategoryLabel(item.field_category),
          paragraph_index: inputParagraph.paragraph_index,
        })),
      },
    ];
  });
}

async function extractParagraphsConcurrently(params: {
  fileName: string;
  prompt: string;
  paragraphs: ExtractedParagraph[];
  onParagraphComplete?: (progress: ParagraphProgress) => Promise<void> | void;
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  let completedParagraphs = 0;
  const totalParagraphs = params.paragraphs.length;
  const configuredConcurrency = getTemplateExtractionLlmConcurrency();
  const paragraphsPerRequest = getTemplateExtractionParagraphsPerRequest();
  const paragraphBatches = chunkParagraphs(
    params.paragraphs,
    paragraphsPerRequest,
  );
  const concurrency = Math.max(
    1,
    Math.min(configuredConcurrency, paragraphBatches.length),
  );

  const startedMessage =
    `[Template Extract] LLM paragraph extraction started for ${params.fileName} ` +
    `(paragraphs: ${totalParagraphs}, concurrency: ${concurrency}, paragraphs_per_request: ${paragraphsPerRequest}).`;
  console.log(startedMessage);
  await params.onTrace?.({ message: startedMessage });

  const results = await runWithConcurrencySettled({
    items: paragraphBatches,
    concurrency,
    worker: async (paragraphBatch) => {
      const firstParagraph = paragraphBatch[0]!;
      const firstParagraphDisplayIndex = params.paragraphs.findIndex(
        (paragraph) =>
          paragraph.paragraph_index === firstParagraph.paragraph_index,
      );

      try {
        return await extractSlotsForParagraphBatch({
          fileName: params.fileName,
          prompt: params.prompt,
          paragraphs: paragraphBatch,
          firstParagraphDisplayIndex,
          totalParagraphs,
          concurrency,
          onTrace: params.onTrace,
        });
      } finally {
        completedParagraphs += paragraphBatch.length;
        const progressMessage =
          `[Template Extract] Paragraph extraction progress for ${params.fileName}: ` +
          `${completedParagraphs}/${totalParagraphs} paragraphs processed.`;
        console.log(progressMessage);
        await params.onTrace?.({ message: progressMessage });
        await params.onParagraphComplete?.({
          completedParagraphs,
          totalParagraphs,
        });
      }
    },
  });
  const extractedParagraphs: ExtractedParagraphResult[] = [];
  const failedResults = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') {
      continue;
    }

    if (!result.value || result.value.length === 0) {
      continue;
    }

    extractedParagraphs.push(...result.value);
  }

  if (failedResults.length > 0 && extractedParagraphs.length > 0) {
    const partialMessage =
      `[Template Extract] Partial success for ${params.fileName}: ` +
      `${extractedParagraphs.length}/${totalParagraphs} paragraphs returned slots, ` +
      `${failedResults.length} request batches failed. Continuing with successful paragraph results only.`;
    console.warn(partialMessage);
    await params.onTrace?.({ message: partialMessage });
  }

  if (extractedParagraphs.length === 0) {
    const allFailedError =
      failedResults[0]?.reason ??
      new Error('All template extraction paragraph requests failed.');
    throw allFailedError;
  }

  const completedMessage =
    `[Template Extract] LLM paragraph extraction completed for ${params.fileName} ` +
    `(paragraphs: ${totalParagraphs}, concurrency: ${concurrency}, paragraphs_per_request: ${paragraphsPerRequest}, extracted_paragraphs: ${extractedParagraphs.length}, failed_batches: ${failedResults.length}).`;
  console.log(completedMessage);
  await params.onTrace?.({ message: completedMessage });

  return {
    extractedParagraphs,
    totalParagraphs,
    succeededParagraphs: extractedParagraphs.length,
    failedParagraphs: failedResults.length,
  };
}

export async function extractTemplateSlotsFromDocx(
  params: ExtractTemplateSlotsFromDocxParams,
): Promise<
  TemplateSlotExtractionResult & {
    uploadText: string;
    uploadHtml: string;
    totalParagraphs: number;
    succeededParagraphs: number;
    failedParagraphs: number;
  }
> {
  const uploadText = await extractTextFromDocxBuffer(params.buffer);
  const uploadHtml = await extractHtmlFromDocxBuffer(params.buffer);

  if (!uploadText) {
    throw new Error('No usable text was extracted from the DOCX file.');
  }

  const paragraphs = extractParagraphsFromRawText(uploadText);

  if (paragraphs.length === 0) {
    throw new Error('No usable paragraphs were found in the DOCX file.');
  }

  const extractableParagraphs = filterExtractableParagraphs(paragraphs);

  if (extractableParagraphs.length === 0) {
    throw new Error('No extractable paragraphs were found in the DOCX file.');
  }

  await params.onTrace?.({
    message:
      `[Template Extract][PromptPreview] ` +
      stringifyTraceJson({
        route: '/api/template-extraction-tasks/[taskId]/process',
        model: getTextLlmModel(),
        file_name: params.fileName,
        paragraph_count: extractableParagraphs.length,
        min_paragraph_character_count:
          getTemplateExtractionMinParagraphCharacterCount(),
        concurrency: Math.max(
          1,
          Math.min(
            getTemplateExtractionLlmConcurrency(),
            Math.ceil(
              extractableParagraphs.length /
                getTemplateExtractionParagraphsPerRequest(),
            ),
          ),
        ),
        paragraphs_per_request: getTemplateExtractionParagraphsPerRequest(),
        extra_prompt: params.prompt,
      }),
  });

  const paragraphExtraction = await extractParagraphsConcurrently({
    fileName: params.fileName,
    prompt: params.prompt,
    paragraphs: extractableParagraphs,
    onParagraphComplete: params.onParagraphComplete,
    onTrace: params.onTrace,
  });

  const extractedParagraphs = paragraphExtraction.extractedParagraphs;
  extractedParagraphs.sort(
    (left, right) => left.paragraph_index - right.paragraph_index,
  );

  let nextSequence = 1;
  const normalizedExtractionResult = extractedParagraphs.map((paragraph) => ({
    ...paragraph,
    items: paragraph.items.map((item) => ({
      ...item,
      sequence: nextSequence++,
    })),
  }));

  return {
    document_info: {
      document_name: params.fileName,
    },
    extraction_result: normalizedExtractionResult,
    uploadText,
    uploadHtml,
    totalParagraphs: paragraphExtraction.totalParagraphs,
    succeededParagraphs: paragraphExtraction.succeededParagraphs,
    failedParagraphs: paragraphExtraction.failedParagraphs,
  };
}

async function runWithConcurrencySettled<TInput, TOutput>(params: {
  items: TInput[];
  concurrency: number;
  worker: (item: TInput, index: number) => Promise<TOutput>;
}) {
  const { items, concurrency, worker } = params;

  if (items.length === 0) {
    return [] as PromiseSettledResult<TOutput>[];
  }

  const results = new Array<PromiseSettledResult<TOutput>>(items.length);
  let nextIndex = 0;

  async function consume() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      try {
        results[currentIndex] = {
          status: 'fulfilled',
          value: await worker(items[currentIndex] as TInput, currentIndex),
        };
      } catch (error) {
        results[currentIndex] = {
          status: 'rejected',
          reason: error,
        };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
  return results;
}
