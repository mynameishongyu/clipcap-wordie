import type {
  ExtractionItem,
  ExtractionParagraph,
  TemplatePdfEvidenceResult,
} from '@/src/app/api/types/template-slot-extraction';

export function createSlotKeyFromPosition(input: {
  paragraphIndex: number;
  itemIndex: number;
}) {
  return `${input.paragraphIndex}-${input.itemIndex}`;
}

export function createManualSlotKey(input: {
  paragraphIndex: number;
  itemIndex: number;
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
  const paragraphsWithSlotKeys: ExtractionParagraph[] = [];

  extractionResult.forEach((paragraph, paragraphIndex) => {
    const itemsWithSlotKeys: ExtractionParagraph['items'] = [];

    paragraph.items.forEach((item, itemIndex) => {
      const slotKey = getExtractionItemSlotKey(
        item,
        paragraphIndex,
        itemIndex,
      );

      itemsWithSlotKeys.push({
        ...item,
        slot_key: slotKey,
      });
    });

    paragraphsWithSlotKeys.push({
      ...paragraph,
      items: itemsWithSlotKeys,
    });
  });

  return paragraphsWithSlotKeys;
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
