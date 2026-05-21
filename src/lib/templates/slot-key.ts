import type {
  ExtractionItem,
  ExtractionParagraph,
  TemplatePdfEvidenceResult,
} from '@/src/app/api/types/template-slot-extraction';

export function createSlotKeyFromPosition(input: {
  paragraphIndex: number;
  itemIndex: number;
  sequence: number;
}) {
  return `${input.paragraphIndex}-${input.itemIndex}-${input.sequence}`;
}

export function createManualSlotKey(input: {
  paragraphIndex: number;
  itemIndex: number;
  sequence: number;
}) {
  return createSlotKeyFromPosition(input);
}

export function getExtractionItemSlotKey(
  item: ExtractionItem,
  paragraphIndex: number,
  itemIndex: number,
) {
  const existingSlotKey =
    typeof item.slot_key === 'string' ? item.slot_key.trim() : '';

  if (existingSlotKey) {
    return existingSlotKey;
  }

  return createSlotKeyFromPosition({
    paragraphIndex,
    itemIndex,
    sequence: item.sequence,
  });
}

export function getPdfEvidenceMatchSlotKey(
  match: TemplatePdfEvidenceResult['matches'][number],
) {
  return typeof match.slot_key === 'string' ? match.slot_key.trim() : '';
}

export function ensureExtractionResultSlotKeys(
  extractionResult: ExtractionParagraph[],
) {
  return extractionResult.map((paragraph, paragraphIndex) => ({
    ...paragraph,
    items: paragraph.items.map((item, itemIndex) => ({
      ...item,
      slot_key: getExtractionItemSlotKey(item, paragraphIndex, itemIndex),
    })),
  }));
}

export function getExtractionResultSlotKeySet(
  extractionResult: ExtractionParagraph[],
) {
  return new Set(
    extractionResult.flatMap((paragraph, paragraphIndex) =>
      paragraph.items.map((item, itemIndex) =>
        getExtractionItemSlotKey(item, paragraphIndex, itemIndex),
      ),
    ),
  );
}

export function filterPdfEvidenceMatchesBySlotKeys(
  matches: TemplatePdfEvidenceResult['matches'],
  slotKeys: Set<string>,
) {
  return matches.filter((match) =>
    slotKeys.has(getPdfEvidenceMatchSlotKey(match)),
  );
}
