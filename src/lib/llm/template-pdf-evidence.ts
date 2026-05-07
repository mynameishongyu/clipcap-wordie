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

const visionLocateFetchDispatcher = new Agent({
  connect: {
    timeout: 30_000,
  },
});

const TEMPLATE_PDF_LOCATE_REQUEST_TIMEOUT_MS = 180_000;

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

function parseModelJson<T>(rawContent: string): T {
  const normalized = normalizeJsonText(rawContent);

  try {
    return JSON.parse(normalized) as T;
  } catch (error) {
    const preview = normalized.slice(0, 240);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Vision location JSON parse failed: ${reason}. Snippet: ${preview}`,
    );
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
          task: 'Locate the provided DOCX slot values directly on these PDF page images. Do not OCR the whole page. Return JSON only.',
          document_name: input.pdfFileName,
          page_numbers: pageNumbers,
          coordinate_system:
            'bbox values must be normalized ratios relative to the full image: x, y, width, height are all between 0 and 1.',
          strict_requirements: [
            'Only return a match when the visual page image contains the exact value or a visually equivalent value.',
            'For each match, return the smallest practical bounding box around the visible value, not around the entire row or page.',
            'If a value appears multiple times, choose the occurrence that best matches the field label or context.',
            'If you are unsure, omit the match instead of guessing.',
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
                'You are a precise visual document layout locator. Return JSON only. Locate exact visible values in scanned PDF page images and provide normalized bounding boxes.',
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

    const normalized = parseModelJson<{ matches?: VisionLocateCandidate[] }>(
      rawContent,
    );
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
    const rawMatches = await locateSlotsInPageBatch({
      pdfFileName: input.pdfFileName,
      pageBatch,
      pageBatchIndex,
      totalPageBatches: pageBatches.length,
      slots,
      onTrace: input.onTrace,
    });

    rawMatches.forEach((candidate) => {
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
        return;
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
    });
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
