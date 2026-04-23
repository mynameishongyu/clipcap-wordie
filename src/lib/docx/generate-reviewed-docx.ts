import 'server-only';

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';
import type { GenerationReviewedItem } from '@/src/app/api/types/generation-task';
import type { ExtractionParagraph } from '@/src/app/api/types/template-slot-extraction';
import type { SlotReviewSessionPayload } from '@/src/lib/templates/slot-review-session';
import type { DocBlock, ParsedDocument, TextSegment } from '@/src/types/docx-preview';

interface TemplateOriginalSlot {
  slot_key: string;
  field_category: string;
  meaning_to_applicant: string;
  original_value: string;
  original_doc_position: string;
  paragraph_index?: number;
  paragraph_title: string;
}

function localNameOf(node: Node | null) {
  if (!node) {
    return '';
  }

  const elementLike = node as Node & { localName?: string };
  if (elementLike.localName) {
    return elementLike.localName;
  }

  return node.nodeName.split(':').pop() ?? node.nodeName;
}

function getElementChildren(node: Node) {
  const children: Element[] = [];

  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === child.ELEMENT_NODE) {
      children.push(child as Element);
    }
  }

  return children;
}

function findFirstDescendant(root: unknown, localName: string) {
  const queue: Element[] = [];

  if (root && typeof root === 'object' && 'documentElement' in root) {
    const documentElement = (root as { documentElement?: Element | null }).documentElement;

    if (documentElement) {
      queue.push(documentElement);
    }
  } else {
    queue.push(root as Element);
  }

  while (queue.length > 0) {
    const element = queue.shift();
    if (!element) {
      continue;
    }

    if (localNameOf(element) === localName) {
      return element;
    }

    queue.push(...getElementChildren(element));
  }

  return null;
}

function normalizeParagraphText(value: string) {
  return value.replace(/\s+/g, '');
}

function extractParagraphTextsFromUploadText(uploadText: string) {
  return uploadText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function collectStructuredParagraphTexts(blocks: DocBlock[]): string[] {
  const paragraphTexts: string[] = [];

  const visitBlocks = (nextBlocks: DocBlock[]) => {
    nextBlocks.forEach((block) => {
      if (block.type === 'paragraph') {
        paragraphTexts.push(
          block.segments
            .filter((segment): segment is TextSegment => segment.type === 'text')
            .map((segment) => segment.text)
            .join(''),
        );
        return;
      }

      block.rows.forEach((row) => {
        row.cells.forEach((cell) => {
          visitBlocks(cell.blocks);
        });
      });
    });
  };

  visitBlocks(blocks);

  return paragraphTexts;
}

function buildStructuredParagraphIndexMap(
  rawParagraphTexts: string[],
  structuredParagraphTexts: string[],
) {
  const mappedIndexes = new Map<number, number>();
  let searchStart = 0;

  rawParagraphTexts.forEach((rawParagraphText, rawParagraphIndex) => {
    const normalizedRawParagraphText = normalizeParagraphText(rawParagraphText);

    if (!normalizedRawParagraphText) {
      return;
    }

    for (
      let structuredParagraphIndex = searchStart;
      structuredParagraphIndex < structuredParagraphTexts.length;
      structuredParagraphIndex += 1
    ) {
      const normalizedStructuredParagraphText = normalizeParagraphText(
        structuredParagraphTexts[structuredParagraphIndex] ?? '',
      );

      if (!normalizedStructuredParagraphText) {
        continue;
      }

      const isExactMatch =
        normalizedStructuredParagraphText === normalizedRawParagraphText;
      const isContainedMatch =
        normalizedStructuredParagraphText.includes(normalizedRawParagraphText) ||
        normalizedRawParagraphText.includes(normalizedStructuredParagraphText);

      if (!isExactMatch && !isContainedMatch) {
        continue;
      }

      mappedIndexes.set(rawParagraphIndex, structuredParagraphIndex);
      searchStart = structuredParagraphIndex + 1;
      return;
    }
  });

  return mappedIndexes;
}

function normalizeTemplateOriginalSlots(value: ExtractionParagraph[]): TemplateOriginalSlot[] {
  return value.flatMap((paragraph, paragraphIndex) => {
    const paragraphTitle = paragraph.paragraph_title ?? '';
    const baseParagraphIndex =
      typeof paragraph.paragraph_index === 'number'
        ? paragraph.paragraph_index
        : undefined;

    return paragraph.items.map((item, itemIndex) => ({
      slot_key: `${paragraphIndex}-${itemIndex}-${item.sequence}`,
      field_category: item.field_category,
      meaning_to_applicant: item.meaning_to_applicant,
      original_value: item.original_value,
      original_doc_position: item.original_doc_position,
      paragraph_index:
        typeof item.paragraph_index === 'number'
          ? item.paragraph_index
          : baseParagraphIndex,
      paragraph_title: paragraphTitle,
    }));
  });
}

function resolveStructuredOriginalSlots(
  parsedDocument: ParsedDocument,
  uploadText: string,
  originalSlots: TemplateOriginalSlot[],
) {
  const structuredParagraphTexts = collectStructuredParagraphTexts(parsedDocument.blocks);
  const rawParagraphTexts = extractParagraphTextsFromUploadText(uploadText);
  const structuredParagraphIndexMap = buildStructuredParagraphIndexMap(
    rawParagraphTexts,
    structuredParagraphTexts,
  );

  return originalSlots.map((slot) => {
    const originalValue = slot.original_value.trim();
    const originalDocPosition = slot.original_doc_position.trim();
    const mappedParagraphIndex =
      typeof slot.paragraph_index === 'number'
        ? structuredParagraphIndexMap.get(slot.paragraph_index)
        : undefined;

    if (!originalValue && !originalDocPosition) {
      return slot;
    }

    const matchesParagraph = (paragraphText: string) => {
      if (originalDocPosition && paragraphText.includes(originalDocPosition)) {
        return true;
      }

      return originalValue ? paragraphText.includes(originalValue) : false;
    };

    if (
      typeof mappedParagraphIndex === 'number' &&
      mappedParagraphIndex >= 0 &&
      mappedParagraphIndex < structuredParagraphTexts.length &&
      matchesParagraph(structuredParagraphTexts[mappedParagraphIndex] ?? '')
    ) {
      return {
        ...slot,
        paragraph_index: mappedParagraphIndex,
      };
    }

    const fallbackParagraphIndexes = structuredParagraphTexts
      .map((paragraphText, paragraphIndex) =>
        matchesParagraph(paragraphText) ? paragraphIndex : -1,
      )
      .filter((paragraphIndex) => paragraphIndex >= 0);

    if (fallbackParagraphIndexes.length > 0) {
      return {
        ...slot,
        paragraph_index: fallbackParagraphIndexes[0],
      };
    }

    return {
      ...slot,
      paragraph_index: undefined,
    };
  });
}

function collectParagraphElements(root: Element) {
  const paragraphs: Element[] = [];

  const visitContainer = (container: Element) => {
    getElementChildren(container).forEach((child) => {
      const name = localNameOf(child);

      if (name === 'p') {
        paragraphs.push(child);
        return;
      }

      if (name === 'tbl') {
        getElementChildren(child).forEach((row) => {
          if (localNameOf(row) !== 'tr') {
            return;
          }

          getElementChildren(row).forEach((cell) => {
            if (localNameOf(cell) !== 'tc') {
              return;
            }

            visitContainer(cell);
          });
        });
      }
    });
  };

  visitContainer(root);

  return paragraphs;
}

function collectTextNodes(paragraph: Element) {
  const nodes: Element[] = [];
  const queue: Element[] = [paragraph];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    if (localNameOf(current) === 't') {
      nodes.push(current);
      continue;
    }

    queue.push(...getElementChildren(current));
  }

  return nodes;
}

function ensureXmlSpace(textNode: Element, text: string) {
  const hasEdgeWhitespace = /^\s|\s$/u.test(text);

  if (hasEdgeWhitespace) {
    textNode.setAttribute('xml:space', 'preserve');
    return;
  }

  if (textNode.hasAttribute('xml:space')) {
    textNode.removeAttribute('xml:space');
  }
}

function writeParagraphText(paragraph: Element, nextText: string) {
  const textNodes = collectTextNodes(paragraph);

  if (textNodes.length === 0) {
    return;
  }

  const originalLengths = textNodes.map((node) => node.textContent?.length ?? 0);
  let cursor = 0;

  textNodes.forEach((node, index) => {
    const isLast = index === textNodes.length - 1;
    const nextChunk = isLast
      ? nextText.slice(cursor)
      : nextText.slice(cursor, cursor + originalLengths[index]);

    node.textContent = nextChunk;
    ensureXmlSpace(node, nextChunk);
    cursor += nextChunk.length;
  });
}

function buildReviewedValueMap(items: GenerationReviewedItem[]) {
  return new Map(
    items.map((item) => [
      item.slot_key,
      { value: item.original_value.trim() },
    ]),
  );
}

function applyParagraphReplacements(
  paragraphText: string,
  slots: TemplateOriginalSlot[],
  reviewedValueMap: Map<string, { value: string }>,
) {
  const usedRanges: Array<{ start: number; end: number }> = [];
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  slots.forEach((slot) => {
    const reviewed = reviewedValueMap.get(slot.slot_key);
    if (!reviewed) {
      return;
    }

    const originalValue = slot.original_value.trim();
    if (!originalValue || originalValue === reviewed.value) {
      return;
    }

    let searchStart = 0;

    while (searchStart < paragraphText.length) {
      const matchIndex = paragraphText.indexOf(originalValue, searchStart);
      if (matchIndex < 0) {
        break;
      }

      const nextRange = {
        start: matchIndex,
        end: matchIndex + originalValue.length,
      };
      const overlaps = usedRanges.some(
        (range) => Math.max(range.start, nextRange.start) < Math.min(range.end, nextRange.end),
      );

      if (!overlaps) {
        usedRanges.push(nextRange);
        replacements.push({
          start: nextRange.start,
          end: nextRange.end,
          replacement: reviewed.value,
        });
        break;
      }

      searchStart = matchIndex + originalValue.length;
    }
  });

  if (replacements.length === 0) {
    return paragraphText;
  }

  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (currentText, replacement) =>
        `${currentText.slice(0, replacement.start)}${replacement.replacement}${currentText.slice(
          replacement.end,
        )}`,
      paragraphText,
    );
}

export async function generateReviewedDocxBuffer(input: {
  templatePayload: SlotReviewSessionPayload;
  reviewedItems: GenerationReviewedItem[];
}) {
  const uploadDocxBase64 = input.templatePayload.uploadDocxBase64?.trim();

  if (!uploadDocxBase64) {
    throw new Error('当前模板缺少原始 DOCX 文件，无法生成核查后的下载结果。');
  }

  const parsedDocument = input.templatePayload.parsedDocument;
  if (!parsedDocument) {
    throw new Error('当前模板缺少结构化 DOCX 预览数据，无法生成核查后的下载结果。');
  }

  const extractionResult = Array.isArray(input.templatePayload.extractionResult)
    ? input.templatePayload.extractionResult
    : [];

  const originalSlots = resolveStructuredOriginalSlots(
    parsedDocument,
    input.templatePayload.uploadText,
    normalizeTemplateOriginalSlots(extractionResult),
  );

  const slotsByParagraph = new Map<number, TemplateOriginalSlot[]>();
  originalSlots.forEach((slot) => {
    if (typeof slot.paragraph_index !== 'number') {
      return;
    }

    const bucket = slotsByParagraph.get(slot.paragraph_index) ?? [];
    bucket.push(slot);
    slotsByParagraph.set(slot.paragraph_index, bucket);
  });

  const reviewedValueMap = buildReviewedValueMap(input.reviewedItems);
  const buffer = Buffer.from(uploadDocxBase64, 'base64');
  const zip = await JSZip.loadAsync(buffer);
  const documentFile = zip.file('word/document.xml');

  if (!documentFile) {
    throw new Error('模板 DOCX 缺少 word/document.xml，无法生成下载结果。');
  }

  const documentXml = await documentFile.async('string');
  const documentDom = new DOMParser().parseFromString(documentXml, 'application/xml');
  const body = findFirstDescendant(documentDom, 'body');

  if (!body) {
    throw new Error('模板 DOCX 缺少正文内容，无法生成下载结果。');
  }

  const paragraphElements = collectParagraphElements(body);
  const structuredParagraphTexts = collectStructuredParagraphTexts(parsedDocument.blocks);

  paragraphElements.forEach((paragraphElement, paragraphIndex) => {
    const slots = slotsByParagraph.get(paragraphIndex);
    const paragraphText = structuredParagraphTexts[paragraphIndex] ?? '';

    if (!slots || !paragraphText) {
      return;
    }

    const nextParagraphText = applyParagraphReplacements(paragraphText, slots, reviewedValueMap);
    if (nextParagraphText === paragraphText) {
      return;
    }

    writeParagraphText(paragraphElement, nextParagraphText);
  });

  const nextDocumentXml = new XMLSerializer().serializeToString(documentDom);
  zip.file('word/document.xml', nextDocumentXml);

  return zip.generateAsync({ type: 'nodebuffer' });
}
