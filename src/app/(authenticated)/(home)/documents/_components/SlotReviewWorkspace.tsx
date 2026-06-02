'use client';

import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type {
  ExtractionParagraph,
  TemplatePdfEvidenceResult,
} from '@/src/app/api/types/template-slot-extraction';
import { browserProcessLog } from '@/src/lib/debug/browser-process-log';
import { useJsonPreviewDebug } from '@/src/lib/debug/json-preview-toggle';
import {
  createOptimizedPdfJpegCanvas,
  getPdfRenderConfig,
  getPdfStorageUploadConcurrency,
  getPdfVisionRenderConcurrency,
} from '@/src/lib/pdf/client-pdf';
import { getSupabaseBrowserClient } from '@/src/lib/supabase/client';
import { normalizeSlotCategoryLabel } from '@/src/lib/templates/slot-category';
import {
  flattenExtractionResult,
  groupExtractionItemsByParagraph,
  type FlattenedExtractionItem,
} from '@/src/lib/templates/extraction-items';
import {
  SLOT_REVIEW_SESSION_KEY,
  type SlotReviewSessionPayload,
} from '@/src/lib/templates/slot-review-session';
import { getSupabaseSignedUrlExpiresInSeconds } from '@/src/lib/supabase/signed-url';
import {
  createManualSlotKey,
  filterPdfEvidenceMatchesBySlotKeys,
  getExtractionResultSlotKeySet,
  getPdfEvidenceMatchSlotKey,
} from '@/src/lib/templates/slot-key';
import { openSaveTemplateModal } from '@/src/modals/save-template';
import { openSlotReviewGuideModal } from '@/src/modals/slot-review-guide';
import { useSaveTemplate } from '@/src/querys/use-template-library';
import type {
  DocBlock,
  ParagraphBlock,
  ParsedDocument,
  TextSegment,
  TextStyleSnapshot,
} from '@/src/types/docx-preview';

interface EditableExtractionItem extends FlattenedExtractionItem {}

type PdfEvidenceMatch = TemplatePdfEvidenceResult['matches'][number];

interface PdfBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PdfDragState {
  pageNumber: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface PdfLocationEditState {
  itemId: string;
  draftPageNumber: number | null;
  draftBbox: PdfBbox | null;
  drag: PdfDragState | null;
}

interface PdfScrollAnchor {
  pageNumber: number;
  relativeY: number;
}

const PDF_PREVIEW_BASE_WIDTH = 1020;
const PDF_PREVIEW_MIN_ZOOM = 0.45;
const PDF_PREVIEW_MAX_ZOOM = 2.2;
const PDF_PREVIEW_ZOOM_STEP = 0.1;
const PDF_PREVIEW_MAX_DEVICE_PIXEL_RATIO = 2;
const PDF_PREVIEW_IMAGE_SMOOTHING_QUALITY = 'high';
const DEFAULT_PDF_PREVIEW_SHARPEN_STRENGTH = 0.25;
const DOCX_PREVIEW_FONT_SCALE = 0.72;

function getPdfPreviewSharpenStrength() {
  const parsedValue = Number(
    process.env.NEXT_PUBLIC_PDF_PREVIEW_SHARPEN_STRENGTH,
  );

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    return DEFAULT_PDF_PREVIEW_SHARPEN_STRENGTH;
  }

  return parsedValue;
}

const PDF_PREVIEW_SHARPEN_STRENGTH = getPdfPreviewSharpenStrength();

function clampPdfZoom(value: number) {
  return Math.min(PDF_PREVIEW_MAX_ZOOM, Math.max(PDF_PREVIEW_MIN_ZOOM, value));
}

interface SlotReviewWorkspaceState {
  payload: SlotReviewSessionPayload | null;
  items: EditableExtractionItem[];
  activeItemId: string | null;
  editingItemId: string | null;
  pendingSelectionByItemId: Record<string, string>;
  isAddingItem: boolean;
  pendingNewItemSelection: string;
  pendingNewItemParagraphIndex: number | null;
  pendingNewItemMeaning: string;
}

function createManualSlotKeyForNewItem(input: {
  items: EditableExtractionItem[];
  sourceParagraphs: ExtractionParagraph[];
  draftItem: EditableExtractionItem;
}) {
  const draftItems = [...input.items, input.draftItem];
  const draftExtractionResult = groupExtractionItemsByParagraph(
    draftItems,
    input.sourceParagraphs,
  );

  for (const [paragraphIndex, paragraph] of draftExtractionResult.entries()) {
    const itemIndex = paragraph.items.findIndex(
      (item) =>
        item.sequence === input.draftItem.sequence &&
        item.original_value === input.draftItem.original_value &&
        item.meaning_to_applicant === input.draftItem.meaning_to_applicant &&
        item.original_doc_position === input.draftItem.original_doc_position,
    );

    if (itemIndex >= 0) {
      return createManualSlotKey({
        paragraphIndex,
        itemIndex,
      });
    }
  }

  return createManualSlotKey({
    paragraphIndex: draftExtractionResult.length,
    itemIndex: 0,
  });
}

function removeOrphanPdfEvidenceMatches(
  payload: SlotReviewSessionPayload,
): SlotReviewSessionPayload {
  if (!payload.pdfEvidence) {
    return payload;
  }

  const slotKeys = getExtractionResultSlotKeySet(payload.extractionResult);
  const filteredMatches = filterPdfEvidenceMatchesBySlotKeys(
    payload.pdfEvidence.matches,
    slotKeys,
  );
  const pagesWithMatches = new Set(
    filteredMatches.map((match) => match.page_number),
  );

  return {
    ...payload,
    pdfEvidence: {
      ...payload.pdfEvidence,
      matches: filteredMatches,
      pages: payload.pdfEvidence.pages.map((page) =>
        pagesWithMatches.has(page.pageNumber)
          ? page
          : { ...page, annotatedStoragePath: undefined },
      ),
    },
  };
}

function extractParagraphTextsFromUploadText(uploadText: string) {
  return uploadText
    .split(/\n{2,}/)
    .map((paragraphText) => paragraphText.trim())
    .filter(Boolean);
}

function buildJsonPreviewPayload(
  items: EditableExtractionItem[],
  payload: SlotReviewSessionPayload,
) {
  const groupedParagraphs = groupExtractionItemsByParagraph(
    items,
    payload.extractionResult,
  );
  const paragraphTexts = extractParagraphTextsFromUploadText(
    payload.uploadText,
  );

  return {
    document_info: payload.documentInfo,
    extraction_result: groupedParagraphs.map((paragraph) => {
      const paragraphIndex =
        typeof paragraph.paragraph_index === 'number'
          ? paragraph.paragraph_index
          : paragraph.items.find(
              (item) => typeof item.paragraph_index === 'number',
            )?.paragraph_index;
      const paragraphOriginalText =
        typeof paragraphIndex === 'number'
          ? (paragraphTexts[paragraphIndex] ?? '')
          : '';

      return {
        ...paragraph,
        paragraph_original_text: paragraphOriginalText,
        items: paragraph.items.map((item) => ({
          ...item,
          sequence_paragraph_original_text:
            typeof item.paragraph_index === 'number'
              ? (paragraphTexts[item.paragraph_index] ?? paragraphOriginalText)
              : paragraphOriginalText,
        })),
      };
    }),
  };
}

function buildPreviewItems(
  items: EditableExtractionItem[],
  isAddingItem: boolean,
  pendingNewItemSelection: string,
  pendingNewItemParagraphIndex: number | null,
) {
  if (!isAddingItem || !pendingNewItemSelection.trim()) {
    return items;
  }

  return [
    ...items,
    {
      id: 'pending-new-item',
      slot_key: 'pending-new-item',
      paragraphTitle: '手动新增槽位',
      sequence: Number.MAX_SAFE_INTEGER,
      field_category: '手动新增',
      original_value: pendingNewItemSelection.trim(),
      meaning_to_applicant: '',
      original_doc_position: pendingNewItemSelection.trim(),
      paragraph_index: pendingNewItemParagraphIndex ?? undefined,
      pdf_evidence_match: null,
    },
  ];
}

function findClosestPreviewParagraphIndex(node: Node | null) {
  let currentElement =
    node?.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : (node?.parentElement ?? null);

  while (currentElement) {
    const paragraphIndexValue = currentElement.getAttribute(
      'data-preview-paragraph-index',
    );

    if (paragraphIndexValue) {
      const paragraphIndex = Number(paragraphIndexValue);

      return Number.isNaN(paragraphIndex) ? null : paragraphIndex;
    }

    currentElement = currentElement.parentElement;
  }

  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDocumentFallbackHtml(uploadText: string) {
  return uploadText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br />')}</p>`)
    .join('');
}

function createHighlightMarkup(
  itemId: string,
  value: string,
  isActive: boolean,
) {
  const background = isActive ? '#ffd16666' : '#38d39f22';
  const border = isActive ? '#f59f00' : '#7adfb8';

  return `<mark
    id="slot-marker-${itemId}"
    data-slot-id="${itemId}"
    style="background:${background}; border:1px solid ${border}; border-radius:6px; padding:0 3px;"
  >${value}</mark>`;
}

function highlightDocumentHtml(
  documentHtml: string,
  items: EditableExtractionItem[],
  activeId: string | null,
  hiddenItemId: string | null,
) {
  if (typeof window === 'undefined') {
    return documentHtml;
  }

  const highlightItems = items.filter(
    (item) => item.original_value.trim() && item.id !== hiddenItemId,
  );

  if (highlightItems.length === 0) {
    return documentHtml;
  }

  const parser = new DOMParser();
  const documentNode = parser.parseFromString(documentHtml, 'text/html');

  highlightItems.forEach((item) => {
    const searchValue = item.original_value.trim();

    if (!searchValue) {
      return;
    }

    const walker = documentNode.createTreeWalker(
      documentNode.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue?.trim()) {
            return NodeFilter.FILTER_REJECT;
          }

          if (node.parentElement?.closest('mark')) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );

    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text;
      const currentValue = textNode.nodeValue ?? '';
      const matchIndex = currentValue.indexOf(searchValue);

      if (matchIndex < 0) {
        continue;
      }

      const matchedNode = textNode.splitText(matchIndex);
      matchedNode.splitText(searchValue.length);

      const mark = documentNode.createElement('mark');
      mark.id = `slot-marker-${item.id}`;
      mark.dataset.slotId = item.id;
      mark.style.background = item.id === activeId ? '#79f2c033' : '#38d39f22';
      mark.style.border = `1px solid ${item.id === activeId ? '#38d39f' : '#7adfb8'}`;
      mark.style.borderRadius = '6px';
      mark.style.padding = '0 3px';
      mark.textContent = matchedNode.nodeValue ?? searchValue;

      matchedNode.parentNode?.replaceChild(mark, matchedNode);
      return;
    }
  });

  return documentNode.body.innerHTML;
}

function highlightPlainText(
  uploadText: string,
  items: EditableExtractionItem[],
  activeId: string | null,
  hiddenItemId: string | null,
) {
  const highlightItems = items.filter(
    (item) => item.original_value.trim() && item.id !== hiddenItemId,
  );

  if (highlightItems.length === 0) {
    return buildDocumentFallbackHtml(uploadText);
  }

  return highlightItems.reduce((currentText, item) => {
    const safeValue = escapeRegExp(item.original_value.trim());
    return currentText.replace(
      new RegExp(safeValue, 'g'),
      createHighlightMarkup(item.id, item.original_value, item.id === activeId),
    );
  }, buildDocumentFallbackHtml(uploadText));
}

function textStyleToCss(style: TextStyleSnapshot): CSSProperties {
  return {
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    textDecoration: style.underline ? 'underline' : undefined,
    color: style.color,
    backgroundColor: style.backgroundColor,
    fontSize: style.fontSizePt
      ? `${Math.max(8, style.fontSizePt * DOCX_PREVIEW_FONT_SCALE)}pt`
      : undefined,
    fontFamily: style.fontFamily,
    whiteSpace: 'pre-wrap',
  };
}

interface TextDecoration {
  itemId: string;
  start: number;
  end: number;
}

interface ParagraphDecoration extends TextDecoration {
  segmentId: string;
  segmentStart: number;
  segmentEnd: number;
  continuesFromPrevious: boolean;
  continuesToNext: boolean;
}

function collectParagraphDecorations(
  segments: TextSegment[],
  items: EditableExtractionItem[],
  hiddenItemId: string | null,
  paragraphIndex: number,
) {
  const textSegments = segments.filter((segment) => segment.text.length > 0);

  if (textSegments.length === 0) {
    return new Map<string, ParagraphDecoration[]>();
  }

  const combinedText = textSegments.map((segment) => segment.text).join('');
  const consumedRanges: Array<{ start: number; end: number }> = [];
  const decorations: TextDecoration[] = [];

  items.forEach((item) => {
    if (item.id === hiddenItemId) {
      return;
    }

    if (
      typeof item.paragraph_index === 'number' &&
      item.paragraph_index !== paragraphIndex
    ) {
      return;
    }

    const value = item.original_value.trim();

    if (!value) {
      return;
    }

    let searchStart = 0;

    while (searchStart < combinedText.length) {
      const matchIndex = combinedText.indexOf(value, searchStart);

      if (matchIndex < 0) {
        return;
      }

      const nextRange = {
        start: matchIndex,
        end: matchIndex + value.length,
      };
      const overlapsExisting = consumedRanges.some(
        (range) =>
          Math.max(range.start, nextRange.start) <
          Math.min(range.end, nextRange.end),
      );

      if (!overlapsExisting) {
        consumedRanges.push(nextRange);
        decorations.push({
          itemId: item.id,
          start: nextRange.start,
          end: nextRange.end,
        });
        return;
      }

      searchStart = matchIndex + value.length;
    }
  });

  const decorationMap = new Map<string, ParagraphDecoration[]>();
  let paragraphOffset = 0;

  textSegments.forEach((segment) => {
    const segmentStart = paragraphOffset;
    const segmentEnd = segmentStart + segment.text.length;
    paragraphOffset = segmentEnd;

    const segmentDecorations = decorations
      .filter(
        (decoration) =>
          decoration.start < segmentEnd && decoration.end > segmentStart,
      )
      .map((decoration) => ({
        itemId: decoration.itemId,
        start: Math.max(0, decoration.start - segmentStart),
        end: Math.min(segment.text.length, decoration.end - segmentStart),
        segmentId: segment.id,
        segmentStart,
        segmentEnd,
        continuesFromPrevious: decoration.start < segmentStart,
        continuesToNext: decoration.end > segmentEnd,
      }))
      .sort((left, right) => left.start - right.start);

    decorationMap.set(segment.id, segmentDecorations);
  });

  return decorationMap;
}

function renderSegmentContent(
  segment: TextSegment,
  decorations: ParagraphDecoration[],
  activeItemId: string | null,
) {
  if (decorations.length === 0) {
    return segment.text;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;

  decorations.forEach((decoration) => {
    if (cursor < decoration.start) {
      nodes.push(
        <Fragment key={`${segment.id}:${cursor}:${decoration.start}`}>
          {segment.text.slice(cursor, decoration.start)}
        </Fragment>,
      );
    }

    const matchedText = segment.text.slice(decoration.start, decoration.end);
    const isActive = decoration.itemId === activeItemId;

    nodes.push(
      <mark
        id={`slot-marker-${decoration.itemId}`}
        data-slot-id={decoration.itemId}
        key={`${segment.id}:${decoration.itemId}:${decoration.start}`}
        style={{
          background: isActive ? '#ffd16666' : '#38d39f22',
          borderTopStyle: 'solid',
          borderRightStyle: 'solid',
          borderBottomStyle: 'solid',
          borderLeftStyle: 'solid',
          borderTopColor: isActive ? '#f59f00' : '#7adfb8',
          borderRightColor: isActive ? '#f59f00' : '#7adfb8',
          borderBottomColor: isActive ? '#f59f00' : '#7adfb8',
          borderLeftColor: isActive ? '#f59f00' : '#7adfb8',
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderLeftWidth: decoration.continuesFromPrevious ? 0 : 1,
          borderRightWidth: decoration.continuesToNext ? 0 : 1,
          borderTopLeftRadius: decoration.continuesFromPrevious ? 0 : 6,
          borderBottomLeftRadius: decoration.continuesFromPrevious ? 0 : 6,
          borderTopRightRadius: decoration.continuesToNext ? 0 : 6,
          borderBottomRightRadius: decoration.continuesToNext ? 0 : 6,
          boxShadow:
            isActive &&
            !decoration.continuesFromPrevious &&
            !decoration.continuesToNext
              ? '0 0 0 2px rgba(245, 159, 0, 0.35), 0 0 22px rgba(245, 159, 0, 0.24)'
              : undefined,
          paddingLeft: decoration.continuesFromPrevious ? 1 : 3,
          paddingRight: decoration.continuesToNext ? 1 : 3,
          paddingTop: 0,
          paddingBottom: 0,
          marginLeft: decoration.continuesFromPrevious ? -1 : 0,
          marginRight: decoration.continuesToNext ? -1 : 0,
          scrollMarginBlock: '140px',
          transition:
            'background-color 180ms ease, box-shadow 180ms ease, transform 180ms ease',
          transform: isActive ? 'translateY(-1px)' : undefined,
        }}
      >
        {matchedText}
      </mark>,
    );

    cursor = decoration.end;
  });

  if (cursor < segment.text.length) {
    nodes.push(
      <Fragment key={`${segment.id}:${cursor}:${segment.text.length}`}>
        {segment.text.slice(cursor)}
      </Fragment>,
    );
  }

  return nodes;
}

function renderParagraphBlock(
  block: ParagraphBlock,
  items: EditableExtractionItem[],
  activeItemId: string | null,
  hiddenItemId: string | null,
  paragraphIndex: number,
) {
  const firstText = block.segments.find(
    (segment): segment is TextSegment =>
      segment.type === 'text' && segment.text.trim().length > 0,
  );
  const paragraphDecorationMap = collectParagraphDecorations(
    block.segments.filter(
      (segment): segment is TextSegment => segment.type === 'text',
    ),
    items,
    hiddenItemId,
    paragraphIndex,
  );
  const isLikelyTitle =
    block.align === 'center' &&
    block.segments.length <= 3 &&
    (firstText?.text.trim().length ?? 0) > 0 &&
    (firstText?.text.trim().length ?? 0) <= 30;

  return (
    <p
      key={block.id}
      data-preview-paragraph-index={paragraphIndex}
      data-preview-block-id={block.id}
      style={{
        margin: '0 0 0.75em',
        minHeight: 16,
        textAlign: block.align,
        textIndent: isLikelyTitle || block.align === 'center' ? 0 : '2em',
        lineHeight: 1.58,
        fontWeight: isLikelyTitle ? 700 : undefined,
        fontSize: isLikelyTitle ? '15px' : undefined,
      }}
    >
      {block.segments.length === 0 ? <span>&nbsp;</span> : null}
      {block.segments.map((segment) => {
        if (segment.type === 'text') {
          return (
            <span key={segment.id} style={textStyleToCss(segment.style)}>
              {renderSegmentContent(
                segment,
                paragraphDecorationMap.get(segment.id) ?? [],
                activeItemId,
              )}
            </span>
          );
        }

        return (
          <span
            key={segment.id}
            style={{
              display: 'inline-flex',
              margin: '0 6px',
              verticalAlign: 'middle',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={segment.altText || '鏂囨。鍥剧墖'}
              src={segment.src}
              style={{
                maxWidth: segment.style.widthPx
                  ? `${segment.style.widthPx}px`
                  : '100%',
                maxHeight: segment.style.heightPx
                  ? `${segment.style.heightPx}px`
                  : undefined,
              }}
            />
          </span>
        );
      })}
    </p>
  );
}

function renderStructuredBlocks(
  blocks: DocBlock[],
  items: EditableExtractionItem[],
  activeItemId: string | null,
  hiddenItemId: string | null,
): ReactNode {
  const renderBlocks = (
    nextBlocks: DocBlock[],
    startingParagraphIndex: number,
  ): [ReactNode[], number] => {
    let currentParagraphIndex = startingParagraphIndex;
    const nodes = nextBlocks.map((block) => {
      if (block.type === 'paragraph') {
        const node = renderParagraphBlock(
          block,
          items,
          activeItemId,
          hiddenItemId,
          currentParagraphIndex,
        );
        currentParagraphIndex += 1;
        return node;
      }

      const renderedRows = block.rows.map((row) => (
        <tr key={row.id}>
          {row.cells.map((cell) => {
            const [cellNodes, nextParagraphIndex] = renderBlocks(
              cell.blocks,
              currentParagraphIndex,
            );
            currentParagraphIndex = nextParagraphIndex;

            return (
              <td
                key={cell.id}
                style={{
                  border: '1px solid #dbe9e1',
                  padding: '8px 10px',
                  verticalAlign: 'top',
                }}
              >
                {cellNodes}
              </td>
            );
          })}
        </tr>
      ));

      return (
        <table
          key={block.id}
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            marginBottom: '1.1em',
          }}
        >
          <tbody>{renderedRows}</tbody>
        </table>
      );
    });

    return [nodes, currentParagraphIndex];
  };

  return renderBlocks(blocks, 0)[0];
}

function collectStructuredParagraphTexts(blocks: DocBlock[]): string[] {
  const paragraphTexts: string[] = [];

  const visitBlocks = (nextBlocks: DocBlock[]) => {
    nextBlocks.forEach((block) => {
      if (block.type === 'paragraph') {
        paragraphTexts.push(
          block.segments
            .filter(
              (segment): segment is TextSegment => segment.type === 'text',
            )
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

function normalizeParagraphText(value: string) {
  return value.replace(/\s+/g, '');
}

function getItemDocumentOffset(
  item: EditableExtractionItem,
  paragraphTexts: string[],
  fullText: string,
) {
  const value = item.original_value.trim();

  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }

  if (
    typeof item.paragraph_index === 'number' &&
    item.paragraph_index >= 0 &&
    item.paragraph_index < paragraphTexts.length
  ) {
    const paragraphText = paragraphTexts[item.paragraph_index] ?? '';
    const paragraphOffset = paragraphText.indexOf(value);

    if (paragraphOffset >= 0) {
      return item.paragraph_index * 1_000_000 + paragraphOffset;
    }
  }

  const directOffset = fullText.indexOf(value);

  return directOffset >= 0 ? directOffset : Number.MAX_SAFE_INTEGER;
}

function sortItemsByDocumentPosition(
  items: EditableExtractionItem[],
  paragraphTexts: string[],
  fullText: string,
) {
  return items
    .map((item, index) => ({
      item,
      index,
      offset: getItemDocumentOffset(item, paragraphTexts, fullText),
    }))
    .sort((left, right) => {
      if (left.offset !== right.offset) {
        return left.offset - right.offset;
      }

      return left.index - right.index;
    })
    .map(({ item }) => item);
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
        normalizedStructuredParagraphText.includes(
          normalizedRawParagraphText,
        ) ||
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

function resolveStructuredPreviewItems(
  parsedDocument: ParsedDocument,
  uploadText: string,
  items: EditableExtractionItem[],
) {
  const structuredParagraphTexts = collectStructuredParagraphTexts(
    parsedDocument.blocks,
  );
  const rawParagraphTexts = extractParagraphTextsFromUploadText(uploadText);
  const structuredParagraphIndexMap = buildStructuredParagraphIndexMap(
    rawParagraphTexts,
    structuredParagraphTexts,
  );

  const resolvedItems = items.flatMap((item) => {
    const originalValue = item.original_value.trim();
    const mappedParagraphIndex =
      typeof item.paragraph_index === 'number'
        ? structuredParagraphIndexMap.get(item.paragraph_index)
        : undefined;

    if (!originalValue) {
      return [];
    }

    const matchesParagraph = (paragraphText: string) =>
      paragraphText.includes(originalValue);

    if (
      typeof mappedParagraphIndex === 'number' &&
      mappedParagraphIndex >= 0 &&
      mappedParagraphIndex < structuredParagraphTexts.length &&
      matchesParagraph(structuredParagraphTexts[mappedParagraphIndex] ?? '')
    ) {
      return [item];
    }

    const fallbackParagraphIndexes = structuredParagraphTexts
      .map((paragraphText, paragraphIndex) =>
        matchesParagraph(paragraphText) ? paragraphIndex : -1,
      )
      .filter((paragraphIndex) => paragraphIndex >= 0);

    if (fallbackParagraphIndexes.length > 0) {
      const fallbackParagraphIndex =
        typeof item.paragraph_index === 'number'
          ? fallbackParagraphIndexes[fallbackParagraphIndexes.length - 1]
          : fallbackParagraphIndexes[0];

      return [
        {
          ...item,
          paragraph_index: fallbackParagraphIndex,
        },
      ];
    }

    return [];
  });

  return sortItemsByDocumentPosition(
    resolvedItems,
    structuredParagraphTexts,
    structuredParagraphTexts.join('\n\n'),
  );
}

function filterPlainPreviewItems(
  uploadText: string,
  items: EditableExtractionItem[],
) {
  const paragraphTexts = extractParagraphTextsFromUploadText(uploadText);
  const filteredItems = items.filter((item) => {
    const originalValue = item.original_value.trim();

    if (!originalValue) {
      return false;
    }

    return uploadText.includes(originalValue);
  });

  return sortItemsByDocumentPosition(filteredItems, paragraphTexts, uploadText);
}

function parseSlotItemIdentity(item: EditableExtractionItem) {
  const [paragraphResultIndexRaw, itemIndexRaw, sequenceRaw] = item.id
    .replace(/^manual-/, '')
    .split('-');
  const paragraphResultIndex = Number(paragraphResultIndexRaw);
  const itemIndex = Number(itemIndexRaw);
  const sequence = Number(sequenceRaw);

  if (
    !Number.isInteger(paragraphResultIndex) ||
    !Number.isInteger(itemIndex) ||
    (sequenceRaw !== undefined && !Number.isInteger(sequence))
  ) {
    return null;
  }

  return {
    paragraphResultIndex,
    itemIndex,
    sequence: sequenceRaw !== undefined ? sequence : item.sequence,
  };
}

function isPdfEvidenceMatchForItem(
  match: PdfEvidenceMatch,
  item: EditableExtractionItem,
) {
  const itemSlotKey = item.slot_key?.trim() || item.id;

  return getPdfEvidenceMatchSlotKey(match) === itemSlotKey;
}

function findPdfEvidenceMatchForItem(
  item: EditableExtractionItem | null,
  payload: SlotReviewSessionPayload | null,
) {
  if (!item) {
    return null;
  }

  if (item.pdf_evidence_match) {
    return item.pdf_evidence_match;
  }

  if (!payload?.pdfEvidence) {
    return null;
  }

  return (
    payload.pdfEvidence.matches.find((match) =>
      isPdfEvidenceMatchForItem(match, item),
    ) ?? null
  );
}

function clampPdfCoordinate(value: number) {
  return Math.min(1, Math.max(0, value));
}

function buildPdfBboxFromPoints(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
): PdfBbox {
  const x = Math.min(startX, currentX);
  const y = Math.min(startY, currentY);
  const width = Math.abs(currentX - startX);
  const height = Math.abs(currentY - startY);

  return {
    x: clampPdfCoordinate(x),
    y: clampPdfCoordinate(y),
    width: clampPdfCoordinate(width),
    height: clampPdfCoordinate(height),
  };
}

function getNormalizedPdfPointerPosition(event: MouseEvent<HTMLElement>) {
  const rect = event.currentTarget.getBoundingClientRect();

  return {
    x: clampPdfCoordinate((event.clientX - rect.left) / rect.width),
    y: clampPdfCoordinate((event.clientY - rect.top) / rect.height),
  };
}

function buildManualPdfEvidenceMatch(input: {
  item: EditableExtractionItem;
  pageNumber: number;
  bbox: PdfBbox;
  existingMatch: PdfEvidenceMatch | null;
}): PdfEvidenceMatch {
  const identity = parseSlotItemIdentity(input.item);
  const slotKey = input.item.slot_key?.trim() || input.item.id;

  return {
    slot_key: slotKey,
    paragraph_result_index:
      input.existingMatch?.paragraph_result_index ??
      identity?.paragraphResultIndex ??
      0,
    item_index: input.existingMatch?.item_index ?? identity?.itemIndex ?? 0,
    sequence: input.item.sequence,
    paragraph_index: input.item.paragraph_index ?? null,
    field_category: input.item.field_category,
    original_value: input.item.original_value,
    page_number: input.pageNumber,
    bbox: input.bbox,
    evidence_text: input.item.original_value || '用户手动框选定位',
    confidence: 1,
    match_type: 'manual_bbox',
  };
}

function getPreviewDevicePixelRatio() {
  const rawRatio =
    typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  if (!Number.isFinite(rawRatio) || rawRatio <= 0) {
    return 1;
  }

  return Math.min(PDF_PREVIEW_MAX_DEVICE_PIXEL_RATIO, rawRatio);
}

function getPreviewSmoothingQuality(): ImageSmoothingQuality {
  const quality = PDF_PREVIEW_IMAGE_SMOOTHING_QUALITY.trim().toLowerCase();

  if (quality === 'low' || quality === 'medium' || quality === 'high') {
    return quality;
  }

  return 'high';
}

function sharpenCanvas(canvas: HTMLCanvasElement, strength: number) {
  if (strength <= 0) {
    return;
  }

  const context = canvas.getContext('2d');
  const { width, height } = canvas;

  if (!context || width < 3 || height < 3) {
    return;
  }

  try {
    const imageData = context.getImageData(0, 0, width, height);
    const source = imageData.data;
    const output = new Uint8ClampedArray(source);
    const centerWeight = 1 + strength * 4;

    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = (y * width + x) * 4;
        const topIndex = index - width * 4;
        const bottomIndex = index + width * 4;
        const leftIndex = index - 4;
        const rightIndex = index + 4;

        for (let channel = 0; channel < 3; channel += 1) {
          output[index + channel] = Math.max(
            0,
            Math.min(
              255,
              source[index + channel] * centerWeight -
                source[topIndex + channel] * strength -
                source[bottomIndex + channel] * strength -
                source[leftIndex + channel] * strength -
                source[rightIndex + channel] * strength,
            ),
          );
        }
      }
    }

    imageData.data.set(output);
    context.putImageData(imageData, 0, 0);
  } catch {
    // Cross-origin signed URLs can taint the canvas; display still works, so skip sharpening.
  }
}

function PdfEvidencePageCanvas({
  alt,
  displayWidth,
  fallbackImageUrl,
  imageUrl,
  pageNumber,
}: {
  alt: string;
  displayWidth: number;
  fallbackImageUrl?: string;
  imageUrl: string;
  pageNumber: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas || !imageUrl) {
      return;
    }

    let isDisposed = false;

    const drawImageToCanvas = (image: HTMLImageElement, sourceUrl: string) => {
      if (isDisposed || !canvasRef.current) {
        return;
      }

      const ratio = getPreviewDevicePixelRatio();
      const cssWidth = Math.max(1, Math.round(displayWidth));
      const cssHeight = Math.max(
        1,
        Math.round(cssWidth * (image.naturalHeight / image.naturalWidth)),
      );
      const canvasWidth = Math.max(1, Math.round(cssWidth * ratio));
      const canvasHeight = Math.max(1, Math.round(cssHeight * ratio));
      const context = canvasRef.current.getContext('2d');

      if (!context) {
        return;
      }

      canvasRef.current.width = canvasWidth;
      canvasRef.current.height = canvasHeight;
      canvasRef.current.style.width = `${cssWidth}px`;
      canvasRef.current.style.height = `${cssHeight}px`;
      canvasRef.current.dataset.naturalWidth = String(image.naturalWidth);
      canvasRef.current.dataset.naturalHeight = String(image.naturalHeight);
      canvasRef.current.dataset.pageNumber = String(pageNumber);
      canvasRef.current.dataset.imageSource = sourceUrl.startsWith('blob:')
        ? 'local_blob'
        : sourceUrl.startsWith('data:')
          ? 'data_url'
          : 'remote_url';

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = getPreviewSmoothingQuality();
      context.clearRect(0, 0, canvasWidth, canvasHeight);
      context.drawImage(
        image,
        0,
        0,
        image.naturalWidth,
        image.naturalHeight,
        0,
        0,
        canvasWidth,
        canvasHeight,
      );
      sharpenCanvas(canvasRef.current, PDF_PREVIEW_SHARPEN_STRENGTH);
    };

    const loadImage = (sourceUrl: string, allowFallback: boolean) => {
      const image = new Image();

      image.onload = () => {
        drawImageToCanvas(image, sourceUrl);
      };

      image.onerror = () => {
        if (
          !isDisposed &&
          allowFallback &&
          fallbackImageUrl &&
          fallbackImageUrl !== sourceUrl
        ) {
          loadImage(fallbackImageUrl, false);
        }
      };

      image.src = sourceUrl;
    };

    loadImage(imageUrl, true);

    return () => {
      isDisposed = true;
    };
  }, [displayWidth, fallbackImageUrl, imageUrl, pageNumber]);

  return (
    <canvas
      aria-label={alt}
      data-pdf-page-canvas="true"
      ref={canvasRef}
      style={{
        display: 'block',
        width: displayWidth,
        height: 'auto',
        borderRadius: 12,
        background: '#fff',
        boxShadow: '0 18px 50px rgba(0, 0, 0, 0.32)',
        pointerEvents: 'none',
      }}
    />
  );
}

function getReferencePageImageSource(
  page: NonNullable<SlotReviewSessionPayload['pdfEvidence']>['pages'][number],
) {
  return page.imageDataUrl ?? page.imageUrl ?? page.fallbackImageUrl ?? '';
}

async function getFreshReferencePageImageSource(input: {
  page: NonNullable<SlotReviewSessionPayload['pdfEvidence']>['pages'][number];
  supabase: ReturnType<typeof getSupabaseBrowserClient>;
}) {
  const existingImageSource = getReferencePageImageSource(input.page);

  if (existingImageSource) {
    return existingImageSource;
  }

  const storagePath = input.page.storagePath?.trim();

  if (storagePath) {
    const { data, error } = await input.supabase.storage
      .from('generation-pdfs')
      .createSignedUrl(storagePath, getSupabaseSignedUrlExpiresInSeconds());

    if (error || !data?.signedUrl) {
      browserProcessLog.warn(
        '[Slot Review][Annotated Reference] Fresh signed URL failed',
        {
          pageNumber: input.page.pageNumber,
          storagePath,
          error,
        },
      );
    } else {
      return data.signedUrl;
    }
  }

  return getReferencePageImageSource(input.page);
}

async function loadImageElementForCanvas(sourceUrl: string) {
  const response = await fetch(sourceUrl);

  if (!response.ok) {
    throw new Error(`参考图读取失败：${response.status}`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();

      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error('参考图加载失败。'));
      nextImage.src = objectUrl;
    });

    return { image, objectUrl };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function formatMegabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const currentItem = items[currentIndex];

        if (!currentItem) {
          continue;
        }

        results[currentIndex] = await worker(currentItem, currentIndex);
      }
    }),
  );

  return results;
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('带定位参考图导出失败。'));
          return;
        }

        resolve(blob);
      },
      'image/jpeg',
      quality,
    );
  });
}

function clampCanvasRectPosition(
  rect: CanvasRect,
  canvasWidth: number,
  canvasHeight: number,
): CanvasRect {
  return {
    ...rect,
    left: Math.max(0, Math.min(canvasWidth - rect.width, rect.left)),
    top: Math.max(0, Math.min(canvasHeight - rect.height, rect.top)),
  };
}

function getCanvasRectOverlapArea(
  firstRect: CanvasRect,
  secondRect: CanvasRect,
  padding = 0,
) {
  const left = Math.max(firstRect.left, secondRect.left - padding);
  const top = Math.max(firstRect.top, secondRect.top - padding);
  const right = Math.min(
    firstRect.left + firstRect.width,
    secondRect.left + secondRect.width + padding,
  );
  const bottom = Math.min(
    firstRect.top + firstRect.height,
    secondRect.top + secondRect.height + padding,
  );

  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function doCanvasRectsOverlap(
  firstRect: CanvasRect,
  secondRect: CanvasRect,
  padding = 0,
) {
  return getCanvasRectOverlapArea(firstRect, secondRect, padding) > 0;
}

function getCanvasRectCenter(rect: CanvasRect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function getCanvasRectDistanceScore(
  firstRect: CanvasRect,
  secondRect: CanvasRect,
) {
  const firstCenter = getCanvasRectCenter(firstRect);
  const secondCenter = getCanvasRectCenter(secondRect);
  const distanceX = firstCenter.x - secondCenter.x;
  const distanceY = firstCenter.y - secondCenter.y;

  return distanceX * distanceX + distanceY * distanceY;
}

function pickCanvasLabelRect(input: {
  bboxRect: CanvasRect;
  labelWidth: number;
  labelHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  gap: number;
  placedLabelRects: CanvasRect[];
  bboxRects: CanvasRect[];
}) {
  const {
    bboxRect,
    labelWidth,
    labelHeight,
    canvasWidth,
    canvasHeight,
    gap,
    placedLabelRects,
    bboxRects,
  } = input;
  const leftOffsets = [
    bboxRect.left,
    bboxRect.left + bboxRect.width - labelWidth,
    bboxRect.left + bboxRect.width + gap,
    bboxRect.left - labelWidth - gap,
  ];
  const topOffsets = [
    bboxRect.top - labelHeight - gap,
    bboxRect.top + bboxRect.height + gap,
    bboxRect.top,
    bboxRect.top + bboxRect.height - labelHeight,
  ];
  const rawCandidates: CanvasRect[] = [
    ...leftOffsets.flatMap((left) => [
      {
        left,
        top: bboxRect.top - labelHeight - gap,
        width: labelWidth,
        height: labelHeight,
      },
      {
        left,
        top: bboxRect.top + bboxRect.height + gap,
        width: labelWidth,
        height: labelHeight,
      },
    ]),
    ...topOffsets.flatMap((top) => [
      {
        left: bboxRect.left + bboxRect.width + gap,
        top,
        width: labelWidth,
        height: labelHeight,
      },
      {
        left: bboxRect.left - labelWidth - gap,
        top,
        width: labelWidth,
        height: labelHeight,
      },
    ]),
    {
      left: bboxRect.left + gap,
      top: bboxRect.top + gap,
      width: labelWidth,
      height: labelHeight,
    },
  ];
  const candidates = rawCandidates.reduce<CanvasRect[]>((uniqueRects, rect) => {
    const clampedRect = clampCanvasRectPosition(
      rect,
      canvasWidth,
      canvasHeight,
    );
    const duplicateRect = uniqueRects.some(
      (currentRect) =>
        Math.abs(currentRect.left - clampedRect.left) < 1 &&
        Math.abs(currentRect.top - clampedRect.top) < 1,
    );

    return duplicateRect ? uniqueRects : [...uniqueRects, clampedRect];
  }, []);
  const hasNoPlacedLabelOverlap = (candidate: CanvasRect) =>
    placedLabelRects.every(
      (placedLabelRect) =>
        !doCanvasRectsOverlap(candidate, placedLabelRect, gap),
    );
  const hasNoBboxOverlap = (candidate: CanvasRect) =>
    bboxRects.every(
      (currentBboxRect) =>
        !doCanvasRectsOverlap(candidate, currentBboxRect, gap),
    );

  return (
    candidates.find(
      (candidate) =>
        hasNoPlacedLabelOverlap(candidate) && hasNoBboxOverlap(candidate),
    ) ??
    candidates.find((candidate) => hasNoPlacedLabelOverlap(candidate)) ??
    candidates
      .map((candidate) => {
        const labelOverlapScore = placedLabelRects.reduce(
          (sum, placedLabelRect) =>
            sum + getCanvasRectOverlapArea(candidate, placedLabelRect, gap),
          0,
        );
        const bboxOverlapScore = bboxRects.reduce(
          (sum, currentBboxRect) =>
            sum + getCanvasRectOverlapArea(candidate, currentBboxRect, gap),
          0,
        );

        return {
          candidate,
          score:
            labelOverlapScore * 8 +
            bboxOverlapScore * 4 +
            getCanvasRectDistanceScore(candidate, bboxRect) * 0.0001,
        };
      })
      .sort((firstCandidate, secondCandidate) => {
        return firstCandidate.score - secondCandidate.score;
      })[0]?.candidate ??
    clampCanvasRectPosition(
      {
        left: bboxRect.left,
        top: bboxRect.top - labelHeight - gap,
        width: labelWidth,
        height: labelHeight,
      },
      canvasWidth,
      canvasHeight,
    )
  );
}

function drawLabelConnector(
  context: CanvasRenderingContext2D,
  bboxRect: CanvasRect,
  labelRect: CanvasRect,
  lineWidth: number,
) {
  if (doCanvasRectsOverlap(bboxRect, labelRect)) {
    return;
  }

  const bboxCenter = getCanvasRectCenter(bboxRect);
  const labelCenter = getCanvasRectCenter(labelRect);

  context.save();
  context.strokeStyle = 'rgba(255, 153, 0, 0.76)';
  context.lineWidth = Math.max(1, Math.round(lineWidth * 0.6));
  context.beginPath();
  context.moveTo(labelCenter.x, labelCenter.y);
  context.lineTo(bboxCenter.x, bboxCenter.y);
  context.stroke();
  context.restore();
}

async function buildAnnotatedReferencePageBlob(input: {
  sourceUrl: string;
  matches: PdfEvidenceMatch[];
  pdfRenderConfig: ReturnType<typeof getPdfRenderConfig>;
}) {
  const { image, objectUrl } = await loadImageElementForCanvas(input.sourceUrl);

  try {
    const canvas = document.createElement('canvas');
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const context = canvas.getContext('2d');

    if (!context || width <= 0 || height <= 0) {
      throw new Error('参考图画布创建失败。');
    }

    canvas.width = width;
    canvas.height = height;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    const annotatedCanvas = createOptimizedPdfJpegCanvas(
      canvas,
      input.pdfRenderConfig,
    );
    const annotatedContext = annotatedCanvas.getContext('2d');
    const annotatedWidth = annotatedCanvas.width;
    const annotatedHeight = annotatedCanvas.height;

    if (!annotatedContext || annotatedWidth <= 0 || annotatedHeight <= 0) {
      throw new Error('带定位参考图画布创建失败。');
    }

    const lineWidth = Math.max(
      2,
      Math.round(Math.min(annotatedWidth, annotatedHeight) * 0.0015),
    );
    const labelFontSize = Math.max(
      10,
      Math.round(Math.min(annotatedWidth, annotatedHeight) * 0.006),
    );
    const labelPaddingX = Math.max(4, Math.round(labelFontSize * 0.28));
    const labelPaddingY = Math.max(2, Math.round(labelFontSize * 0.18));
    const groupedMatches = new Map<string, PdfEvidenceMatch[]>();

    input.matches.forEach((match) => {
      if (!match.bbox) {
        return;
      }

      const key = [
        match.bbox.x,
        match.bbox.y,
        match.bbox.width,
        match.bbox.height,
      ]
        .map((value) => Number(value).toFixed(6))
        .join(':');
      const currentMatches = groupedMatches.get(key) ?? [];

      currentMatches.push(match);
      groupedMatches.set(key, currentMatches);
    });

    annotatedContext.font = `${labelFontSize}px Arial, sans-serif`;
    annotatedContext.textBaseline = 'top';

    const annotationEntries = Array.from(groupedMatches.values())
      .flatMap((matches) => {
        const bbox = matches[0]?.bbox;

        if (!bbox) {
          return [];
        }

        const left = Math.max(
          0,
          Math.min(annotatedWidth, bbox.x * annotatedWidth),
        );
        const top = Math.max(
          0,
          Math.min(annotatedHeight, bbox.y * annotatedHeight),
        );
        const boxWidth = Math.max(
          1,
          Math.min(annotatedWidth - left, bbox.width * annotatedWidth),
        );
        const boxHeight = Math.max(
          1,
          Math.min(annotatedHeight - top, bbox.height * annotatedHeight),
        );
        const labels = matches.map(getPdfEvidenceMatchSlotKey).filter(Boolean);

        if (labels.length === 0) {
          return [];
        }

        const measuredWidth = Math.max(
          ...labels.map((label) => annotatedContext.measureText(label).width),
        );
        const labelLineHeight = Math.ceil(labelFontSize * 1.14);
        const labelWidth = Math.ceil(measuredWidth) + labelPaddingX * 2;
        const labelHeight = labels.length * labelLineHeight + labelPaddingY * 2;

        return [
          {
            bboxRect: {
              left,
              top,
              width: boxWidth,
              height: boxHeight,
            },
            labels,
            labelLineHeight,
            labelWidth,
            labelHeight,
          },
        ];
      })
      .sort((firstEntry, secondEntry) => {
        return (
          firstEntry.bboxRect.top - secondEntry.bboxRect.top ||
          firstEntry.bboxRect.left - secondEntry.bboxRect.left
        );
      });
    const bboxRects = annotationEntries.map((entry) => entry.bboxRect);

    annotationEntries.forEach(({ bboxRect }) => {
      annotatedContext.fillStyle = 'rgba(255, 153, 0, 0.08)';
      annotatedContext.fillRect(
        bboxRect.left,
        bboxRect.top,
        bboxRect.width,
        bboxRect.height,
      );
      annotatedContext.strokeStyle = '#ff9900';
      annotatedContext.lineWidth = lineWidth;
      annotatedContext.strokeRect(
        bboxRect.left,
        bboxRect.top,
        bboxRect.width,
        bboxRect.height,
      );
    });

    const placedLabelRects: CanvasRect[] = [];

    annotationEntries.forEach(
      ({ bboxRect, labels, labelLineHeight, labelWidth, labelHeight }) => {
        const labelRect = pickCanvasLabelRect({
          bboxRect,
          labelWidth,
          labelHeight,
          canvasWidth: annotatedWidth,
          canvasHeight: annotatedHeight,
          gap: lineWidth,
          placedLabelRects,
          bboxRects,
        });

        drawLabelConnector(annotatedContext, bboxRect, labelRect, lineWidth);
        annotatedContext.fillStyle = 'rgba(255, 153, 0, 0.92)';
        annotatedContext.fillRect(
          labelRect.left,
          labelRect.top,
          labelRect.width,
          labelRect.height,
        );
        annotatedContext.fillStyle = '#111111';
        labels.forEach((label, labelIndex) => {
          annotatedContext.fillText(
            label,
            labelRect.left + labelPaddingX,
            labelRect.top + labelPaddingY + labelIndex * labelLineHeight,
          );
        });
        placedLabelRects.push(labelRect);
      },
    );

    return canvasToJpegBlob(
      annotatedCanvas,
      input.pdfRenderConfig.imageQuality,
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function uploadAnnotatedReferencePagesForTemplate(input: {
  templateId: string;
  payload: SlotReviewSessionPayload;
  pageNumbersToRefresh?: number[];
}) {
  const pdfEvidence = input.payload.pdfEvidence;

  if (!pdfEvidence?.pages.length || !pdfEvidence.matches.length) {
    return input.payload;
  }

  const supabase = getSupabaseBrowserClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error('请先登录后再保存带定位参考图。');
  }

  const matchesByPageNumber = new Map<number, PdfEvidenceMatch[]>();
  const pageNumberFilter = input.pageNumbersToRefresh
    ? new Set(input.pageNumbersToRefresh)
    : null;

  if (pageNumberFilter && pageNumberFilter.size === 0) {
    browserProcessLog.info(
      '[Slot Review][Annotated Reference] No changed pages',
    );
    return input.payload;
  }

  pdfEvidence.matches.forEach((match) => {
    if (
      !match.bbox ||
      (pageNumberFilter && !pageNumberFilter.has(match.page_number))
    ) {
      return;
    }

    const pageMatches = matchesByPageNumber.get(match.page_number) ?? [];

    pageMatches.push(match);
    matchesByPageNumber.set(match.page_number, pageMatches);
  });

  if (matchesByPageNumber.size === 0) {
    return input.payload;
  }

  const startedAt = performance.now();
  const pdfRenderConfig = getPdfRenderConfig();
  const renderConcurrency = getPdfVisionRenderConcurrency();
  const uploadConcurrency = getPdfStorageUploadConcurrency();
  const uploadedStoragePaths = new Map<number, string>();
  const pagesToRefresh = (
    await Promise.all(
      pdfEvidence.pages.map(async (page) => {
        const matches = matchesByPageNumber.get(page.pageNumber) ?? [];

        if (matches.length === 0) {
          return null;
        }

        const sourceUrl = await getFreshReferencePageImageSource({
          page,
          supabase,
        });

        if (!sourceUrl) {
          return null;
        }

        return {
          page,
          matches,
          sourceUrl,
        };
      }),
    )
  ).filter(
    (
      pageToRefresh,
    ): pageToRefresh is {
      page: (typeof pdfEvidence.pages)[number];
      matches: PdfEvidenceMatch[];
      sourceUrl: string;
    } => Boolean(pageToRefresh),
  );

  browserProcessLog.info('[Slot Review][Annotated Reference] Upload started', {
    templateId: input.templateId,
    pageCount: pagesToRefresh.length,
    renderConcurrency,
    uploadConcurrency,
    imageFormat: 'image/jpeg',
    imageQuality: pdfRenderConfig.imageQuality,
    jpegMaxLongEdge: pdfRenderConfig.jpegMaxLongEdge,
    jpegBackgroundCleanup: pdfRenderConfig.jpegBackgroundCleanup,
    jpegGrayscale: pdfRenderConfig.jpegGrayscale,
    jpegBackgroundWhiteThreshold: pdfRenderConfig.jpegBackgroundWhiteThreshold,
    jpegBackgroundInkThreshold: pdfRenderConfig.jpegBackgroundInkThreshold,
    jpegContrast: pdfRenderConfig.jpegContrast,
  });

  const annotatedPages = await runWithConcurrency(
    pagesToRefresh,
    renderConcurrency,
    async ({ page, matches, sourceUrl }) => {
      const pageStartedAt = performance.now();
      const annotatedBlob = await buildAnnotatedReferencePageBlob({
        sourceUrl,
        matches,
        pdfRenderConfig,
      });
      const durationMs = Math.round(performance.now() - pageStartedAt);
      const storagePath = `${user.id}/template-reference-pages/annotated/${input.templateId}/page-${page.pageNumber}.jpg`;

      browserProcessLog.info(
        '[Slot Review][Annotated Reference] Page rendered',
        {
          templateId: input.templateId,
          pageNumber: page.pageNumber,
          storagePath,
          slotCount: matches.length,
          size: annotatedBlob.size,
          sizeMb: formatMegabytes(annotatedBlob.size),
          durationMs,
          renderConcurrency,
          imageFormat: 'image/jpeg',
          imageQuality: pdfRenderConfig.imageQuality,
          jpegMaxLongEdge: pdfRenderConfig.jpegMaxLongEdge,
          jpegBackgroundCleanup: pdfRenderConfig.jpegBackgroundCleanup,
          jpegGrayscale: pdfRenderConfig.jpegGrayscale,
          jpegContrast: pdfRenderConfig.jpegContrast,
        },
      );

      return {
        pageNumber: page.pageNumber,
        matches,
        annotatedBlob,
        storagePath,
        renderDurationMs: durationMs,
      };
    },
  );

  await runWithConcurrency(
    annotatedPages,
    uploadConcurrency,
    async ({
      pageNumber,
      matches,
      annotatedBlob,
      storagePath,
      renderDurationMs,
    }) => {
      const uploadStartedAt = performance.now();
      const { error } = await supabase.storage
        .from('generation-pdfs')
        .upload(storagePath, annotatedBlob, {
          contentType: 'image/jpeg',
          upsert: true,
        });

      if (error) {
        throw new Error(
          `保存第 ${pageNumber} 页带定位参考图失败：${error.message}`,
        );
      }

      uploadedStoragePaths.set(pageNumber, storagePath);
      browserProcessLog.info(
        '[Slot Review][Annotated Reference] Page uploaded',
        {
          templateId: input.templateId,
          pageNumber,
          storagePath,
          slotCount: matches.length,
          size: annotatedBlob.size,
          sizeMb: formatMegabytes(annotatedBlob.size),
          renderDurationMs,
          uploadDurationMs: Math.round(performance.now() - uploadStartedAt),
          uploadConcurrency,
          contentType: 'image/jpeg',
        },
      );
    },
  );

  browserProcessLog.info(
    '[Slot Review][Annotated Reference] Upload completed',
    {
      templateId: input.templateId,
      pageCount: uploadedStoragePaths.size,
      totalSize: annotatedPages.reduce(
        (sum, page) => sum + page.annotatedBlob.size,
        0,
      ),
      totalSizeMb: formatMegabytes(
        annotatedPages.reduce((sum, page) => sum + page.annotatedBlob.size, 0),
      ),
      renderConcurrency,
      uploadConcurrency,
      durationMs: Math.round(performance.now() - startedAt),
    },
  );

  return {
    ...input.payload,
    pdfEvidence: {
      ...pdfEvidence,
      pages: pdfEvidence.pages.map((page) => ({
        ...page,
        ...(uploadedStoragePaths.has(page.pageNumber)
          ? { annotatedStoragePath: uploadedStoragePaths.get(page.pageNumber) }
          : {}),
      })),
    },
  } satisfies SlotReviewSessionPayload;
}

function logPdfBboxMappingDebug(input: {
  item: EditableExtractionItem;
  match: PdfEvidenceMatch;
  pageContainer: HTMLElement | null | undefined;
}) {
  const pageCanvas =
    input.pageContainer?.querySelector<HTMLCanvasElement>(
      'canvas[data-pdf-page-canvas]',
    ) ?? null;

  if (!input.pageContainer || !pageCanvas) {
    browserProcessLog.warn('[Slot Review][PDF BBox Debug] Missing DOM node', {
      slot: {
        id: input.item.id,
        field_category: input.item.field_category,
        original_value: input.item.original_value,
      },
      match: input.match,
      hasPageContainer: Boolean(input.pageContainer),
      hasCanvas: Boolean(pageCanvas),
    });
    return;
  }

  const writeDebugLog = () => {
    const canvasRect = pageCanvas.getBoundingClientRect();
    const pageRect = input.pageContainer!.getBoundingClientRect();
    const naturalWidth =
      Number(pageCanvas.dataset.naturalWidth) || pageCanvas.width;
    const naturalHeight =
      Number(pageCanvas.dataset.naturalHeight) || pageCanvas.height;
    const bbox = input.match.bbox;
    const finalCssCoordinate = bbox
      ? {
          left: bbox.x * canvasRect.width,
          top: bbox.y * canvasRect.height,
          width: bbox.width * canvasRect.width,
          height: bbox.height * canvasRect.height,
        }
      : null;
    const finalNaturalCoordinate = bbox
      ? {
          left: bbox.x * naturalWidth,
          top: bbox.y * naturalHeight,
          width: bbox.width * naturalWidth,
          height: bbox.height * naturalHeight,
        }
      : null;
    const warnings = [
      naturalWidth <= 0 || naturalHeight <= 0
        ? 'canvas_natural_size_not_ready'
        : null,
      canvasRect.width <= 0 || canvasRect.height <= 0
        ? 'canvas_display_size_not_ready'
        : null,
      bbox &&
      (bbox.x < 0 ||
        bbox.y < 0 ||
        bbox.width <= 0 ||
        bbox.height <= 0 ||
        bbox.x + bbox.width > 1 ||
        bbox.y + bbox.height > 1)
        ? 'bbox_outside_normalized_image'
        : null,
    ].filter(Boolean);

    browserProcessLog.info('[Slot Review][PDF BBox Debug]', {
      slot: {
        id: input.item.id,
        field_category: input.item.field_category,
        original_value: input.item.original_value,
        meaning_to_applicant: input.item.meaning_to_applicant,
      },
      match: {
        page_number: input.match.page_number,
        bbox: input.match.bbox,
        evidence_text: input.match.evidence_text,
        confidence: input.match.confidence,
        match_type: input.match.match_type,
      },
      imageNaturalSize: {
        width: naturalWidth,
        height: naturalHeight,
      },
      imageDisplaySize: {
        width: canvasRect.width,
        height: canvasRect.height,
      },
      imageOffsetInPageContainer: {
        left: canvasRect.left - pageRect.left,
        top: canvasRect.top - pageRect.top,
      },
      pageContainerDisplaySize: {
        width: pageRect.width,
        height: pageRect.height,
      },
      finalCssCoordinate,
      finalNaturalCoordinate,
      warnings,
    });
  };

  window.setTimeout(writeDebugLog, 0);
}

function persistSlotReviewPayloadToSession(payload: SlotReviewSessionPayload) {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.setItem(
    SLOT_REVIEW_SESSION_KEY,
    JSON.stringify(payload),
  );
}

function loadSlotReviewWorkspaceState(): SlotReviewWorkspaceState {
  if (typeof window === 'undefined') {
    return {
      payload: null,
      items: [],
      activeItemId: null,
      editingItemId: null,
      pendingSelectionByItemId: {},
      isAddingItem: false,
      pendingNewItemSelection: '',
      pendingNewItemParagraphIndex: null,
      pendingNewItemMeaning: '',
    };
  }

  const rawValue = window.sessionStorage.getItem(SLOT_REVIEW_SESSION_KEY);

  if (!rawValue) {
    return {
      payload: null,
      items: [],
      activeItemId: null,
      editingItemId: null,
      pendingSelectionByItemId: {},
      isAddingItem: false,
      pendingNewItemSelection: '',
      pendingNewItemParagraphIndex: null,
      pendingNewItemMeaning: '',
    };
  }

  const parsed = removeOrphanPdfEvidenceMatches(
    JSON.parse(rawValue) as SlotReviewSessionPayload,
  );
  const flattenedItems = flattenExtractionResult(parsed.extractionResult, {
    pdfEvidenceMatches: parsed.pdfEvidence?.matches,
  }).map((item) => ({
    ...item,
    field_category: normalizeSlotCategoryLabel(item.field_category),
  }));

  return {
    payload: parsed,
    items: flattenedItems,
    activeItemId: flattenedItems[0]?.id ?? null,
    editingItemId: null,
    pendingSelectionByItemId: {},
    isAddingItem: false,
    pendingNewItemSelection: '',
    pendingNewItemParagraphIndex: null,
    pendingNewItemMeaning: '',
  };
}

export function SlotReviewWorkspace() {
  const isJsonPreviewDebugEnabled = useJsonPreviewDebug();
  const router = useRouter();
  const queryClient = useQueryClient();
  const saveTemplateMutation = useSaveTemplate();
  const [workspaceState, setWorkspaceState] =
    useState<SlotReviewWorkspaceState>({
      payload: null,
      items: [],
      activeItemId: null,
      editingItemId: null,
      pendingSelectionByItemId: {},
      isAddingItem: false,
      pendingNewItemSelection: '',
      pendingNewItemParagraphIndex: null,
      pendingNewItemMeaning: '',
    });
  const [pdfLocationEditState, setPdfLocationEditState] =
    useState<PdfLocationEditState | null>(null);
  const [pdfZoom, setPdfZoom] = useState(1);
  const [isSlotPanelCollapsed, setIsSlotPanelCollapsed] = useState(false);
  const documentViewportRef = useRef<HTMLDivElement | null>(null);
  const documentContentRef = useRef<HTMLDivElement | null>(null);
  const pdfViewportRef = useRef<HTMLDivElement | null>(null);
  const pdfPageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const {
    payload,
    items,
    activeItemId,
    editingItemId,
    pendingSelectionByItemId,
    isAddingItem,
    pendingNewItemSelection,
    pendingNewItemParagraphIndex,
    pendingNewItemMeaning,
  } = workspaceState;

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setWorkspaceState(loadSlotReviewWorkspaceState());
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  const visibleItems = useMemo(() => {
    if (!payload) {
      return [];
    }

    if (payload.parsedDocument) {
      return resolveStructuredPreviewItems(
        payload.parsedDocument,
        payload.uploadText,
        items,
      );
    }

    return filterPlainPreviewItems(payload.uploadText, items);
  }, [items, payload]);

  const previewItems = useMemo(
    () =>
      buildPreviewItems(
        visibleItems,
        isAddingItem,
        pendingNewItemSelection,
        pendingNewItemParagraphIndex,
      ),
    [
      isAddingItem,
      pendingNewItemParagraphIndex,
      pendingNewItemSelection,
      visibleItems,
    ],
  );

  const highlightedText = useMemo(() => {
    if (!payload) {
      return '';
    }

    if (payload.uploadHtml) {
      return highlightDocumentHtml(
        payload.uploadHtml,
        previewItems,
        isAddingItem ? 'pending-new-item' : activeItemId,
        editingItemId,
      );
    }

    return highlightPlainText(
      payload.uploadText,
      previewItems,
      isAddingItem ? 'pending-new-item' : activeItemId,
      editingItemId,
    );
  }, [activeItemId, editingItemId, isAddingItem, payload, previewItems]);

  const resolvedPreviewItems = useMemo(() => {
    if (!payload?.parsedDocument) {
      return [];
    }

    return resolveStructuredPreviewItems(
      payload.parsedDocument,
      payload.uploadText,
      previewItems,
    );
  }, [payload, previewItems]);

  const structuredPreview = useMemo(() => {
    if (!payload?.parsedDocument) {
      return null;
    }

    return renderStructuredBlocks(
      payload.parsedDocument.blocks,
      resolvedPreviewItems,
      isAddingItem ? 'pending-new-item' : activeItemId,
      editingItemId,
    );
  }, [
    activeItemId,
    editingItemId,
    isAddingItem,
    payload,
    resolvedPreviewItems,
  ]);

  useEffect(() => {
    if (!activeItemId || !documentViewportRef.current) {
      return;
    }

    const activeResolvedItem =
      resolvedPreviewItems.find((item) => item.id === activeItemId) ?? null;
    const targetParagraph =
      typeof activeResolvedItem?.paragraph_index === 'number'
        ? documentViewportRef.current.querySelector<HTMLElement>(
            `[data-preview-paragraph-index="${activeResolvedItem.paragraph_index}"]`,
          )
        : null;
    const activeMarker =
      targetParagraph?.querySelector<HTMLElement>(
        `[data-slot-id="${activeItemId}"]`,
      ) ??
      documentViewportRef.current.querySelector<HTMLElement>(
        `[data-slot-id="${activeItemId}"]`,
      );

    if (!activeMarker && !targetParagraph) {
      return;
    }

    (activeMarker ?? targetParagraph)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [activeItemId, highlightedText, resolvedPreviewItems, structuredPreview]);

  useEffect(() => {
    if (isAddingItem) {
      return;
    }

    if (activeItemId && visibleItems.some((item) => item.id === activeItemId)) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setWorkspaceState((currentState) => {
        const nextActiveItemId = visibleItems[0]?.id ?? null;

        if (currentState.activeItemId === nextActiveItemId) {
          return currentState;
        }

        return {
          ...currentState,
          activeItemId: nextActiveItemId,
          editingItemId:
            currentState.editingItemId &&
            visibleItems.some((item) => item.id === currentState.editingItemId)
              ? currentState.editingItemId
              : null,
        };
      });
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeItemId, isAddingItem, visibleItems]);

  const activeItem = useMemo(
    () => visibleItems.find((item) => item.id === activeItemId) ?? null,
    [activeItemId, visibleItems],
  );
  const activeItemIndex = visibleItems.findIndex(
    (item) => item.id === activeItemId,
  );
  const activeEvidenceMatch = useMemo(
    () => findPdfEvidenceMatchForItem(activeItem, payload),
    [activeItem, payload],
  );
  const editingItem = useMemo(
    () => visibleItems.find((item) => item.id === editingItemId) ?? null,
    [editingItemId, visibleItems],
  );
  const pendingEditingSelection = editingItemId
    ? (pendingSelectionByItemId[editingItemId] ?? '')
    : '';

  const selectVisibleItemByOffset = (offset: number) => {
    if (visibleItems.length === 0) {
      return;
    }

    const currentIndex = activeItemIndex >= 0 ? activeItemIndex : 0;
    const nextIndex =
      (currentIndex + offset + visibleItems.length) % visibleItems.length;
    const nextItem = visibleItems[nextIndex];

    if (!nextItem) {
      return;
    }

    setWorkspaceState((currentState) => ({
      ...currentState,
      activeItemId: nextItem.id,
    }));
    setPdfLocationEditState(null);
  };

  const scrollPdfPageIntoView = (pageNumber: number, bbox?: PdfBbox | null) => {
    const viewport = pdfViewportRef.current;
    const targetPage = pdfPageRefs.current[pageNumber];

    if (!viewport || !targetPage) {
      targetPage?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      return;
    }

    const bboxCenterOffset = bbox
      ? targetPage.offsetHeight * (bbox.y + bbox.height / 2)
      : targetPage.offsetHeight / 2;
    const nextScrollTop = Math.max(
      0,
      targetPage.offsetTop + bboxCenterOffset - viewport.clientHeight / 2,
    );

    viewport.scrollTo({
      top: nextScrollTop,
      behavior: 'smooth',
    });
  };

  const getPdfScrollAnchor = (): PdfScrollAnchor | null => {
    const viewport = pdfViewportRef.current;

    if (!viewport) {
      return null;
    }

    const viewportCenterY = viewport.scrollTop + viewport.clientHeight / 2;
    const pageEntries = Object.entries(pdfPageRefs.current)
      .map(([pageNumber, pageElement]) => ({
        pageNumber: Number(pageNumber),
        pageElement,
      }))
      .filter(
        (entry): entry is { pageNumber: number; pageElement: HTMLDivElement } =>
          Number.isInteger(entry.pageNumber) && Boolean(entry.pageElement),
      )
      .sort((left, right) => left.pageNumber - right.pageNumber);

    const centeredEntry =
      pageEntries.find(
        ({ pageElement }) =>
          viewportCenterY >= pageElement.offsetTop &&
          viewportCenterY <= pageElement.offsetTop + pageElement.offsetHeight,
      ) ?? pageEntries[0];

    if (!centeredEntry) {
      return null;
    }

    return {
      pageNumber: centeredEntry.pageNumber,
      relativeY: clampPdfCoordinate(
        (viewportCenterY - centeredEntry.pageElement.offsetTop) /
          Math.max(1, centeredEntry.pageElement.offsetHeight),
      ),
    };
  };

  const restorePdfScrollAnchor = (anchor: PdfScrollAnchor | null) => {
    if (!anchor) {
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const viewport = pdfViewportRef.current;
        const pageElement = pdfPageRefs.current[anchor.pageNumber];

        if (!viewport || !pageElement) {
          return;
        }

        viewport.scrollTo({
          top: Math.max(
            0,
            pageElement.offsetTop +
              pageElement.offsetHeight * anchor.relativeY -
              viewport.clientHeight / 2,
          ),
          behavior: 'auto',
        });
      });
    });
  };

  const updatePdfZoom = (resolveNextZoom: (currentZoom: number) => number) => {
    const anchor = getPdfScrollAnchor();

    setPdfZoom((currentZoom) =>
      clampPdfZoom(Number(resolveNextZoom(currentZoom).toFixed(2))),
    );
    restorePdfScrollAnchor(anchor);
  };

  useEffect(() => {
    if (!activeItem || !activeEvidenceMatch) {
      return;
    }

    scrollPdfPageIntoView(
      activeEvidenceMatch.page_number,
      activeEvidenceMatch.bbox,
    );

    const timeoutId = window.setTimeout(() => {
      logPdfBboxMappingDebug({
        item: activeItem,
        match: activeEvidenceMatch,
        pageContainer: pdfPageRefs.current[activeEvidenceMatch.page_number],
      });
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeEvidenceMatch, activeItem]);

  const handleDocumentMouseUp = () => {
    if ((!editingItemId && !isAddingItem) || !documentContentRef.current) {
      return;
    }

    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? '';

    if (!selection || selection.rangeCount === 0 || !selectedText) {
      return;
    }

    const range = selection.getRangeAt(0);
    const commonAncestor =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;

    if (
      !commonAncestor ||
      !documentContentRef.current.contains(commonAncestor)
    ) {
      return;
    }

    const selectedParagraphIndex =
      findClosestPreviewParagraphIndex(range.startContainer) ??
      findClosestPreviewParagraphIndex(range.endContainer) ??
      findClosestPreviewParagraphIndex(commonAncestor);

    setWorkspaceState((currentState) => {
      if (currentState.isAddingItem) {
        return {
          ...currentState,
          pendingNewItemSelection: selectedText,
          pendingNewItemParagraphIndex: selectedParagraphIndex,
        };
      }

      if (!currentState.editingItemId) {
        return currentState;
      }

      return {
        ...currentState,
        pendingSelectionByItemId: {
          ...currentState.pendingSelectionByItemId,
          [currentState.editingItemId]: selectedText,
        },
      };
    });

    selection.removeAllRanges();

    notifications.show({
      color: 'teal',
      title: '已暂存新的框选内容',
      message: isAddingItem
        ? '当前只是暂存新槽位的候选值，填写槽位来源后点击“保存新增”才会真正加入模板。'
        : '当前只是暂存候选值，点击槽位上的“保存”后才会真正更新槽位抽取值。',
    });
  };

  const handleStartPdfLocationEdit = (targetItem = activeItem) => {
    if (!payload?.pdfEvidence) {
      notifications.show({
        color: 'yellow',
        title: '当前没有 PDF 证据',
        message: '只上传 DOCX 的模板没有 PDF 页图，无法调整 PDF 定位。',
      });
      return;
    }

    if (!targetItem) {
      notifications.show({
        color: 'yellow',
        title: '请先选择槽位',
        message: '请先在右侧槽位清单中选择需要调整 PDF 定位的槽位。',
      });
      return;
    }

    const targetEvidenceMatch = findPdfEvidenceMatchForItem(
      targetItem,
      payload,
    );

    setPdfLocationEditState({
      itemId: targetItem.id,
      draftPageNumber: targetEvidenceMatch?.page_number ?? null,
      draftBbox: targetEvidenceMatch?.bbox ?? null,
      drag: null,
    });
    setWorkspaceState((currentState) => ({
      ...currentState,
      activeItemId: targetItem.id,
    }));
  };

  const handlePdfPageMouseDown = (
    event: MouseEvent<HTMLElement>,
    pageNumber: number,
  ) => {
    if (!pdfLocationEditState || pdfLocationEditState.itemId !== activeItemId) {
      return;
    }

    event.preventDefault();
    const startPoint = getNormalizedPdfPointerPosition(event);

    setPdfLocationEditState((currentState) =>
      currentState
        ? {
            ...currentState,
            draftPageNumber: pageNumber,
            draftBbox: buildPdfBboxFromPoints(
              startPoint.x,
              startPoint.y,
              startPoint.x,
              startPoint.y,
            ),
            drag: {
              pageNumber,
              startX: startPoint.x,
              startY: startPoint.y,
              currentX: startPoint.x,
              currentY: startPoint.y,
            },
          }
        : currentState,
    );
  };

  const handlePdfPageMouseMove = (
    event: MouseEvent<HTMLElement>,
    pageNumber: number,
  ) => {
    if (
      !pdfLocationEditState?.drag ||
      pdfLocationEditState.drag.pageNumber !== pageNumber
    ) {
      return;
    }

    event.preventDefault();
    const nextPoint = getNormalizedPdfPointerPosition(event);

    setPdfLocationEditState((currentState) => {
      if (!currentState?.drag || currentState.drag.pageNumber !== pageNumber) {
        return currentState;
      }

      return {
        ...currentState,
        draftPageNumber: pageNumber,
        draftBbox: buildPdfBboxFromPoints(
          currentState.drag.startX,
          currentState.drag.startY,
          nextPoint.x,
          nextPoint.y,
        ),
        drag: {
          ...currentState.drag,
          currentX: nextPoint.x,
          currentY: nextPoint.y,
        },
      };
    });
  };

  const handlePdfPageMouseUp = () => {
    setPdfLocationEditState((currentState) =>
      currentState ? { ...currentState, drag: null } : currentState,
    );
  };

  const handleSavePdfLocationEdit = () => {
    if (
      !pdfLocationEditState ||
      !pdfLocationEditState.draftPageNumber ||
      !pdfLocationEditState.draftBbox ||
      !activeItem
    ) {
      notifications.show({
        color: 'yellow',
        title: '请先在 PDF 上框选位置',
        message: '进入调整模式后，请在任意 PDF 页面上拖拽画出槽位证据位置。',
      });
      return;
    }

    if (
      pdfLocationEditState.draftBbox.width < 0.005 ||
      pdfLocationEditState.draftBbox.height < 0.005
    ) {
      notifications.show({
        color: 'yellow',
        title: '框选范围太小',
        message: '请拖拽出一个更清晰的框选范围后再保存。',
      });
      return;
    }

    setWorkspaceState((currentState) => {
      if (!currentState.payload?.pdfEvidence) {
        return currentState;
      }

      const currentItem =
        currentState.items.find((item) => item.id === activeItem.id) ??
        activeItem;
      const existingMatch = findPdfEvidenceMatchForItem(
        currentItem,
        currentState.payload,
      );
      const nextMatch = buildManualPdfEvidenceMatch({
        item: currentItem,
        pageNumber: pdfLocationEditState.draftPageNumber!,
        bbox: pdfLocationEditState.draftBbox!,
        existingMatch,
      });
      const currentMatches = currentState.payload.pdfEvidence.matches;
      const hasExistingMatch = currentMatches.some((match) =>
        isPdfEvidenceMatchForItem(match, currentItem),
      );
      let nextMatches: PdfEvidenceMatch[];

      if (hasExistingMatch) {
        nextMatches = currentMatches.map((match) => {
          const isCurrentItemMatch = isPdfEvidenceMatchForItem(
            match,
            currentItem,
          );

          if (isCurrentItemMatch) {
            return nextMatch;
          }

          return match;
        });
      } else {
        nextMatches = [...currentMatches, nextMatch];
      }
      const nextPayload: SlotReviewSessionPayload = {
        ...currentState.payload,
        pdfEvidence: {
          ...currentState.payload.pdfEvidence,
          matches: nextMatches,
        },
      };
      const nextItems = currentState.items.map((item) =>
        item.id === currentItem.id
          ? {
              ...item,
              pdf_evidence_match: nextMatch,
            }
          : item,
      );

      persistSlotReviewPayloadToSession(nextPayload);

      return {
        ...currentState,
        items: nextItems,
        payload: nextPayload,
      };
    });

    setPdfLocationEditState(null);
    notifications.show({
      color: 'teal',
      title: 'PDF 定位已更新',
      message: '新的页码和框选位置已保存到当前槽位核查结果中。',
    });
  };

  const jsonPreview = useMemo(() => {
    if (!payload) {
      return '';
    }

    return JSON.stringify(
      buildJsonPreviewPayload(visibleItems, payload),
      null,
      2,
    );
  }, [payload, visibleItems]);

  const saveTemplateWithName = async (templateName: string) => {
    if (!payload) {
      throw new Error('当前模板数据还未加载完成，请稍后再试。');
    }

    const nextExtractionResult = groupExtractionItemsByParagraph(
      visibleItems,
      payload.extractionResult,
    );
    const nextPayload = removeOrphanPdfEvidenceMatches({
      ...payload,
      templateName,
      extractionResult: nextExtractionResult,
    });
    const savedTemplate = await saveTemplateMutation.mutateAsync({
      templateId: payload.templateId,
      templateName,
      slotReviewPayload: nextPayload,
      slotPreview: buildJsonPreviewPayload(visibleItems, nextPayload),
    });
    let annotatedPayload: SlotReviewSessionPayload = {
      ...nextPayload,
      templateId: savedTemplate.id,
      templateName: savedTemplate.template_name,
    };
    let didSaveAnnotatedReferencePages = true;

    try {
      annotatedPayload = await uploadAnnotatedReferencePagesForTemplate({
        templateId: savedTemplate.id,
        payload: annotatedPayload,
        pageNumbersToRefresh:
          savedTemplate.annotated_reference_page_numbers_to_refresh,
      });
    } catch (error) {
      didSaveAnnotatedReferencePages = false;
      browserProcessLog.error(
        '[Slot Review][Annotated Reference] Upload failed',
        error,
      );
      notifications.show({
        color: 'yellow',
        title: '带定位参考图保存失败',
        message:
          error instanceof Error
            ? error.message
            : '模板已保存，但带定位参考图没有保存成功。后续回填可能缺少参考定位图。',
      });
    }

    const savedPayload: SlotReviewSessionPayload = {
      ...annotatedPayload,
      templateId: savedTemplate.id,
      templateName: savedTemplate.template_name,
      uploadDocxName:
        savedTemplate.upload_docx_name ??
        nextPayload.uploadDocxName ??
        nextPayload.fileName,
    };

    window.sessionStorage.setItem(
      SLOT_REVIEW_SESSION_KEY,
      JSON.stringify(savedPayload),
    );
    setWorkspaceState((currentState) => ({
      ...currentState,
      payload: savedPayload,
    }));

    notifications.show({
      color: 'teal',
      title: '模板已保存',
      message: didSaveAnnotatedReferencePages
        ? '模板名称、DOCX 原文件、当前 JSON 预览和带定位参考图都已保存。'
        : '模板已保存，但带定位参考图需要稍后重新保存一次。',
    });

    await queryClient.invalidateQueries({ queryKey: ['saved-templates'] });
    router.push('/home');
  };

  const handleSaveTemplate = () => {
    if (!payload) {
      notifications.show({
        color: 'yellow',
        title: '模板数据未加载',
        message: '当前模板数据还未加载完成，请稍后再试。',
      });
      return;
    }

    const existingTemplateName = payload.templateName?.trim();

    if (payload.templateId && existingTemplateName) {
      const savingNotificationId = 'slot-review-save-template';

      notifications.show({
        id: savingNotificationId,
        autoClose: false,
        color: 'teal',
        loading: true,
        title: '正在保存模板',
        message: '正在保存当前槽位、PDF 定位和带定位参考图，请稍候。',
        withCloseButton: false,
      });

      void saveTemplateWithName(existingTemplateName)
        .then(() => {
          notifications.hide(savingNotificationId);
        })
        .catch((error) => {
          notifications.hide(savingNotificationId);
          browserProcessLog.error('[Slot Review][Save Template] Save failed', {
            templateId: payload.templateId,
            error,
          });
          notifications.show({
            color: 'red',
            title: '模板保存失败',
            message:
              error instanceof Error
                ? error.message
                : '保存模板时发生未知错误，请稍后再试。',
          });
        });
      return;
    }

    openSaveTemplateModal({
      initialName: payload.templateName ?? '',
      onSave: saveTemplateWithName,
    });
  };

  if (!payload) {
    return (
      <Paper p="xl" radius="xl" withBorder>
        <Stack gap="md" align="center">
          <Title order={2}>正在恢复槽位识别结果</Title>
          <Text c="dimmed" ta="center">
            页面正在从当前浏览器会话中加载 DOCX
            预览与抽取结果。如果长时间没有内容，再返回首页重新识别一次。
          </Text>
        </Stack>
      </Paper>
    );
  }

  const pdfEvidencePages = payload.pdfEvidence?.pages ?? [];
  const hasPdfEvidence = Boolean(payload.pdfEvidence);
  const currentDocumentName =
    payload.documentInfo.document_name || payload.fileName;
  const docxPreviewDescription = isAddingItem
    ? '正在手动新增槽位。请先在左侧 DOCX 预览中框选一段连续文本作为槽位抽取值，再在右侧填写槽位来源并点击“保存新增”。'
    : editingItem
      ? `正在修改：${editingItem.field_category}。请先在左侧 DOCX 预览中框选一段连续文本，再点击右侧“保存”才会正式写回槽位。`
      : `当前文件：${currentDocumentName}`;
  const activeSlotSummary = activeItem
    ? `${activeItem.field_category}：${activeItem.original_value || '未填写'}`
    : '尚未选择槽位';

  return (
    <Stack gap="md" style={{ fontSize: 12 }}>
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <div>
            <Badge color="teal" radius="sm" variant="outline">
              抽取结果编辑
            </Badge>
            <Title mt="xs" order={3}>
              编辑 LLM 抽取出的槽位结果
            </Title>
          </div>
          <Group>
            <Button
              radius="xl"
              size="xs"
              variant="light"
              onClick={() => openSlotReviewGuideModal()}
            >
              使用说明
            </Button>
            <Button
              radius="xl"
              size="xs"
              variant="white"
              onClick={() => {
                return handleSaveTemplate();
              }}
            >
              保存模板
            </Button>
            <Button
              component={Link}
              href="/home"
              radius="xl"
              size="xs"
              variant="light"
            >
              返回首页
            </Button>
          </Group>
        </Group>
      </Stack>

      <Group
        align="stretch"
        gap="md"
        wrap="nowrap"
        justify={hasPdfEvidence ? 'flex-start' : 'center'}
        style={{ minWidth: 0, overflow: 'hidden' }}
      >
        <Paper
          p={isSlotPanelCollapsed ? 'xs' : 'md'}
          radius="xl"
          withBorder
          style={{
            background:
              'linear-gradient(180deg, rgba(37, 37, 37, 0.98), rgba(29, 29, 29, 0.98))',
            borderColor: 'rgba(255, 255, 255, 0.14)',
            flex: isSlotPanelCollapsed
              ? '0 0 54px'
              : hasPdfEvidence
                ? '0 0 300px'
                : '0 0 420px',
            height: 'calc(100vh - 178px)',
            minWidth: isSlotPanelCollapsed ? 54 : hasPdfEvidence ? 280 : 380,
            order: 3,
            overflow: 'hidden',
          }}
        >
          {isSlotPanelCollapsed ? (
            <Stack align="center" gap="sm" h="100%" justify="space-between">
              <Stack align="center" gap="sm">
                <Button
                  color="teal"
                  radius="xl"
                  size="compact-xs"
                  variant="filled"
                  onClick={() => setIsSlotPanelCollapsed(false)}
                >
                  展
                </Button>
                <Text
                  c="#fffaf0"
                  fw={800}
                  size="xs"
                  style={{ writingMode: 'vertical-rl' }}
                >
                  抽取槽位
                </Text>
                <Badge color="teal" radius="xl" size="sm" variant="filled">
                  {visibleItems.length}
                </Badge>
              </Stack>
              <Stack align="center" gap={6}>
                <Button
                  color="gray"
                  disabled={visibleItems.length <= 1}
                  radius="xl"
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => selectVisibleItemByOffset(-1)}
                >
                  ↑
                </Button>
                <Text
                  c="gray.4"
                  fw={700}
                  size="xs"
                  style={{
                    maxHeight: 120,
                    overflow: 'hidden',
                    textAlign: 'center',
                    writingMode: 'vertical-rl',
                  }}
                >
                  {activeItem?.field_category ?? '槽位'}
                </Text>
                <Button
                  color="gray"
                  disabled={visibleItems.length <= 1}
                  radius="xl"
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => selectVisibleItemByOffset(1)}
                >
                  ↓
                </Button>
                {payload.pdfEvidence ? (
                  <Button
                    color="orange"
                    disabled={!activeItem}
                    radius="xl"
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => handleStartPdfLocationEdit(activeItem)}
                  >
                    定
                  </Button>
                ) : null}
              </Stack>
            </Stack>
          ) : (
            <Stack gap="sm" h="100%">
              <Group align="flex-start" justify="space-between">
                <div>
                  <Title c="#fffaf0" order={4} size="h5">
                    抽取槽位
                  </Title>
                  <Text c="gray.5" mt={4} size="xs">
                    选择槽位后，左侧 DOCX 和中间 PDF 会联动定位。
                  </Text>
                </div>
                <Group gap={6}>
                  <Badge color="teal" radius="xl" variant="filled">
                    {visibleItems.length} 个
                  </Badge>
                </Group>
              </Group>
              <Button
                color="teal"
                disabled={Boolean(editingItemId)}
                fullWidth
                radius="xl"
                style={{
                  boxShadow: isAddingItem
                    ? '0 12px 28px rgba(18, 184, 134, 0.2)'
                    : undefined,
                }}
                variant="filled"
                onClick={() => {
                  if (editingItemId) {
                    notifications.show({
                      color: 'yellow',
                      title: '请先完成当前槽位修改',
                      message:
                        '当前正在修改已有槽位，请先保存或取消后再新增槽位。',
                    });
                    return;
                  }

                  setWorkspaceState((currentState) => ({
                    ...currentState,
                    activeItemId: null,
                    isAddingItem: !currentState.isAddingItem,
                    pendingNewItemSelection: currentState.isAddingItem
                      ? ''
                      : currentState.pendingNewItemSelection,
                    pendingNewItemParagraphIndex: currentState.isAddingItem
                      ? null
                      : currentState.pendingNewItemParagraphIndex,
                    pendingNewItemMeaning: currentState.isAddingItem
                      ? ''
                      : currentState.pendingNewItemMeaning,
                  }));
                }}
              >
                {isAddingItem ? '取消新增槽位' : '手动新增槽位'}
              </Button>
              <ScrollArea
                offsetScrollbars
                scrollbarSize={8}
                style={{ flex: 1 }}
                type="always"
              >
                <Stack gap="md">
                  {isAddingItem ? (
                    <Card
                      padding="sm"
                      radius="xl"
                      withBorder
                      style={{
                        background:
                          'linear-gradient(180deg, rgba(47, 47, 47, 0.96), rgba(38, 38, 38, 0.96))',
                        borderColor: '#38d39f',
                        boxShadow: '0 0 0 1px #38d39f inset',
                        color: '#fffaf0',
                      }}
                    >
                      <Stack gap="xs">
                        <Group justify="space-between">
                          <Badge color="teal" variant="filled">
                            手动新增
                          </Badge>
                          <Group gap="xs">
                            <Button
                              color="yellow"
                              radius="xl"
                              size="compact-xs"
                              variant="subtle"
                              onClick={() =>
                                setWorkspaceState((currentState) => ({
                                  ...currentState,
                                  isAddingItem: false,
                                  pendingNewItemSelection: '',
                                  pendingNewItemParagraphIndex: null,
                                  pendingNewItemMeaning: '',
                                }))
                              }
                            >
                              取消
                            </Button>
                            <Button
                              color="teal"
                              radius="xl"
                              size="compact-xs"
                              variant="filled"
                              onClick={() => {
                                if (
                                  !pendingNewItemSelection.trim() ||
                                  !pendingNewItemMeaning.trim()
                                ) {
                                  notifications.show({
                                    color: 'yellow',
                                    title: '新增槽位信息不完整',
                                    message:
                                      '请先在 DOCX 预览中框选槽位抽取值，并填写槽位来源后再保存新增槽位。',
                                  });
                                  return;
                                }

                                setWorkspaceState((currentState) => {
                                  const nextSequence =
                                    currentState.items.reduce(
                                      (maxSequence, item) =>
                                        Math.max(maxSequence, item.sequence),
                                      0,
                                    ) + 1;
                                  const draftItem: EditableExtractionItem = {
                                    id: `pending-manual-${nextSequence}`,
                                    slot_key: `pending-manual-${nextSequence}`,
                                    paragraphTitle: '手动新增槽位',
                                    sequence: nextSequence,
                                    field_category: '手动新增',
                                    original_value:
                                      currentState.pendingNewItemSelection.trim(),
                                    meaning_to_applicant:
                                      currentState.pendingNewItemMeaning.trim(),
                                    original_doc_position:
                                      currentState.pendingNewItemSelection.trim(),
                                    paragraph_index:
                                      currentState.pendingNewItemParagraphIndex ??
                                      undefined,
                                    pdf_evidence_match: null,
                                  };
                                  const slotKey = createManualSlotKeyForNewItem(
                                    {
                                      items: currentState.items,
                                      sourceParagraphs:
                                        currentState.payload
                                          ?.extractionResult ?? [],
                                      draftItem,
                                    },
                                  );
                                  const newItem: EditableExtractionItem = {
                                    ...draftItem,
                                    id: slotKey,
                                    slot_key: slotKey,
                                    pdf_evidence_match: null,
                                  };

                                  return {
                                    ...currentState,
                                    items: [...currentState.items, newItem],
                                    activeItemId: newItem.id,
                                    isAddingItem: false,
                                    pendingNewItemSelection: '',
                                    pendingNewItemParagraphIndex: null,
                                    pendingNewItemMeaning: '',
                                  };
                                });

                                notifications.show({
                                  color: 'teal',
                                  title: '新增槽位已加入',
                                  message:
                                    '手动新增槽位已经加入当前模板编辑结果，记得点击顶部“保存模板”完成保存。',
                                });
                              }}
                            >
                              保存新增
                            </Button>
                          </Group>
                        </Group>
                        <TextInput
                          label="槽位抽取值"
                          readOnly
                          size="xs"
                          styles={{
                            input: {
                              background: 'rgba(255, 255, 255, 0.04)',
                              borderColor: 'rgba(255, 255, 255, 0.16)',
                              color: '#fffaf0',
                            },
                            label: { color: '#d8f7eb' },
                          }}
                          value={pendingNewItemSelection}
                        />
                        <TextInput
                          label="槽位来源"
                          size="xs"
                          styles={{
                            input: {
                              background: 'rgba(255, 255, 255, 0.04)',
                              borderColor: 'rgba(255, 255, 255, 0.16)',
                              color: '#fffaf0',
                            },
                            label: { color: '#d8f7eb' },
                          }}
                          value={pendingNewItemMeaning}
                          onChange={(event) => {
                            const nextMeaning = event.currentTarget.value;

                            setWorkspaceState((currentState) => ({
                              ...currentState,
                              pendingNewItemMeaning: nextMeaning,
                            }));
                          }}
                        />
                        <Text c="yellow" size="xs">
                          新增中：槽位抽取值必须通过 DOCX
                          预览框选生成，不能手动输入；槽位来源填写后才能保存新增。
                        </Text>
                      </Stack>
                    </Card>
                  ) : null}
                  {visibleItems.map((item) => {
                    const isActive = item.id === activeItemId;
                    const isEditing = item.id === editingItemId;
                    const isLockedByOtherEditing = Boolean(
                      (editingItemId && editingItemId !== item.id) ||
                      isAddingItem,
                    );
                    const pendingSelection =
                      pendingSelectionByItemId[item.id] ?? '';
                    const evidenceMatch = findPdfEvidenceMatchForItem(
                      item,
                      payload,
                    );

                    return (
                      <Card
                        key={item.id}
                        padding="sm"
                        radius="xl"
                        withBorder
                        style={{
                          background: isActive
                            ? 'linear-gradient(180deg, rgba(42, 47, 43, 0.98), rgba(37, 39, 38, 0.98))'
                            : 'linear-gradient(180deg, rgba(43, 43, 43, 0.96), rgba(35, 35, 35, 0.96))',
                          cursor: 'pointer',
                          opacity: isLockedByOtherEditing ? 0.72 : 1,
                          borderColor: isActive
                            ? '#38d39f'
                            : 'rgba(255, 255, 255, 0.12)',
                          boxShadow: isActive
                            ? '0 0 0 1px #38d39f inset, 0 18px 48px rgba(18, 184, 134, 0.12)'
                            : '0 12px 34px rgba(0, 0, 0, 0.18)',
                          color: '#fffaf0',
                        }}
                        onClick={() => {
                          if (isLockedByOtherEditing) {
                            notifications.show({
                              color: 'yellow',
                              title: '请先完成当前槽位修改',
                              message:
                                '当前正在修改另一个槽位，请先在 DOCX 预览中完成框选，或点击“取消”后再切换。',
                            });
                            return;
                          }

                          setWorkspaceState((currentState) => ({
                            ...currentState,
                            activeItemId: item.id,
                          }));
                          setPdfLocationEditState(null);
                        }}
                      >
                        <Stack gap="xs">
                          <Group justify="space-between">
                            <Group gap={6} wrap="wrap">
                              <Badge
                                color="teal"
                                radius="sm"
                                variant={isActive ? 'filled' : 'light'}
                              >
                                {item.field_category}
                              </Badge>
                              <Badge color="gray" radius="sm" variant="light">
                                slot-key: {item.id}
                              </Badge>
                            </Group>
                            <Group gap="xs">
                              {payload.pdfEvidence ? (
                                <Button
                                  color="orange"
                                  disabled={isLockedByOtherEditing}
                                  radius="xl"
                                  size="compact-xs"
                                  variant={
                                    pdfLocationEditState?.itemId === item.id
                                      ? 'filled'
                                      : 'subtle'
                                  }
                                  onClick={(event) => {
                                    event.stopPropagation();

                                    if (isLockedByOtherEditing) {
                                      notifications.show({
                                        color: 'yellow',
                                        title: '请先完成当前槽位修改',
                                        message:
                                          '当前正在修改另一个槽位，请先完成或取消当前修改后再调整 PDF 定位。',
                                      });
                                      return;
                                    }

                                    handleStartPdfLocationEdit(item);
                                  }}
                                >
                                  调定位
                                </Button>
                              ) : null}
                              <Button
                                color={isEditing ? 'yellow' : 'gray'}
                                disabled={isLockedByOtherEditing}
                                radius="xl"
                                size="compact-xs"
                                variant={isEditing ? 'filled' : 'subtle'}
                                onClick={(event) => {
                                  event.stopPropagation();

                                  if (isLockedByOtherEditing) {
                                    notifications.show({
                                      color: 'yellow',
                                      title: '请先完成当前槽位修改',
                                      message:
                                        '当前正在修改另一个槽位，请先完成当前框选，或先取消当前修改。',
                                    });
                                    return;
                                  }

                                  setWorkspaceState((currentState) => ({
                                    ...currentState,
                                    activeItemId: item.id,
                                    editingItemId:
                                      currentState.editingItemId === item.id
                                        ? null
                                        : item.id,
                                    pendingSelectionByItemId:
                                      currentState.editingItemId === item.id
                                        ? Object.fromEntries(
                                            Object.entries(
                                              currentState.pendingSelectionByItemId,
                                            ).filter(
                                              ([currentItemId]) =>
                                                currentItemId !== item.id,
                                            ),
                                          )
                                        : currentState.pendingSelectionByItemId,
                                  }));
                                }}
                              >
                                {isEditing ? '取消' : '修改'}
                              </Button>
                              {isEditing ? (
                                <Button
                                  color="teal"
                                  disabled={!pendingSelection}
                                  radius="xl"
                                  size="compact-xs"
                                  variant="filled"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setWorkspaceState((currentState) => ({
                                      ...currentState,
                                      items: currentState.items.map(
                                        (currentItem) =>
                                          currentItem.id === item.id
                                            ? {
                                                ...currentItem,
                                                original_value:
                                                  currentState
                                                    .pendingSelectionByItemId[
                                                    item.id
                                                  ] ??
                                                  currentItem.original_value,
                                                original_doc_position:
                                                  currentState
                                                    .pendingSelectionByItemId[
                                                    item.id
                                                  ] ??
                                                  currentItem.original_doc_position,
                                              }
                                            : currentItem,
                                      ),
                                      editingItemId: null,
                                      pendingSelectionByItemId:
                                        Object.fromEntries(
                                          Object.entries(
                                            currentState.pendingSelectionByItemId,
                                          ).filter(
                                            ([currentItemId]) =>
                                              currentItemId !== item.id,
                                          ),
                                        ),
                                    }));

                                    notifications.show({
                                      color: 'teal',
                                      title: '槽位值已保存',
                                      message:
                                        '新的框选内容已经正式更新到槽位抽取值和原文定位中。',
                                    });
                                  }}
                                >
                                  保存
                                </Button>
                              ) : null}
                              <Button
                                color="red"
                                disabled={isLockedByOtherEditing}
                                radius="xl"
                                size="compact-xs"
                                variant="subtle"
                                onClick={(event) => {
                                  event.stopPropagation();

                                  if (isLockedByOtherEditing) {
                                    notifications.show({
                                      color: 'yellow',
                                      title: '请先完成当前槽位修改',
                                      message:
                                        '当前正在修改另一个槽位，请先完成或取消当前修改后再删除其它槽位。',
                                    });
                                    return;
                                  }

                                  const visibleItemIndex =
                                    visibleItems.findIndex(
                                      (visibleItem) =>
                                        visibleItem.id === item.id,
                                    );
                                  const nextVisibleItemId =
                                    visibleItems[visibleItemIndex + 1]?.id ??
                                    visibleItems[visibleItemIndex - 1]?.id ??
                                    null;

                                  setWorkspaceState((currentState) => {
                                    const nextItems = currentState.items.filter(
                                      (currentItem) =>
                                        currentItem.id !== item.id,
                                    );
                                    const removedSlotKey =
                                      item.slot_key?.trim() || item.id;
                                    const nextActiveItemId =
                                      currentState.activeItemId === item.id
                                        ? nextVisibleItemId
                                        : currentState.activeItemId;
                                    const nextPayload = (() => {
                                      const currentPayload =
                                        currentState.payload;

                                      if (!currentPayload) {
                                        return currentPayload;
                                      }

                                      const nextExtractionResult =
                                        groupExtractionItemsByParagraph(
                                          nextItems,
                                          currentPayload.extractionResult,
                                        );
                                      const currentPdfEvidence =
                                        currentPayload.pdfEvidence;
                                      let nextPdfEvidence = currentPdfEvidence;

                                      if (currentPdfEvidence) {
                                        const nextPdfEvidenceMatches =
                                          currentPdfEvidence.matches.filter(
                                            (match) => {
                                              const matchSlotKey =
                                                getPdfEvidenceMatchSlotKey(
                                                  match,
                                                );
                                              const shouldKeepMatch =
                                                matchSlotKey !== removedSlotKey;

                                              return shouldKeepMatch;
                                            },
                                          );

                                        nextPdfEvidence = {
                                          ...currentPdfEvidence,
                                          matches: nextPdfEvidenceMatches,
                                        };
                                      }

                                      return removeOrphanPdfEvidenceMatches({
                                        ...currentPayload,
                                        extractionResult: nextExtractionResult,
                                        pdfEvidence: nextPdfEvidence,
                                      });
                                    })();

                                    const nextPendingSelectionByItemId =
                                      Object.fromEntries(
                                        Object.entries(
                                          currentState.pendingSelectionByItemId,
                                        ).filter(
                                          ([currentItemId]) =>
                                            currentItemId !== item.id,
                                        ),
                                      );

                                    if (nextPayload) {
                                      persistSlotReviewPayloadToSession(
                                        nextPayload,
                                      );
                                    }

                                    return {
                                      ...currentState,
                                      items: nextItems,
                                      payload: nextPayload,
                                      activeItemId: nextActiveItemId,
                                      editingItemId:
                                        currentState.editingItemId === item.id
                                          ? null
                                          : currentState.editingItemId,
                                      pendingSelectionByItemId:
                                        nextPendingSelectionByItemId,
                                    };
                                  });

                                  notifications.show({
                                    color: 'red',
                                    title: '槽位已删除',
                                    message:
                                      '该槽位已从当前模板编辑结果中移除，点击顶部“保存模板”后将不会保留。',
                                  });
                                }}
                              >
                                删除
                              </Button>
                            </Group>
                          </Group>
                          <TextInput
                            readOnly
                            label="槽位抽取值"
                            size="xs"
                            styles={{
                              input: {
                                background: 'rgba(255, 255, 255, 0.04)',
                                borderColor: 'rgba(255, 255, 255, 0.14)',
                                color: '#fffaf0',
                              },
                              label: { color: '#d8f7eb' },
                            }}
                            value={item.original_value}
                          />
                          <TextInput
                            label="槽位来源"
                            size="xs"
                            styles={{
                              input: {
                                background: 'rgba(255, 255, 255, 0.04)',
                                borderColor: 'rgba(255, 255, 255, 0.14)',
                                color: '#fffaf0',
                              },
                              label: { color: '#d8f7eb' },
                            }}
                            value={item.meaning_to_applicant}
                            onChange={(event) => {
                              const nextMeaning = event.currentTarget.value;

                              setWorkspaceState((currentState) => ({
                                ...currentState,
                                items: currentState.items.map((currentItem) =>
                                  currentItem.id === item.id
                                    ? {
                                        ...currentItem,
                                        meaning_to_applicant: nextMeaning,
                                      }
                                    : currentItem,
                                ),
                              }));
                            }}
                          />
                          {evidenceMatch ? (
                            <Group gap={6}>
                              <Badge color="blue" radius="sm" variant="light">
                                PDF 第 {evidenceMatch.page_number} 页
                              </Badge>
                              <Text c="dimmed" size="xs">
                                证据置信度：
                                {Math.round(evidenceMatch.confidence * 100)}%
                              </Text>
                            </Group>
                          ) : payload.pdfEvidence ? (
                            <Badge color="gray" radius="sm" variant="light">
                              未定位 PDF
                            </Badge>
                          ) : null}
                          {isEditing ? (
                            <Text c="yellow" size="xs">
                              修改中：请在 DOCX
                              预览中框选新的连续文本片段，确认后点击“保存”再更新槽位。
                            </Text>
                          ) : null}
                          {isEditing && pendingSelection ? (
                            <Text c="teal" size="xs">
                              待保存内容：{pendingSelection}
                            </Text>
                          ) : null}
                        </Stack>
                      </Card>
                    );
                  })}
                </Stack>
              </ScrollArea>
            </Stack>
          )}
        </Paper>

        <Box style={{ display: 'contents' }}>
          <Paper
            p="md"
            radius="xl"
            withBorder
            style={{
              flex: hasPdfEvidence ? '0 0 320px' : '0 0 420px',
              height: 'calc(100vh - 178px)',
              minWidth: hasPdfEvidence ? 280 : 380,
              order: 1,
              overflow: 'hidden',
            }}
          >
            <Stack gap="xs" h="100%">
              <div>
                <Title order={4} size="h5">
                  DOCX 模板预览
                </Title>
                <Text c="dimmed" mt={3} size="xs">
                  {docxPreviewDescription}
                </Text>
              </div>
              <ScrollArea
                offsetScrollbars
                scrollbarSize={8}
                style={{ flex: 1 }}
                type="always"
                viewportRef={documentViewportRef}
              >
                <div
                  style={{
                    width: '100%',
                    minWidth: '100%',
                    minHeight: '100%',
                  }}
                >
                  <Paper
                    p="md"
                    radius="lg"
                    style={{
                      width: '100%',
                      minWidth: '100%',
                      minHeight: '100%',
                      boxSizing: 'border-box',
                      background: '#f7fbf9',
                      border: '1px solid #dbe9e1',
                      color: '#18211d',
                      lineHeight: 1.85,
                    }}
                  >
                    <div
                      className="slot-review-document"
                      onMouseUp={handleDocumentMouseUp}
                      ref={documentContentRef}
                      style={{
                        width: '100%',
                        fontFamily:
                          '"Times New Roman", "SimSun", "Songti SC", "STSong", serif',
                        fontSize: '12px',
                        lineHeight: 1.5,
                        whiteSpace: 'normal',
                        wordBreak: 'break-word',
                      }}
                    >
                      {structuredPreview ? (
                        structuredPreview
                      ) : (
                        <div
                          dangerouslySetInnerHTML={{
                            __html: highlightedText,
                          }}
                        />
                      )}
                    </div>
                  </Paper>
                </div>
              </ScrollArea>
            </Stack>
          </Paper>
          {payload.pdfEvidence ? (
            <Paper
              p="md"
              radius="xl"
              withBorder
              style={{
                flex: '1 1 920px',
                height: 'calc(100vh - 178px)',
                minWidth: 520,
                order: 2,
                overflow: 'hidden',
              }}
            >
              <Stack gap="sm" h="100%">
                <Group align="flex-start" justify="space-between">
                  <div>
                    <Title order={4} size="h5">
                      PDF 证据定位
                    </Title>
                    <Text c="dimmed" mt={4} size="xs">
                      当前 PDF：{payload.pdfEvidence.pdfFileName}
                      。这里会展示所有上传页，选中槽位后自动滚动到对应页并高亮位置。
                    </Text>
                  </div>
                  <Group gap="xs" justify="flex-end">
                    <Button
                      color="gray"
                      radius="xl"
                      size="compact-sm"
                      variant="subtle"
                      onClick={() =>
                        updatePdfZoom(
                          (currentZoom) => currentZoom - PDF_PREVIEW_ZOOM_STEP,
                        )
                      }
                    >
                      缩小
                    </Button>
                    <Badge color="gray" radius="xl" variant="light">
                      {Math.round(pdfZoom * 100)}%
                    </Badge>
                    <Button
                      color="gray"
                      radius="xl"
                      size="compact-sm"
                      variant="subtle"
                      onClick={() =>
                        updatePdfZoom(
                          (currentZoom) => currentZoom + PDF_PREVIEW_ZOOM_STEP,
                        )
                      }
                    >
                      放大
                    </Button>
                    <Button
                      color="gray"
                      radius="xl"
                      size="compact-sm"
                      variant="subtle"
                      onClick={() => updatePdfZoom(() => 1)}
                    >
                      适宽
                    </Button>
                    {pdfLocationEditState ? (
                      <>
                        <Badge color="orange" radius="sm" variant="light">
                          调整定位中
                        </Badge>
                        <Button
                          color="teal"
                          disabled={!pdfLocationEditState.draftBbox}
                          radius="xl"
                          size="compact-sm"
                          variant="filled"
                          onClick={handleSavePdfLocationEdit}
                        >
                          保存定位
                        </Button>
                        <Button
                          color="gray"
                          radius="xl"
                          size="compact-sm"
                          variant="subtle"
                          onClick={() => setPdfLocationEditState(null)}
                        >
                          取消
                        </Button>
                      </>
                    ) : null}
                  </Group>
                </Group>

                {pdfLocationEditState ? (
                  <Paper
                    p="sm"
                    radius="lg"
                    style={{
                      background: 'rgba(245, 159, 0, 0.12)',
                      border: '1px solid rgba(245, 159, 0, 0.32)',
                    }}
                  >
                    <Text c="orange" size="sm">
                      请在正确的 PDF
                      页面上拖拽画框。保存后会把当前槽位关联到该页和新的框选位置。
                    </Text>
                  </Paper>
                ) : null}

                {pdfEvidencePages.length > 0 ? (
                  <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
                    <ScrollArea
                      offsetScrollbars
                      scrollbarSize={8}
                      style={{ flex: 1 }}
                      type="always"
                      viewportRef={pdfViewportRef}
                    >
                      <Stack gap="md">
                        {pdfEvidencePages.map((page) => {
                          const savedMatch =
                            activeEvidenceMatch?.page_number === page.pageNumber
                              ? activeEvidenceMatch
                              : null;
                          const draftBbox =
                            pdfLocationEditState?.itemId === activeItemId &&
                            pdfLocationEditState.draftPageNumber ===
                              page.pageNumber
                              ? pdfLocationEditState.draftBbox
                              : null;
                          const visibleBbox = draftBbox ?? savedMatch?.bbox;
                          const isEditingPage =
                            Boolean(pdfLocationEditState) &&
                            pdfLocationEditState?.itemId === activeItemId;
                          const zoomedPageWidth =
                            PDF_PREVIEW_BASE_WIDTH * pdfZoom;
                          const pageImageUrl =
                            page.imageUrl ??
                            page.imageDataUrl ??
                            page.fallbackImageUrl ??
                            '';

                          return (
                            <Box
                              key={page.pageNumber}
                              ref={(node) => {
                                pdfPageRefs.current[page.pageNumber] = node;
                              }}
                              style={{
                                position: 'relative',
                                display: 'flex',
                                justifyContent: 'center',
                                minWidth: Math.max(620, zoomedPageWidth + 28),
                                padding: 12,
                                background: '#101514',
                                borderRadius: 18,
                              }}
                            >
                              <Badge
                                color={
                                  savedMatch || draftBbox ? 'blue' : 'gray'
                                }
                                radius="sm"
                                style={{
                                  position: 'absolute',
                                  left: 18,
                                  top: 18,
                                  zIndex: 3,
                                }}
                                variant="filled"
                              >
                                PDF 第 {page.pageNumber} 页
                              </Badge>
                              <Box
                                style={{
                                  position: 'relative',
                                  width: zoomedPageWidth,
                                  maxWidth: 'none',
                                  cursor: isEditingPage
                                    ? 'crosshair'
                                    : undefined,
                                  userSelect: isEditingPage
                                    ? 'none'
                                    : undefined,
                                }}
                                onMouseDown={(event) =>
                                  handlePdfPageMouseDown(event, page.pageNumber)
                                }
                                onMouseLeave={handlePdfPageMouseUp}
                                onMouseMove={(event) =>
                                  handlePdfPageMouseMove(event, page.pageNumber)
                                }
                                onMouseUp={handlePdfPageMouseUp}
                              >
                                <PdfEvidencePageCanvas
                                  alt={`${payload.pdfEvidence?.pdfFileName ?? 'PDF'} 第 ${page.pageNumber} 页`}
                                  displayWidth={zoomedPageWidth}
                                  fallbackImageUrl={page.fallbackImageUrl}
                                  imageUrl={pageImageUrl}
                                  pageNumber={page.pageNumber}
                                />
                                {visibleBbox ? (
                                  <Box
                                    style={{
                                      position: 'absolute',
                                      left: `${visibleBbox.x * 100}%`,
                                      top: `${visibleBbox.y * 100}%`,
                                      width: `${visibleBbox.width * 100}%`,
                                      height: `${visibleBbox.height * 100}%`,
                                      minWidth: 18,
                                      minHeight: 14,
                                      border: draftBbox
                                        ? '3px dashed #12b886'
                                        : '3px solid #f59f00',
                                      borderRadius: 999,
                                      background: draftBbox
                                        ? 'rgba(18, 184, 134, 0.16)'
                                        : 'rgba(255, 209, 102, 0.18)',
                                      boxShadow: draftBbox
                                        ? '0 0 0 6px rgba(18, 184, 134, 0.12), 0 0 26px rgba(18, 184, 134, 0.28)'
                                        : '0 0 0 6px rgba(245, 159, 0, 0.14), 0 0 26px rgba(245, 159, 0, 0.32)',
                                      pointerEvents: 'none',
                                    }}
                                  />
                                ) : savedMatch ? (
                                  <Box
                                    style={{
                                      position: 'absolute',
                                      top: 12,
                                      right: 12,
                                      display: 'grid',
                                      placeItems: 'center',
                                      width: 148,
                                      height: 86,
                                      border: '3px solid #f59f00',
                                      borderRadius: 999,
                                      background: 'rgba(255, 209, 102, 0.18)',
                                      boxShadow:
                                        '0 0 0 6px rgba(245, 159, 0, 0.12)',
                                      color: '#fff6dc',
                                      textAlign: 'center',
                                      pointerEvents: 'none',
                                    }}
                                  >
                                    <Text fw={800} size="xs">
                                      关联槽位
                                      <br />
                                      {savedMatch.field_category}
                                    </Text>
                                  </Box>
                                ) : null}
                              </Box>
                            </Box>
                          );
                        })}
                      </Stack>
                    </ScrollArea>
                    {isSlotPanelCollapsed && activeItem ? (
                      <Paper
                        p="xs"
                        radius="lg"
                        style={{
                          background: 'rgba(16, 21, 20, 0.96)',
                          border: '1px solid rgba(56, 211, 159, 0.28)',
                        }}
                      >
                        <Group justify="space-between" gap="xs" wrap="nowrap">
                          <Text c="#fffaf0" fw={800} size="xs" truncate>
                            当前槽位：{activeSlotSummary}
                          </Text>
                          <Group gap={6} wrap="nowrap">
                            <Button
                              color="gray"
                              disabled={visibleItems.length <= 1}
                              radius="xl"
                              size="compact-xs"
                              variant="subtle"
                              onClick={() => selectVisibleItemByOffset(-1)}
                            >
                              上一个
                            </Button>
                            <Button
                              color="gray"
                              disabled={visibleItems.length <= 1}
                              radius="xl"
                              size="compact-xs"
                              variant="subtle"
                              onClick={() => selectVisibleItemByOffset(1)}
                            >
                              下一个
                            </Button>
                            {payload.pdfEvidence ? (
                              <Button
                                color="orange"
                                radius="xl"
                                size="compact-xs"
                                variant="light"
                                onClick={() =>
                                  handleStartPdfLocationEdit(activeItem)
                                }
                              >
                                调定位
                              </Button>
                            ) : null}
                            <Button
                              color="teal"
                              radius="xl"
                              size="compact-xs"
                              variant="filled"
                              onClick={() => setIsSlotPanelCollapsed(false)}
                            >
                              展开槽位
                            </Button>
                          </Group>
                        </Group>
                      </Paper>
                    ) : null}
                  </Stack>
                ) : (
                  <Paper
                    p="md"
                    radius="lg"
                    style={{
                      background: '#f7fbf9',
                      border: '1px solid #dbe9e1',
                    }}
                  >
                    <Text c="dimmed" size="sm">
                      当前没有可展示的 PDF 页图，请回到首页重新上传 DOCX 和扫描
                      PDF 后再识别。
                    </Text>
                  </Paper>
                )}
              </Stack>
            </Paper>
          ) : null}
        </Box>
      </Group>

      {isJsonPreviewDebugEnabled ? (
        <Paper p="xl" radius="xl" withBorder>
          <Stack gap="sm">
            <Title order={4}>JSON 预览</Title>
            <Text c="dimmed" size="sm">
              当前预览会随着槽位清单编辑实时变化，便于后续落库存储。
            </Text>
            <Paper
              p="md"
              radius="lg"
              style={{
                background: '#111',
                color: '#d8f9ec',
                overflowX: 'auto',
              }}
            >
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {jsonPreview}
              </pre>
            </Paper>
          </Stack>
        </Paper>
      ) : null}
    </Stack>
  );
}
