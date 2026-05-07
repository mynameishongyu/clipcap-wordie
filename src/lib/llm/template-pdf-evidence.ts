import type {
  ExtractionParagraph,
  TemplatePdfEvidenceResult,
} from '@/src/app/api/types/template-slot-extraction';
import {
  extractPdfTextFromVisionPages,
  type GenerationSlotSchemaItem,
  type PdfPageInput,
  type PdfVisionPageInput,
} from '@/src/lib/llm/fill-template-from-pdf';

function normalizeEvidenceText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、“”‘’：:；;,.()[\]{}<>《》【】（）\-_/\\|]/g, '')
    .replace(/[￥¥]/g, '')
    .replace(/元整?|人民币/g, '');
}

function buildEvidenceSnippet(pageText: string, value: string) {
  const rawIndex = pageText.indexOf(value);

  if (rawIndex >= 0) {
    const start = Math.max(0, rawIndex - 40);
    const end = Math.min(pageText.length, rawIndex + value.length + 40);
    return pageText.slice(start, end).trim();
  }

  return pageText.slice(0, 120).trim();
}

function findBestPageMatch(value: string, pages: PdfPageInput[]) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  const normalizedValue = normalizeEvidenceText(trimmedValue);

  if (!normalizedValue) {
    return null;
  }

  for (const page of pages) {
    if (page.text.includes(trimmedValue)) {
      return {
        page,
        evidenceText: buildEvidenceSnippet(page.text, trimmedValue),
        confidence: 0.92,
        matchType: 'raw_contains' as const,
      };
    }
  }

  for (const page of pages) {
    const normalizedPageText = normalizeEvidenceText(page.text);

    if (normalizedPageText.includes(normalizedValue)) {
      return {
        page,
        evidenceText: buildEvidenceSnippet(page.text, trimmedValue),
        confidence: 0.74,
        matchType: 'normalized_exact' as const,
      };
    }
  }

  return null;
}

function buildSlotSchema(
  extractionResult: ExtractionParagraph[],
): GenerationSlotSchemaItem[] {
  return extractionResult.flatMap((paragraph, paragraphResultIndex) =>
    paragraph.items.map((item, itemIndex) => ({
      slot_key: `${paragraphResultIndex}-${itemIndex}-${item.sequence}`,
      field_category: item.field_category,
      meaning_to_applicant: item.meaning_to_applicant,
    })),
  );
}

export async function buildTemplatePdfEvidence(input: {
  pdfFileName: string;
  extractionResult: ExtractionParagraph[];
  visionPages: PdfVisionPageInput[];
  onTrace?: (entry: { message: string }) => Promise<void> | void;
}): Promise<TemplatePdfEvidenceResult> {
  await input.onTrace?.({
    message:
      `[Template PDF Evidence] OCR started for ${input.pdfFileName} ` +
      `(pages: ${input.visionPages.length}, slots: ${input.extractionResult.flatMap((paragraph) => paragraph.items).length}).`,
  });

  const ocrPages = await extractPdfTextFromVisionPages({
    pdfFileName: input.pdfFileName,
    slots: buildSlotSchema(input.extractionResult),
    visionPages: input.visionPages,
    onTrace: input.onTrace,
  });

  const matches = input.extractionResult.flatMap(
    (paragraph, paragraphResultIndex) =>
      paragraph.items.flatMap((item, itemIndex) => {
        const pageMatch = findBestPageMatch(item.original_value, ocrPages);

        if (!pageMatch) {
          return [];
        }

        return [
          {
            paragraph_result_index: paragraphResultIndex,
            item_index: itemIndex,
            sequence: item.sequence,
            paragraph_index:
              item.paragraph_index ?? paragraph.paragraph_index ?? null,
            field_category: item.field_category,
            original_value: item.original_value,
            page_number: pageMatch.page.page_number,
            evidence_text: pageMatch.evidenceText,
            confidence: pageMatch.confidence,
            match_type: pageMatch.matchType,
          },
        ];
      }),
  );

  await input.onTrace?.({
    message:
      `[Template PDF Evidence] Matching completed for ${input.pdfFileName}: ` +
      `${matches.length} slot value(s) linked to OCR text across ${ocrPages.length} page(s).`,
  });

  return {
    pdf_file_name: input.pdfFileName,
    ocr_pages: ocrPages.map((page) => ({
      page_number: page.page_number,
      text: page.text,
    })),
    matches,
  };
}
