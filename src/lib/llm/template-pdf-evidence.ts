import { Agent, fetch as undiciFetch } from 'undici';
import type {
  ExtractionParagraph,
  TemplatePdfEvidenceResult,
} from '@/src/app/api/types/template-slot-extraction';
import { getOptionalEnv } from '@/src/lib/llm/env';
import type { PdfVisionPageInput } from '@/src/lib/llm/fill-template-from-pdf';
import {
  buildChatCompletionBody,
  getLlmRuntimeConfig,
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
  bbox?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
  evidence_text?: string;
  confidence?: number;
}

interface VisionLocateModelResponse {
  matches?: VisionLocateCandidate[];
}

const visionLocateFetchDispatcher = new Agent({
  connect: {
    timeout: 30_000,
  },
});

const TEMPLATE_PDF_LOCATE_REQUEST_TIMEOUT_MS = 180_000;
const TEMPLATE_PDF_LOCATE_JSON_REPAIR_TIMEOUT_MS = 90_000;

function getTemplatePdfLocatePagesPerRequest() {
  const rawValue = getOptionalEnv('TEMPLATE_PDF_LOCATION_PAGES_PER_REQUEST');
  const parsedValue = rawValue ? Number(rawValue) : 1;

  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    return 1;
  }

  return parsedValue;
}

function chunkPages<T>(items: T[], chunkSize: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
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

  const withoutDanglingSeparator = rawContent.replace(/[\s,，]+$/u, '');

  return `${withoutDanglingSeparator}${stack.reverse().join('')}`;
}

function buildLocalJsonRepairCandidates(rawContent: string) {
  const normalized = normalizeJsonText(rawContent);
  const extracted = extractJsonObjectCandidate(normalized);
  const normalizedPunctuation = extracted.replace(/，/gu, ',').replace(/：/gu, ':');
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
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llmConfig.apiKey}`,
      },
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
                task:
                  'Repair this malformed vision-location response into JSON that can be parsed by JSON.parse. Preserve all valid matches. If a trailing match is incomplete, drop only that incomplete match. Output exactly {"matches":[...]} and nothing else.',
                parse_error: input.parseError.message,
                required_schema:
                  '{"matches":[{"slot_key":"string","page_number":number,"bbox":{"x":number,"y":number,"width":number,"height":number},"evidence_text":"string","confidence":number}]}',
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

    const repaired = parseModelJsonWithLocalRepair<VisionLocateModelResponse>(
      repairedContent,
    );
    const completedMessage =
      `[Template PDF Locate] LLM JSON repair completed with ${repaired.data.matches?.length ?? 0} match(es).`;
    console.info(completedMessage);
    await input.onTrace?.({ message: completedMessage });

    return repaired.data;
  } catch (error) {
    const failedMessage =
      `[Template PDF Locate] LLM JSON repair failed: ${error instanceof Error ? error.message : String(error)}`;
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
    const parseError = error instanceof Error ? error : new Error(String(error));

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

function normalizeBbox(candidate: VisionLocateCandidate) {
  const bbox = candidate.bbox;

  if (!bbox || typeof bbox !== 'object') {
    return null;
  }

  const x = clamp01(Number(bbox.x));
  const y = clamp01(Number(bbox.y));
  const width = clamp01(Number(bbox.width));
  const height = clamp01(Number(bbox.height));

  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x: clamp01(x),
    y: clamp01(y),
    width: clamp01(Math.min(width, 1 - x)),
    height: clamp01(Math.min(height, 1 - y)),
  };
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
    .replace(/[\s,，。.:：;；、'"“”‘’()\[\]（）【】<>《》_\-—/\\]+/gu, '');
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

function isDateLikeSlot(slot: TemplatePdfLocateSlot) {
  const metadata = `${slot.field_category} ${slot.meaning_to_applicant}`;

  return (
    /日期|时间|出生|签订|签署|截止|支付日|年月日/u.test(metadata) ||
    getDateCandidates(slot.original_value).size > 0
  );
}

function isIdentityLikeSlot(slot: TemplatePdfLocateSlot) {
  const metadata = `${slot.field_category} ${slot.meaning_to_applicant}`;
  const identityValue = normalizeIdentityValue(slot.original_value);

  return (
    /身份证|证件|公民身份|身份号码|id\s*number/iu.test(metadata) ||
    /^\d{15}$|^\d{17}[\dX]$/u.test(identityValue)
  );
}

function isAmountLikeSlot(slot: TemplatePdfLocateSlot) {
  const metadata = `${slot.field_category} ${slot.meaning_to_applicant}`;

  return (
    /金额|本金|利息|违约金|手续费|费用|价格|价款|人民币|元|款/u.test(
      metadata,
    ) ||
    /[¥￥元]|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2}/u.test(
      slot.original_value,
    )
  );
}

function isPhoneLikeSlot(slot: TemplatePdfLocateSlot) {
  const metadata = `${slot.field_category} ${slot.meaning_to_applicant}`;
  const digits = normalizeDigits(slot.original_value);

  return (
    /电话|手机|联系方式|联系电话|联系号码|phone|mobile|tel/iu.test(
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
      valid: originalDates.size > 0 && hasMatchingVariant(originalDates, evidenceDates),
      reason: 'date_value_mismatch',
    };
  }

  if (isAmountLikeSlot(input.slot)) {
    const originalAmounts = getAmountCandidates(originalValue);
    const evidenceAmounts = getAmountCandidates(evidenceText);

    return {
      valid:
        originalAmounts.size > 0 &&
        hasMatchingVariant(originalAmounts, evidenceAmounts),
      reason: 'amount_value_mismatch',
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

async function locateSlotsInPageBatch(input: {
  pdfFileName: string;
  pageBatch: PdfVisionPageInput[];
  pageBatchIndex: number;
  totalPageBatches: number;
  slots: TemplatePdfLocateSlot[];
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}) {
  const llmConfig = getLlmRuntimeConfig('vision');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, TEMPLATE_PDF_LOCATE_REQUEST_TIMEOUT_MS);

  const pageNumbers = input.pageBatch.map((page) => page.page_number);
  const startedMessage =
    `[Template PDF Locate] Starting visual location batch ${input.pageBatchIndex + 1}/${input.totalPageBatches} ` +
    `for ${input.pdfFileName} (pages: ${pageNumbers.join(', ')}, slots: ${input.slots.length}).`;
  console.info(startedMessage);
  await input.onTrace?.({ message: startedMessage });

  try {
    const content: Array<
      | { type: 'image_url'; image_url: { url: string } }
      | { type: 'text'; text: string }
    > = [
      {
        type: 'text',
        text: JSON.stringify({
          task: 'Locate the provided DOCX slot values directly on these PDF page images. Do not OCR the whole page. Return compact valid JSON only.',
          document_name: input.pdfFileName,
          page_numbers: pageNumbers,
          coordinate_system:
            'bbox values must be normalized ratios relative to the full image: x, y, width, height are all between 0 and 1.',
          json_output_rules: [
            'Return exactly one compact JSON object and nothing else.',
            'The response must start with {"matches": and must be directly parseable by JSON.parse.',
            'Do not use markdown fences, comments, explanations, line prefixes, trailing commas, single quotes, Chinese punctuation as JSON delimiters, NaN, Infinity, or undefined.',
            'If there are no confident matches, return {"matches":[]}.',
          ],
          strict_requirements: [
            'Only return a match when the visual page image contains the exact value or a visually equivalent value.',
            'A matching field label or matching field type is not enough. The visible value must match original_value after normalizing formatting.',
            'For phone numbers, compare digit sequences after removing spaces, hyphens, parentheses, and country-code formatting. Do not return a different phone number just because it is near a phone label.',
            'For ID numbers, dates, and amounts, the visible value must match the input value after normalizing common formatting such as spaces, commas, Chinese date units, and currency symbols.',
            'If the page contains the same label but a different value, omit that slot from matches.',
            'Spatial consistency is mandatory: the bbox must physically surround the exact visible text reported in evidence_text.',
            'Page consistency is mandatory: page_number must be the page image where the bbox and evidence_text are visibly present. Do not copy a value from another page, another slot, memory, or document context.',
            'evidence_text must be transcribed only from the visible characters inside or immediately touching the returned bbox on the same page_number image.',
            'If original_value is known from the input but is not visibly present on the current page image, do not return it as evidence_text for that page.',
            'Do not return a correct evidence_text with a bbox around another nearby value, another phone number, another signature block, a stamp, a label, or blank space.',
            'Before returning a match, visually re-check the proposed bbox: if the text inside the bbox is not the same value as evidence_text/original_value, omit the match.',
            'If you can read the value somewhere on the page but cannot confidently draw a tight bbox around that same visible text, omit the match instead of guessing a bbox.',
            'The bbox must enclose only the slot value text itself. Do not include field labels such as name, gender, birth date, address, amount, phone, ID number, or nearby form labels.',
            'Do not include adjacent rows, adjacent columns, explanatory text, table borders, stamps, photos, icons, or blank whitespace unless the value text itself visually requires it.',
            'For each match, return the tightest practical bounding box around the visible value text, not around the entire row, card, table cell, or page.',
            'If the value spans multiple lines, the bbox may cover those value lines only; if the value is on one line, the bbox must stay on that line only.',
            'If a value appears multiple times, choose the occurrence that best matches the field label or context.',
            'If the exact slot value is not visible but a shortened or formatted equivalent is visible, locate only that visible equivalent and put the visible text in evidence_text.',
            'evidence_text must be the visible text inside or immediately touching the bbox. It should include the located value, not just the field label.',
            'If you are unsure, omit the match instead of guessing.',
          ],
          negative_examples: [
            'For a name value, box only the person name, not the "姓名" label.',
            'For a gender value, box only "男" or "女", not the "性别" label or the neighboring nationality value.',
            'For a birth date, box only the date value, not the "出生" label or the address line below it.',
            'For an address, box only the address text, not the "住址" label, birth date line, ID number line, or photo.',
            'For original_value "18803308383", never return evidence_text "0311-66568703" because it is a different phone number.',
            'For original_value "18103108407", never return evidence_text "18103108407" with a bbox around the left-side company phone/stamp area if the visible number is actually on the right-side person phone area.',
            'Never return evidence_text equal to original_value on a page where that text is not visibly printed or handwritten inside the proposed bbox.',
            'For pages with multiple phone labels, the bbox must cover the exact phone number characters, not merely the nearest phone label or a different phone line.',
          ],
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
                bbox: {
                  x: 0.1,
                  y: 0.2,
                  width: 0.3,
                  height: 0.04,
                },
                evidence_text: 'short visible text around the located value',
                confidence: 0.85,
              },
            ],
          },
        }),
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

    const upstream = await undiciFetch(llmConfig.chatCompletionsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llmConfig.apiKey}`,
      },
      dispatcher: visionLocateFetchDispatcher,
      signal: controller.signal,
      body: JSON.stringify(
        buildChatCompletionBody(llmConfig, {
          messages: [
            {
              role: 'system',
              content:
                'You are a precise visual document layout locator. Return compact valid JSON only, with no markdown or explanations. Locate exact visible slot values in scanned PDF page images and provide tight normalized bounding boxes around the same visible text reported in evidence_text. If bbox and evidence_text are not spatially the same text, omit the match.',
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

    await input.onTrace?.({
      message:
        `[Template PDF Locate][LLM Raw Response][Batch ${input.pageBatchIndex + 1}/${input.totalPageBatches}] ` +
        JSON.stringify({
          pdf_file_name: input.pdfFileName,
          page_numbers: pageNumbers,
          raw_response: rawContent,
        }),
    });

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
  const pageBatches = chunkPages(
    input.visionPages,
    getTemplatePdfLocatePagesPerRequest(),
  );

  await input.onTrace?.({
    message:
      `[Template PDF Locate] Visual location started for ${input.pdfFileName} ` +
      `(pages: ${input.visionPages.length}, batches: ${pageBatches.length}, slots: ${slots.length}).`,
  });

  const slotByKey = new Map(slots.map((slot) => [slot.slot_key, slot]));
  const pageNumberSet = new Set(
    input.visionPages.map((page) => page.page_number),
  );
  const matchesBySlotKey = new Map<
    string,
    TemplatePdfEvidenceResult['matches'][number]
  >();

  for (const [pageBatchIndex, pageBatch] of pageBatches.entries()) {
    let rawMatches: VisionLocateCandidate[];

    try {
      rawMatches = await locateSlotsInPageBatch({
        pdfFileName: input.pdfFileName,
        pageBatch,
        pageBatchIndex,
        totalPageBatches: pageBatches.length,
        slots,
        onTrace: input.onTrace,
      });
    } catch (error) {
      const failedMessage =
        `[Template PDF Locate] Visual location batch ${pageBatchIndex + 1}/${pageBatches.length} skipped after failure: ` +
        `${error instanceof Error ? error.message : String(error)}`;
      console.error(failedMessage);
      await input.onTrace?.({ message: failedMessage });
      continue;
    }

    for (const candidate of rawMatches) {
      const slotKey = String(candidate.slot_key ?? '');
      const slot = slotByKey.get(slotKey);
      const pageNumber = Number(candidate.page_number);
      const bbox = normalizeBbox(candidate);

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
          `[Template PDF Locate] Rejected visual match for ${slot.field_category} because ${validation.reason}: ` +
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
    ocr_pages: [],
    matches,
  };
}
