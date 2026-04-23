'use client';

import { Badge, Button, Card, Group, Paper, ScrollArea, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ExtractionItem, ExtractionParagraph } from '@/src/app/api/types/template-slot-extraction';
import { useJsonPreviewDebug } from '@/src/lib/debug/json-preview-toggle';
import {
  SLOT_REVIEW_SESSION_KEY,
  type SlotReviewSessionPayload,
} from '@/src/lib/templates/slot-review-session';
import { openSaveTemplateModal } from '@/src/modals/save-template';
import { useSaveTemplate } from '@/src/querys/use-template-library';
import type { DocBlock, ParagraphBlock, ParsedDocument, TextSegment, TextStyleSnapshot } from '@/src/types/docx-preview';

interface EditableExtractionItem extends ExtractionItem {
  id: string;
  paragraphTitle: string;
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

function buildExtractionResultFromItems(
  items: EditableExtractionItem[],
  sourceParagraphs: ExtractionParagraph[],
): ExtractionParagraph[] {
  const matchedItemIds = new Set<string>();
  const groupedSourceParagraphs = sourceParagraphs.flatMap((paragraph, paragraphIndex) => {
    const paragraphItems = items
      .filter((item) => item.id.startsWith(`${paragraphIndex}-`))
      .map(({ id, paragraphTitle, ...rest }) => {
        matchedItemIds.add(id);
        return rest;
      });

    if (paragraphItems.length === 0) {
      return [];
    }

    return [
      {
        paragraph_index: paragraph.paragraph_index ?? paragraphIndex,
        paragraph_title: paragraph.paragraph_title,
        items: paragraphItems,
      },
    ];
  });

  const manualParagraphMap = new Map<
    string,
    {
      paragraphIndex: number | undefined;
      paragraphTitle: string;
      items: ExtractionParagraph['items'];
    }
  >();

  items.forEach(({ id, paragraphTitle, ...rest }) => {
    if (matchedItemIds.has(id)) {
      return;
    }

    const paragraphIndex = typeof rest.paragraph_index === 'number' ? rest.paragraph_index : undefined;
    const paragraphKey = `${paragraphTitle}::${paragraphIndex ?? 'manual'}`;
    const bucket =
      manualParagraphMap.get(paragraphKey) ?? {
        paragraphIndex,
        paragraphTitle,
        items: [],
      };

    bucket.items.push(rest);
    manualParagraphMap.set(paragraphKey, bucket);
  });

  const manualParagraphs = Array.from(manualParagraphMap.values()).map((manualParagraph) => ({
    paragraph_index: manualParagraph.paragraphIndex,
    paragraph_title: manualParagraph.paragraphTitle,
    items: manualParagraph.items,
  }));

  return [...groupedSourceParagraphs, ...manualParagraphs];
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
  const groupedParagraphs = buildExtractionResultFromItems(items, payload.extractionResult);
  const paragraphTexts = extractParagraphTextsFromUploadText(payload.uploadText);

  return {
    document_info: payload.documentInfo,
    extraction_result: groupedParagraphs.map((paragraph) => {
      const paragraphIndex =
        typeof paragraph.paragraph_index === 'number'
          ? paragraph.paragraph_index
          : paragraph.items.find((item) => typeof item.paragraph_index === 'number')?.paragraph_index;
      const paragraphOriginalText =
        typeof paragraphIndex === 'number' ? paragraphTexts[paragraphIndex] ?? '' : '';

      return {
        ...paragraph,
        paragraph_original_text: paragraphOriginalText,
        items: paragraph.items.map((item) => ({
          ...item,
          sequence_paragraph_original_text:
            typeof item.paragraph_index === 'number'
              ? paragraphTexts[item.paragraph_index] ?? paragraphOriginalText
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
      paragraphTitle: '鎵嬪姩娣诲姞妲戒綅',
      sequence: Number.MAX_SAFE_INTEGER,
      field_category: '鎵嬪姩娣诲姞',
      original_value: pendingNewItemSelection.trim(),
      meaning_to_applicant: '',
      original_doc_position: pendingNewItemSelection.trim(),
      paragraph_index: pendingNewItemParagraphIndex ?? undefined,
    },
  ];
}

function findClosestPreviewParagraphIndex(node: Node | null) {
  let currentElement =
    node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement ?? null;

  while (currentElement) {
    const paragraphIndexValue = currentElement.getAttribute('data-preview-paragraph-index');

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

function createHighlightMarkup(itemId: string, value: string, isActive: boolean) {
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

  const highlightItems = items.filter((item) => item.original_value.trim() && item.id !== hiddenItemId);

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

    const walker = documentNode.createTreeWalker(documentNode.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim()) {
          return NodeFilter.FILTER_REJECT;
        }

        if (node.parentElement?.closest('mark')) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    });

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
  const highlightItems = items.filter((item) => item.original_value.trim() && item.id !== hiddenItemId);

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
    fontSize: style.fontSizePt ? `${style.fontSizePt}pt` : undefined,
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

    if (typeof item.paragraph_index === 'number' && item.paragraph_index !== paragraphIndex) {
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
        (range) => Math.max(range.start, nextRange.start) < Math.min(range.end, nextRange.end),
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
      .filter((decoration) => decoration.start < segmentEnd && decoration.end > segmentStart)
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
          boxShadow: isActive && !decoration.continuesFromPrevious && !decoration.continuesToNext
            ? '0 0 0 2px rgba(245, 159, 0, 0.35), 0 0 22px rgba(245, 159, 0, 0.24)'
            : undefined,
          paddingLeft: decoration.continuesFromPrevious ? 1 : 3,
          paddingRight: decoration.continuesToNext ? 1 : 3,
          paddingTop: 0,
          paddingBottom: 0,
          marginLeft: decoration.continuesFromPrevious ? -1 : 0,
          marginRight: decoration.continuesToNext ? -1 : 0,
          scrollMarginBlock: '140px',
          transition: 'background-color 180ms ease, box-shadow 180ms ease, transform 180ms ease',
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
  const firstText = block.segments.find((segment): segment is TextSegment => segment.type === 'text' && segment.text.trim().length > 0);
  const paragraphDecorationMap = collectParagraphDecorations(
    block.segments.filter((segment): segment is TextSegment => segment.type === 'text'),
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
        margin: '0 0 1.1em',
        minHeight: 24,
        textAlign: block.align,
        textIndent: isLikelyTitle || block.align === 'center' ? 0 : '2em',
        lineHeight: 2,
        fontWeight: isLikelyTitle ? 700 : undefined,
        fontSize: isLikelyTitle ? '20px' : undefined,
      }}
    >
      {block.segments.length === 0 ? <span>&nbsp;</span> : null}
      {block.segments.map((segment) => {
        if (segment.type === 'text') {
          return (
            <span key={segment.id} style={textStyleToCss(segment.style)}>
              {renderSegmentContent(segment, paragraphDecorationMap.get(segment.id) ?? [], activeItemId)}
            </span>
          );
        }

        return (
          <span key={segment.id} style={{ display: 'inline-flex', margin: '0 6px', verticalAlign: 'middle' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={segment.altText || '鏂囨。鍥剧墖'}
              src={segment.src}
              style={{
                maxWidth: segment.style.widthPx ? `${segment.style.widthPx}px` : '100%',
                maxHeight: segment.style.heightPx ? `${segment.style.heightPx}px` : undefined,
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
  const renderBlocks = (nextBlocks: DocBlock[], startingParagraphIndex: number): [ReactNode[], number] => {
    let currentParagraphIndex = startingParagraphIndex;
    const nodes = nextBlocks.map((block) => {
      if (block.type === 'paragraph') {
        const node = renderParagraphBlock(block, items, activeItemId, hiddenItemId, currentParagraphIndex);
        currentParagraphIndex += 1;
        return node;
      }

      const renderedRows = block.rows.map((row) => (
        <tr key={row.id}>
          {row.cells.map((cell) => {
            const [cellNodes, nextParagraphIndex] = renderBlocks(cell.blocks, currentParagraphIndex);
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

function normalizeParagraphText(value: string) {
  return value.replace(/\s+/g, '');
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

function resolveStructuredPreviewItems(
  parsedDocument: ParsedDocument,
  uploadText: string,
  items: EditableExtractionItem[],
) {
  const structuredParagraphTexts = collectStructuredParagraphTexts(parsedDocument.blocks);
  const rawParagraphTexts = extractParagraphTextsFromUploadText(uploadText);
  const structuredParagraphIndexMap = buildStructuredParagraphIndexMap(
    rawParagraphTexts,
    structuredParagraphTexts,
  );

  return items.flatMap((item) => {
    const originalValue = item.original_value.trim();
    const mappedParagraphIndex =
      typeof item.paragraph_index === 'number'
        ? structuredParagraphIndexMap.get(item.paragraph_index)
        : undefined;

    if (!originalValue) {
      return [];
    }

    const matchesParagraph = (paragraphText: string) => paragraphText.includes(originalValue);

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

      return [{
        ...item,
        paragraph_index: fallbackParagraphIndex,
      }];
    }

    return [];
  });
}

function filterPlainPreviewItems(uploadText: string, items: EditableExtractionItem[]) {
  return items.filter((item) => {
    const originalValue = item.original_value.trim();

    if (!originalValue) {
      return false;
    }

    return uploadText.includes(originalValue);
  });
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

  const parsed = JSON.parse(rawValue) as SlotReviewSessionPayload;
  const flattenedItems = parsed.extractionResult.flatMap((paragraph: ExtractionParagraph, paragraphIndex) =>
    paragraph.items.map((item, itemIndex) => ({
      ...item,
      id: `${paragraphIndex}-${itemIndex}-${item.sequence}`,
      paragraphTitle: paragraph.paragraph_title,
    })),
  );

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
  const [workspaceState, setWorkspaceState] = useState<SlotReviewWorkspaceState>({
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
  const documentViewportRef = useRef<HTMLDivElement | null>(null);
  const documentContentRef = useRef<HTMLDivElement | null>(null);
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
      return resolveStructuredPreviewItems(payload.parsedDocument, payload.uploadText, items);
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
    [isAddingItem, pendingNewItemParagraphIndex, pendingNewItemSelection, visibleItems],
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

    return resolveStructuredPreviewItems(payload.parsedDocument, payload.uploadText, previewItems);
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
  }, [activeItemId, editingItemId, isAddingItem, payload, resolvedPreviewItems]);

  useEffect(() => {
    if (!activeItemId || !documentViewportRef.current) {
      return;
    }

    const activeResolvedItem = resolvedPreviewItems.find((item) => item.id === activeItemId) ?? null;
    const targetParagraph =
      typeof activeResolvedItem?.paragraph_index === 'number'
        ? documentViewportRef.current.querySelector<HTMLElement>(
            `[data-preview-paragraph-index="${activeResolvedItem.paragraph_index}"]`,
          )
        : null;
    const activeMarker =
      targetParagraph?.querySelector<HTMLElement>(`[data-slot-id="${activeItemId}"]`) ??
      documentViewportRef.current.querySelector<HTMLElement>(`[data-slot-id="${activeItemId}"]`);

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
  }, [activeItemId, isAddingItem, visibleItems]);

  const activeItem = useMemo(
    () => visibleItems.find((item) => item.id === activeItemId) ?? null,
    [activeItemId, visibleItems],
  );
  const editingItem = useMemo(
    () => visibleItems.find((item) => item.id === editingItemId) ?? null,
    [editingItemId, visibleItems],
  );
  const pendingEditingSelection = editingItemId ? pendingSelectionByItemId[editingItemId] ?? '' : '';

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

    if (!commonAncestor || !documentContentRef.current.contains(commonAncestor)) {
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
        ? '当前只是暂存新槽位的候选值，填写槽位含义后点击“保存新增”才会真正加入模板。'
        : '当前只是暂存候选值，点击槽位上的“保存”后才会真正更新槽位抽取值。',
    });
  };

  const jsonPreview = useMemo(() => {
    if (!payload) {
      return '';
    }

    return JSON.stringify(buildJsonPreviewPayload(visibleItems, payload), null, 2);
  }, [payload, visibleItems]);

  const handleSaveTemplate = () => {
    openSaveTemplateModal({
      initialName: payload?.templateName ?? '',
      onSave: async (templateName) => {
        if (!payload) {
          throw new Error('当前模板数据还未加载完成，请稍后再试。');
        }

        const nextExtractionResult = buildExtractionResultFromItems(
          visibleItems,
          payload.extractionResult,
        );
        const nextPayload: SlotReviewSessionPayload = {
          ...payload,
          templateName,
          extractionResult: nextExtractionResult,
        };
        const savedTemplate = await saveTemplateMutation.mutateAsync({
          templateId: payload.templateId,
          templateName,
          slotReviewPayload: nextPayload,
          slotPreview: buildJsonPreviewPayload(visibleItems, nextPayload),
        });
        const savedPayload: SlotReviewSessionPayload = {
          ...nextPayload,
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
          message: '模板名称、DOCX 原文件和当前 JSON 预览都已保存到数据库。',
        });

        await queryClient.invalidateQueries({ queryKey: ['saved-templates'] });
        router.push('/home');
      },
    });
  };

  if (!payload) {
    return (
      <Paper p="xl" radius="xl" withBorder>
        <Stack gap="md" align="center">
          <Title order={2}>正在恢复槽位识别结果</Title>
          <Text c="dimmed" ta="center">
            页面正在从当前浏览器会话中加载 DOCX 预览与抽取结果。如果长时间没有内容，再返回首页重新识别一次。
          </Text>
        </Stack>
      </Paper>
    );
  }

  return (
    <Stack gap="xl">
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <div>
            <Badge color="teal" radius="sm" variant="outline">
              抽取结果编辑
            </Badge>
            <Title mt="sm" order={2}>
              编辑 LLM 抽取出的槽位结果
            </Title>
          </div>
          <Group>
            <Button
              radius="xl"
              variant="white"
              onClick={() => {
                return handleSaveTemplate();
              }}
            >
              保存模板
            </Button>
            <Button component={Link} href="/home" radius="xl" variant="light">
              返回首页
            </Button>
          </Group>
        </Group>
        <Text c="dimmed">
          当前文件：{payload.documentInfo.document_name || payload.fileName}
        </Text>
      </Stack>

      <Group align="stretch" gap="xl" wrap="nowrap">
        <Paper p="lg" radius="xl" withBorder style={{ flex: '0 0 320px', minWidth: 320 }}>
          <Stack gap="md">
            <Title order={4}>抽取槽位</Title>
            <Button
              color="teal"
              disabled={Boolean(editingItemId)}
              radius="xl"
              variant={isAddingItem ? 'filled' : 'light'}
              onClick={() => {
                if (editingItemId) {
                  notifications.show({
                    color: 'yellow',
                    title: '请先完成当前槽位修改',
                    message: '当前正在修改已有槽位，请先保存或取消后再新增槽位。',
                  });
                  return;
                }

                setWorkspaceState((currentState) => ({
                  ...currentState,
                  activeItemId: null,
                  isAddingItem: !currentState.isAddingItem,
                  pendingNewItemSelection: currentState.isAddingItem ? '' : currentState.pendingNewItemSelection,
                  pendingNewItemParagraphIndex: currentState.isAddingItem ? null : currentState.pendingNewItemParagraphIndex,
                  pendingNewItemMeaning: currentState.isAddingItem ? '' : currentState.pendingNewItemMeaning,
                }));
              }}
            >
              {isAddingItem ? '取消新增槽位' : '手动新增槽位'}
            </Button>
            <ScrollArea h={640} offsetScrollbars scrollbarSize={8} type="always">
              <Stack gap="md">
                {isAddingItem ? (
                  <Card
                    padding="md"
                    radius="xl"
                    withBorder
                    style={{
                      borderColor: '#38d39f',
                      boxShadow: '0 0 0 1px #38d39f inset',
                    }}
                  >
                    <Stack gap="sm">
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
                              if (!pendingNewItemSelection.trim() || !pendingNewItemMeaning.trim()) {
                                notifications.show({
                                  color: 'yellow',
                                  title: '新增槽位信息不完整',
                                  message: '请先在右侧框选槽位抽取值，并填写槽位含义后再保存新增槽位。',
                                });
                                return;
                              }

                              setWorkspaceState((currentState) => {
                                const nextSequence =
                                  currentState.items.reduce((maxSequence, item) => Math.max(maxSequence, item.sequence), 0) + 1;
                                const newItem: EditableExtractionItem = {
                                  id: `manual-${Date.now()}`,
                                  paragraphTitle: '手动新增槽位',
                                  sequence: nextSequence,
                                  field_category: '手动新增',
                                  original_value: currentState.pendingNewItemSelection.trim(),
                                  meaning_to_applicant: currentState.pendingNewItemMeaning.trim(),
                                  original_doc_position: currentState.pendingNewItemSelection.trim(),
                                  paragraph_index: currentState.pendingNewItemParagraphIndex ?? undefined,
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
                                message: '手动新增槽位已经加入当前模板编辑结果，记得点击顶部“保存模板”完成保存。',
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
                        value={pendingNewItemSelection}
                      />
                      <TextInput
                        label="槽位含义"
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
                        新增中：槽位抽取值必须通过右侧框选生成，不能手动输入；槽位含义填写后才能保存新增。
                      </Text>
                    </Stack>
                  </Card>
                ) : null}
                {visibleItems.map((item) => {
                  const isActive = item.id === activeItemId;
                  const isEditing = item.id === editingItemId;
                  const isLockedByOtherEditing = Boolean((editingItemId && editingItemId !== item.id) || isAddingItem);
                  const pendingSelection = pendingSelectionByItemId[item.id] ?? '';

                  return (
                    <Card
                      key={item.id}
                      padding="md"
                      radius="xl"
                      withBorder
                      style={{
                        cursor: 'pointer',
                        opacity: isLockedByOtherEditing ? 0.72 : 1,
                        borderColor: isActive ? '#38d39f' : undefined,
                        boxShadow: isActive ? '0 0 0 1px #38d39f inset' : undefined,
                      }}
                      onClick={() => {
                        if (isLockedByOtherEditing) {
                          notifications.show({
                            color: 'yellow',
                            title: '请先完成当前槽位修改',
                            message: '当前正在修改另一个槽位，请先在右侧完成框选，或点击“取消”后再切换。',
                          });
                          return;
                        }

                        setWorkspaceState((currentState) => ({
                          ...currentState,
                          activeItemId: item.id,
                        }));
                      }}
                    >
                      <Stack gap="sm">
                        <Group justify="space-between">
                          <Badge color="teal" variant={isActive ? 'filled' : 'light'}>
                            {item.field_category}
                          </Badge>
                          <Group gap="xs">
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
                                    message: '当前正在修改另一个槽位，请先完成当前框选，或先取消当前修改。',
                                  });
                                  return;
                                }

                                setWorkspaceState((currentState) => ({
                                  ...currentState,
                                  activeItemId: item.id,
                                  editingItemId: currentState.editingItemId === item.id ? null : item.id,
                                  pendingSelectionByItemId:
                                    currentState.editingItemId === item.id
                                      ? Object.fromEntries(
                                          Object.entries(currentState.pendingSelectionByItemId).filter(
                                            ([currentItemId]) => currentItemId !== item.id,
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
                                    items: currentState.items.map((currentItem) =>
                                      currentItem.id === item.id
                                        ? {
                                            ...currentItem,
                                            original_value: currentState.pendingSelectionByItemId[item.id] ?? currentItem.original_value,
                                            original_doc_position:
                                              currentState.pendingSelectionByItemId[item.id] ?? currentItem.original_doc_position,
                                          }
                                        : currentItem,
                                    ),
                                    editingItemId: null,
                                    pendingSelectionByItemId: Object.fromEntries(
                                      Object.entries(currentState.pendingSelectionByItemId).filter(
                                        ([currentItemId]) => currentItemId !== item.id,
                                      ),
                                    ),
                                  }));

                                  notifications.show({
                                    color: 'teal',
                                    title: '槽位值已保存',
                                    message: '新的框选内容已经正式更新到槽位抽取值和原文定位中。',
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
                                    message: '当前正在修改另一个槽位，请先完成或取消当前修改后再删除其它槽位。',
                                  });
                                  return;
                                }

                                const visibleItemIndex = visibleItems.findIndex(
                                  (visibleItem) => visibleItem.id === item.id,
                                );
                                const nextVisibleItemId =
                                  visibleItems[visibleItemIndex + 1]?.id ??
                                  visibleItems[visibleItemIndex - 1]?.id ??
                                  null;

                                setWorkspaceState((currentState) => {
                                  const nextItems = currentState.items.filter((currentItem) => currentItem.id !== item.id);
                                  const nextActiveItemId =
                                    currentState.activeItemId === item.id
                                      ? nextVisibleItemId
                                      : currentState.activeItemId;

                                  const nextPendingSelectionByItemId = Object.fromEntries(
                                    Object.entries(currentState.pendingSelectionByItemId).filter(
                                      ([currentItemId]) => currentItemId !== item.id,
                                    ),
                                  );

                                  return {
                                    ...currentState,
                                    items: nextItems,
                                    activeItemId: nextActiveItemId,
                                    editingItemId: currentState.editingItemId === item.id ? null : currentState.editingItemId,
                                    pendingSelectionByItemId: nextPendingSelectionByItemId,
                                  };
                                });

                                notifications.show({
                                  color: 'red',
                                  title: '槽位已删除',
                                  message: '该槽位已从当前模板编辑结果中移除，点击顶部“保存模板”后将不会保留。',
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
                          value={item.original_value}
                        />
                        <TextInput
                          label="槽位含义"
                          value={item.meaning_to_applicant}
                          onChange={(event) => {
                            const nextMeaning = event.currentTarget.value;

                            setWorkspaceState((currentState) => ({
                              ...currentState,
                              items: currentState.items.map((currentItem) =>
                                currentItem.id === item.id
                                  ? { ...currentItem, meaning_to_applicant: nextMeaning }
                                  : currentItem,
                              ),
                            }));
                          }}
                        />
                        {isEditing ? (
                          <Text c="yellow" size="xs">
                            修改中：请在右侧预览文本中框选新的连续文本片段，确认后点击“保存”再更新槽位。
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
        </Paper>

        <Paper p="lg" radius="xl" withBorder style={{ flex: '1 1 0', minWidth: 0 }}>
          <Stack gap="md">
            <div>
              <Title order={4}>原文高亮预览</Title>
              <Text c="dimmed" mt={6} size="sm">
                {isAddingItem
                  ? '正在手动新增槽位。请先在右侧框选一段连续文本作为槽位抽取值，再在左侧填写槽位含义并点击“保存新增”。'
                  : editingItem
                  ? `正在修改：${editingItem.field_category}。请先在右侧框选一段连续文本，再点击左侧“保存”才会正式写回槽位。`
                  : activeItem
                  ? `已定位到：${activeItem.field_category} - ${activeItem.original_value || '未填写'}`
                  : '点击左侧槽位后，右侧会自动滚动到对应原文位置。'}
              </Text>
            </div>
            <ScrollArea h={640} offsetScrollbars scrollbarSize={8} type="always" viewportRef={documentViewportRef}>
              <div style={{ width: '100%', minWidth: '100%' }}>
                <Paper
                  p="lg"
                  radius="lg"
                  style={{
                    width: '100%',
                    minWidth: '100%',
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
                      fontFamily: '"Times New Roman", "SimSun", "Songti SC", "STSong", serif',
                      fontSize: '18px',
                      lineHeight: 2,
                      whiteSpace: 'normal',
                      wordBreak: 'break-word',
                    }}
                  >
                    {structuredPreview ? structuredPreview : <div dangerouslySetInnerHTML={{ __html: highlightedText }} />}
                  </div>
                </Paper>
              </div>
            </ScrollArea>
          </Stack>
        </Paper>
      </Group>

      {isJsonPreviewDebugEnabled ? (
        <Paper p="xl" radius="xl" withBorder>
          <Stack gap="sm">
            <Title order={4}>JSON 预览</Title>
            <Text c="dimmed" size="sm">
              当前预览会随着左侧编辑实时变化，便于后续落库存储。
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
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {jsonPreview}
              </pre>
            </Paper>
          </Stack>
        </Paper>
      ) : null}
    </Stack>
  );
}
