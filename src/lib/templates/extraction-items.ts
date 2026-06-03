import type {
  ExtractionItem,
  ExtractionParagraph,
  TemplatePdfEvidenceResult,
} from '@/src/app/api/types/template-slot-extraction';
import { getExtractionItemSlotKey } from '@/src/lib/templates/slot-key';

export type PdfEvidenceMatch = TemplatePdfEvidenceResult['matches'][number];

export interface FlattenedExtractionItem extends ExtractionItem {
  id: string;
  slot_key: string;
  paragraphTitle: string;
  pdf_evidence_match: PdfEvidenceMatch | null;
}

function getParagraphGroupKey(input: {
  paragraphTitle: string;
  paragraphIndex: number | undefined;
}) {
  return `${input.paragraphTitle}::${input.paragraphIndex ?? 'manual'}`;
}

function getSourceParagraphGroupKey(
  paragraph: ExtractionParagraph,
  fallbackParagraphIndex: number,
) {
  return getParagraphGroupKey({
    paragraphTitle: paragraph.paragraph_title,
    paragraphIndex: paragraph.paragraph_index ?? fallbackParagraphIndex,
  });
}

function getItemParagraphGroupKey(item: FlattenedExtractionItem) {
  return getParagraphGroupKey({
    paragraphTitle: item.paragraphTitle,
    paragraphIndex:
      typeof item.paragraph_index === 'number'
        ? item.paragraph_index
        : undefined,
  });
}

function buildPdfEvidenceMatchBySlotKey(
  matches: PdfEvidenceMatch[] | undefined,
) {
  return new Map(
    (matches ?? [])
      .map((match) => [match.slot_key?.trim() ?? '', match] as const)
      .filter(([slotKey]) => slotKey.length > 0),
  );
}

function toExtractionItem(item: FlattenedExtractionItem): ExtractionItem {
  const {
    id: _id,
    paragraphTitle: _paragraphTitle,
    pdf_evidence_match: _match,
    ...rest
  } = item;

  return rest;
}

export function flattenExtractionResult(
  extractionResult: ExtractionParagraph[],
  options?: {
    pdfEvidenceMatches?: PdfEvidenceMatch[];
  },
): FlattenedExtractionItem[] {
  const matchBySlotKey = buildPdfEvidenceMatchBySlotKey(
    options?.pdfEvidenceMatches,
  );

  return extractionResult.flatMap((paragraph, paragraphIndex) =>
    paragraph.items.map((item, itemIndex) => {
      const slotKey = getExtractionItemSlotKey(item, paragraphIndex, itemIndex);

      return {
        ...item,
        slot_key: slotKey,
        id: slotKey,
        field_category: item.field_category,
        paragraphTitle: paragraph.paragraph_title,
        pdf_evidence_match: matchBySlotKey.get(slotKey) ?? null,
      };
    }),
  );
}

export function groupExtractionItemsByParagraph(
  items: FlattenedExtractionItem[],
  sourceParagraphs: ExtractionParagraph[],
): ExtractionParagraph[] {
  const matchedItemIds = new Set<string>();
  const groupedSourceParagraphs: ExtractionParagraph[] = [];

  sourceParagraphs.forEach((paragraph, paragraphIndex) => {
    const paragraphGroupKey = getSourceParagraphGroupKey(
      paragraph,
      paragraphIndex,
    );
    const paragraphItems: ExtractionParagraph['items'] = [];

    items.forEach((item) => {
      if (matchedItemIds.has(item.id)) {
        return;
      }

      const itemGroupKey = getItemParagraphGroupKey(item);

      if (itemGroupKey !== paragraphGroupKey) {
        return;
      }

      matchedItemIds.add(item.id);
      paragraphItems.push(toExtractionItem(item));
    });

    if (paragraphItems.length === 0) {
      return;
    }

    groupedSourceParagraphs.push({
      paragraph_index: paragraph.paragraph_index ?? paragraphIndex,
      paragraph_title: paragraph.paragraph_title,
      items: paragraphItems,
    });
  });

  const manualParagraphMap = new Map<
    string,
    {
      paragraphIndex: number | undefined;
      paragraphTitle: string;
      items: ExtractionParagraph['items'];
    }
  >();

  items.forEach((item) => {
    if (matchedItemIds.has(item.id)) {
      return;
    }

    const extractionItem = toExtractionItem(item);
    const paragraphIndex =
      typeof extractionItem.paragraph_index === 'number'
        ? extractionItem.paragraph_index
        : undefined;
    const paragraphKey = getParagraphGroupKey({
      paragraphTitle: item.paragraphTitle,
      paragraphIndex,
    });
    const bucket = manualParagraphMap.get(paragraphKey) ?? {
      paragraphIndex,
      paragraphTitle: item.paragraphTitle,
      items: [],
    };

    bucket.items.push(extractionItem);
    manualParagraphMap.set(paragraphKey, bucket);
  });

  const manualParagraphs = Array.from(manualParagraphMap.values()).map(
    (manualParagraph) => ({
      paragraph_index: manualParagraph.paragraphIndex,
      paragraph_title: manualParagraph.paragraphTitle,
      items: manualParagraph.items,
    }),
  );

  return [...groupedSourceParagraphs, ...manualParagraphs];
}
