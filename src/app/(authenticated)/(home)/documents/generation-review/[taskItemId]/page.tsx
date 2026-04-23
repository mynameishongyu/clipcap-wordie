'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { GenerationReviewedItem } from '@/src/app/api/types/generation-task';
import {
  useGenerationTaskItem,
  useReviewGenerationTaskItem,
} from '@/src/querys/use-generation-task-runtime';
import { useJsonPreviewDebug } from '@/src/lib/debug/json-preview-toggle';
import { requestReviewedDocxDownload } from '@/src/lib/generation/download-reviewed-docx';
import type {
  DocBlock,
  ParagraphBlock,
  ParsedDocument,
  TextSegment,
  TextStyleSnapshot,
} from '@/src/types/docx-preview';

interface EditableReviewedItem extends GenerationReviewedItem {}

interface TemplateOriginalSlot {
  slot_key: string;
  field_category: string;
  meaning_to_applicant: string;
  original_value: string;
  original_doc_position: string;
  paragraph_index?: number;
  paragraph_title: string;
}

interface TextDecoration {
  itemId: string;
  start: number;
  end: number;
}

interface ParagraphDecoration extends TextDecoration {
  segmentId: string;
  continuesFromPrevious: boolean;
  continuesToNext: boolean;
}

function normalizeSlotText(value: string) {
  return value.trim();
}

function buildSlotSignature(fieldCategory: string, meaningToApplicant: string) {
  return `${normalizeSlotText(fieldCategory)}::${normalizeSlotText(meaningToApplicant)}`;
}

function normalizeExtractedItems(value: unknown): EditableReviewedItem[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  const candidate = value as { extracted_items?: unknown };

  if (!Array.isArray(candidate.extracted_items)) {
    return [];
  }

  return candidate.extracted_items.map((item, index) => {
    const record = item as Record<string, unknown>;

    return {
      slot_key: String(record.slot_key ?? `slot-${index + 1}`),
      field_category: String(record.field_category ?? ''),
      meaning_to_applicant: String(record.meaning_to_applicant ?? ''),
      original_value: String(record.original_value ?? ''),
      evidence: String(record.evidence ?? ''),
      evidence_page_numbers: Array.isArray(record.evidence_page_numbers)
        ? record.evidence_page_numbers
            .filter(
              (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
            )
            .sort((left, right) => left - right)
        : [],
      notes: String(record.notes ?? ''),
      confidence:
        typeof record.confidence === 'number' && Number.isFinite(record.confidence)
          ? record.confidence
          : null,
    };
  });
}

function normalizeTemplateOriginalSlots(value: unknown): TemplateOriginalSlot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((paragraph, paragraphIndex) => {
    const paragraphRecord = paragraph as Record<string, unknown>;
    const items = Array.isArray(paragraphRecord.items) ? paragraphRecord.items : [];
    const paragraphTitle = String(paragraphRecord.paragraph_title ?? '');
    const baseParagraphIndex =
      typeof paragraphRecord.paragraph_index === 'number'
        ? paragraphRecord.paragraph_index
        : undefined;

    return items.map((item, itemIndex) => {
      const record = item as Record<string, unknown>;
      const sequence =
        typeof record.sequence === 'number' && Number.isFinite(record.sequence)
          ? record.sequence
          : itemIndex + 1;

      return {
        slot_key: `${paragraphIndex}-${itemIndex}-${sequence}`,
        field_category: String(record.field_category ?? ''),
        meaning_to_applicant: String(record.meaning_to_applicant ?? ''),
        original_value: String(record.original_value ?? ''),
        original_doc_position: String(record.original_doc_position ?? ''),
        paragraph_index:
          typeof record.paragraph_index === 'number'
            ? record.paragraph_index
            : baseParagraphIndex,
        paragraph_title: paragraphTitle,
      };
    });
  });
}

function formatPageNumbers(pageNumbers: number[]) {
  if (pageNumbers.length === 0) {
    return '未定位页码';
  }

  return `PDF 第 ${pageNumbers.join('、')} 页`;
}

function textStyleToCss(style: TextStyleSnapshot): CSSProperties {
  return {
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    textDecoration: style.underline ? 'underline' : undefined,
    color: style.color || undefined,
    backgroundColor: style.backgroundColor || undefined,
    fontSize: style.fontSizePt ? `${style.fontSizePt}pt` : undefined,
    fontFamily: style.fontFamily || undefined,
    whiteSpace: 'pre-wrap',
  };
}

function StablePdfPreviewFrame({ src }: { src: string }) {
  const [stableSrc] = useState(src);

  return (
    <iframe
      src={stableSrc}
      style={{
        width: '100%',
        height: '100%',
        minHeight: '420px',
        display: 'block',
        border: '1px solid var(--mantine-color-gray-3)',
        borderRadius: '16px',
        backgroundColor: '#fff',
      }}
      title="上传 PDF 预览"
    />
  );
}
function collectParagraphDecorations(
  segments: TextSegment[],
  items: TemplateOriginalSlot[],
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
    if (typeof item.paragraph_index === 'number' && item.paragraph_index !== paragraphIndex) {
      return;
    }

    const preferredValues = [item.original_value.trim(), item.original_doc_position.trim()].filter(
      Boolean,
    );

    if (preferredValues.length === 0) {
      return;
    }

    preferredValues.some((value) => {
      let searchStart = 0;

      while (searchStart < combinedText.length) {
        const matchIndex = combinedText.indexOf(value, searchStart);

        if (matchIndex < 0) {
          return false;
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
            itemId: item.slot_key,
            start: nextRange.start,
            end: nextRange.end,
          });
          return true;
        }

        searchStart = matchIndex + value.length;
      }

      return false;
    });
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
  activeSlotKey: string | null,
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
    const isActive = decoration.itemId === activeSlotKey;

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
          boxShadow: isActive
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
  paragraphIndex: number,
  originalSlots: TemplateOriginalSlot[],
  activeSlotKey: string | null,
) {
  const firstText = block.segments.find(
    (segment): segment is TextSegment => segment.type === 'text' && segment.text.trim().length > 0,
  );
  const textSegments = block.segments.filter(
    (segment): segment is TextSegment => segment.type === 'text',
  );
  const decorationMap = collectParagraphDecorations(textSegments, originalSlots, paragraphIndex);
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
        margin: '0 0 0.72em',
        minHeight: 24,
        textAlign: block.align,
        textIndent: isLikelyTitle || block.align === 'center' ? 0 : '2em',
        lineHeight: 1.65,
        fontWeight: isLikelyTitle ? 700 : undefined,
        fontSize: isLikelyTitle ? '20px' : undefined,
      }}
    >
      {block.segments.length === 0 ? <span>&nbsp;</span> : null}
      {block.segments.map((segment) => {
        if (segment.type === 'text') {
          return (
            <span key={segment.id} style={textStyleToCss(segment.style)}>
              {renderSegmentContent(segment, decorationMap.get(segment.id) ?? [], activeSlotKey)}
            </span>
          );
        }

        return (
          <span key={segment.id} style={{ display: 'inline-flex', margin: '0 6px', verticalAlign: 'middle' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={segment.altText || '文档图片'}
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
  originalSlots: TemplateOriginalSlot[],
  activeSlotKey: string | null,
): ReactNode {
  const renderBlocks = (nextBlocks: DocBlock[], startingParagraphIndex: number): [ReactNode[], number] => {
    let currentParagraphIndex = startingParagraphIndex;
    const nodes = nextBlocks.map((block) => {
      if (block.type === 'paragraph') {
        const node = renderParagraphBlock(block, currentParagraphIndex, originalSlots, activeSlotKey);
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

function normalizeParsedDocument(value: unknown): ParsedDocument | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('blocks' in value) ||
    !Array.isArray((value as ParsedDocument).blocks)
  ) {
    return null;
  }

  return value as ParsedDocument;
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

function extractParagraphTextsFromUploadText(uploadText: string) {
  return uploadText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
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
      const fallbackParagraphIndex =
        typeof slot.paragraph_index === 'number'
          ? fallbackParagraphIndexes[fallbackParagraphIndexes.length - 1]
          : fallbackParagraphIndexes[0];

      return {
        ...slot,
        paragraph_index: fallbackParagraphIndex,
      };
    }

    return {
      ...slot,
      paragraph_index: undefined,
    };
  });
}

function resolveLinkedFilledSlotKey(
  slot: TemplateOriginalSlot,
  originalSlots: TemplateOriginalSlot[],
  filledItems: EditableReviewedItem[],
) {
  const signature = buildSlotSignature(slot.field_category, slot.meaning_to_applicant);
  const originalMatches = originalSlots.filter(
    (currentSlot) =>
      buildSlotSignature(currentSlot.field_category, currentSlot.meaning_to_applicant) === signature,
  );
  const filledMatches = filledItems.filter(
    (currentItem) =>
      buildSlotSignature(currentItem.field_category, currentItem.meaning_to_applicant) === signature,
  );
  const originalMatchIndex = originalMatches.findIndex(
    (currentSlot) => currentSlot.slot_key === slot.slot_key,
  );

  if (originalMatchIndex >= 0 && filledMatches[originalMatchIndex]) {
    return filledMatches[originalMatchIndex].slot_key;
  }

  const fallbackByCategory = filledItems.filter(
    (currentItem) => normalizeSlotText(currentItem.field_category) === normalizeSlotText(slot.field_category),
  );

  if (originalMatchIndex >= 0 && fallbackByCategory[originalMatchIndex]) {
    return fallbackByCategory[originalMatchIndex].slot_key;
  }

  return filledMatches[0]?.slot_key ?? fallbackByCategory[0]?.slot_key ?? filledItems[0]?.slot_key ?? null;
}

function resolveLinkedOriginalSlotKey(
  item: EditableReviewedItem,
  originalSlots: TemplateOriginalSlot[],
  filledItems: EditableReviewedItem[],
) {
  const signature = buildSlotSignature(item.field_category, item.meaning_to_applicant);
  const filledMatches = filledItems.filter(
    (currentItem) =>
      buildSlotSignature(currentItem.field_category, currentItem.meaning_to_applicant) === signature,
  );
  const originalMatches = originalSlots.filter(
    (currentSlot) =>
      buildSlotSignature(currentSlot.field_category, currentSlot.meaning_to_applicant) === signature,
  );
  const filledMatchIndex = filledMatches.findIndex(
    (currentItem) => currentItem.slot_key === item.slot_key,
  );

  if (filledMatchIndex >= 0 && originalMatches[filledMatchIndex]) {
    return originalMatches[filledMatchIndex].slot_key;
  }

  const fallbackByCategory = originalSlots.filter(
    (currentSlot) => normalizeSlotText(currentSlot.field_category) === normalizeSlotText(item.field_category),
  );

  if (filledMatchIndex >= 0 && fallbackByCategory[filledMatchIndex]) {
    return fallbackByCategory[filledMatchIndex].slot_key;
  }

  return originalMatches[0]?.slot_key ?? fallbackByCategory[0]?.slot_key ?? originalSlots[0]?.slot_key ?? null;
}

export default function GenerationReviewPage() {
  const isJsonPreviewDebugEnabled = useJsonPreviewDebug();
  const router = useRouter();
  const params = useParams<{ taskItemId: string }>();
  const taskItemId = typeof params.taskItemId === 'string' ? params.taskItemId : null;
  const queryClient = useQueryClient();
  const taskItemQuery = useGenerationTaskItem(taskItemId);
  const reviewMutation = useReviewGenerationTaskItem();
  const templatePreviewViewportRef = useRef<HTMLDivElement | null>(null);
  const initializedTaskItemIdRef = useRef<string | null>(null);
  const [items, setItems] = useState<EditableReviewedItem[]>([]);
  const [activeOriginalSlotKey, setActiveOriginalSlotKey] = useState<string | null>(null);
  const [activeFilledSlotKey, setActiveFilledSlotKey] = useState<string | null>(null);

  useEffect(() => {
    initializedTaskItemIdRef.current = null;
    setItems([]);
    setActiveOriginalSlotKey(null);
    setActiveFilledSlotKey(null);
  }, [taskItemId]);

  useEffect(() => {
    if (!taskItemQuery.data?.item) {
      return;
    }

    if (initializedTaskItemIdRef.current === taskItemId) {
      return;
    }

    const payload = taskItemQuery.data.item.review_payload ?? taskItemQuery.data.item.llm_output;
    const nextItems = normalizeExtractedItems(payload);
    const nextOriginalSlots = normalizeTemplateOriginalSlots(
      taskItemQuery.data.item.template_preview_slots ?? null,
    );

    setItems(nextItems);
    setActiveOriginalSlotKey((currentKey) => {
      if (currentKey && nextOriginalSlots.some((slot) => slot.slot_key === currentKey)) {
        return currentKey;
      }

      if (nextItems[0]) {
        return resolveLinkedOriginalSlotKey(nextItems[0], nextOriginalSlots, nextItems);
      }

      return nextOriginalSlots[0]?.slot_key ?? null;
    });
    setActiveFilledSlotKey((currentKey) => {
      if (currentKey && nextItems.some((item) => item.slot_key === currentKey)) {
        return currentKey;
      }

      if (nextOriginalSlots[0]) {
        return resolveLinkedFilledSlotKey(nextOriginalSlots[0], nextOriginalSlots, nextItems);
        }

        return nextItems[0]?.slot_key ?? null;
      });
    initializedTaskItemIdRef.current = taskItemId;
  }, [taskItemId, taskItemQuery.data]);

  const templatePreviewDocument = normalizeParsedDocument(
    taskItemQuery.data?.item.template_preview_document ?? null,
  );
  const originalSlots = useMemo(() => {
    const normalizedSlots = normalizeTemplateOriginalSlots(
      taskItemQuery.data?.item.template_preview_slots ?? null,
    );

    if (
      !templatePreviewDocument ||
      !taskItemQuery.data?.item.template_preview_upload_text
    ) {
      return normalizedSlots;
    }

    return resolveStructuredOriginalSlots(
      templatePreviewDocument,
      taskItemQuery.data.item.template_preview_upload_text,
      normalizedSlots,
    );
  }, [
    taskItemQuery.data?.item.template_preview_slots,
    taskItemQuery.data?.item.template_preview_upload_text,
    templatePreviewDocument,
  ]);
  const activeOriginalSlot =
    originalSlots.find((slot) => slot.slot_key === activeOriginalSlotKey) ?? null;
  const activeFilledItem =
    items.find((item) => item.slot_key === activeFilledSlotKey) ?? null;
  const stablePdfPreviewUrl = taskItemQuery.data?.item.pdf_preview_url ?? null;
  const structuredTemplatePreview = useMemo(
    () =>
      templatePreviewDocument
        ? renderStructuredBlocks(
            templatePreviewDocument.blocks,
            originalSlots,
            activeOriginalSlotKey,
          )
        : null,
    [activeOriginalSlotKey, originalSlots, templatePreviewDocument],
  );
  const jsonPreview = useMemo(
    () =>
      JSON.stringify(
        {
          document_summary: '',
          extracted_items: items,
        },
        null,
        2,
      ),
    [items],
  );

  useEffect(() => {
    if (!activeOriginalSlotKey || !templatePreviewViewportRef.current) {
      return;
    }

    const viewport = templatePreviewViewportRef.current;
    const target = viewport.querySelector<HTMLElement>(
      `[data-slot-id="${activeOriginalSlotKey}"]`,
    );

    if (!target) {
      return;
    }

    const targetTop = target.offsetTop;
    const targetHeight = target.offsetHeight;
    const nextScrollTop =
      targetTop - viewport.clientHeight / 2 + targetHeight / 2;

    viewport.scrollTo({
      top: Math.max(0, nextScrollTop),
      behavior: 'smooth',
    });
  }, [activeOriginalSlotKey, structuredTemplatePreview]);

  const closeReviewWindow = (didReview: boolean) => {
    if (typeof window !== 'undefined' && window.opener && !window.opener.closed && taskItemId) {
      window.opener.postMessage(
        {
          type: didReview ? 'generation-task-reviewed' : 'generation-task-closed',
          taskItemId,
        },
        window.location.origin,
      );
    }

    window.close();

    if (typeof window !== 'undefined' && !window.closed) {
      router.push('/home');
    }
  };

  if (!taskItemId) {
    return (
      <Container py="lg" size="xl">
        <Alert color="red" radius="xl" title="缺少任务项">
          当前页面没有拿到任务项 ID，请从批量生成任务里重新进入。
        </Alert>
      </Container>
    );
  }

  if (taskItemQuery.isLoading) {
    return (
      <Container py="lg" size="xl">
        <Stack align="center" gap="md" py="xl">
          <Loader color="teal" />
          <Text c="dimmed" size="sm">
            正在加载核查数据...
          </Text>
        </Stack>
      </Container>
    );
  }

  if (taskItemQuery.isError || !taskItemQuery.data) {
    return (
      <Container py="lg" size="xl">
        <Stack gap="lg">
          <Alert color="red" radius="xl" title="读取失败">
            {taskItemQuery.error instanceof Error
              ? taskItemQuery.error.message
              : '任务项读取失败，请稍后重试。'}
          </Alert>
          <Button radius="xl" size="sm" variant="light" onClick={() => router.push('/home')}>
            返回首页
          </Button>
        </Stack>
      </Container>
    );
  }

  const { item, task } = taskItemQuery.data;
  const canDownload = item.status === 'reviewed';
  const reviewedDocxDefaultFileName = `${task.template_name_snapshot}-${item.source_pdf_name.replace(/\.pdf$/i, '')}-核查结果.docx`;

  const handleSaveReview = async () => {
    try {
      await reviewMutation.mutateAsync({
        taskItemId,
        reviewPayload: {
          document_summary: '',
          extracted_items: items,
        },
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['generation-task-item', taskItemId] }),
        queryClient.invalidateQueries({ queryKey: ['generation-task', task.id] }),
        queryClient.invalidateQueries({ queryKey: ['generation-template-tasks'] }),
      ]);

      notifications.show({
        color: 'teal',
        title: '核查已完成',
        message: '当前任务项已保存为核查完毕，列表会同步更新。',
      });

      closeReviewWindow(true);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: '保存失败',
        message: error instanceof Error ? error.message : '保存核查结果失败，请稍后重试。',
      });
    }
  };

  return (
    <Container py="lg" size={1320}>
      <Stack gap="md">
        <Paper p="md" radius="xl" withBorder>
          <Group justify="space-between" align="center">
            <Group gap="md" align="center">
              <Button
                radius="xl"
                size="sm"
                variant="subtle"
                onClick={() => closeReviewWindow(false)}
              >
                返回任务列表
              </Button>
              <Title order={3}>批量生成任务核查</Title>
              <Badge color={canDownload ? 'green' : 'teal'} radius="sm" variant="light">
                {canDownload ? '核查完毕' : '待核查'}
              </Badge>
            </Group>
            <Group gap="sm">
              <Button loading={reviewMutation.isPending} radius="xl" size="sm" onClick={handleSaveReview}>
                提交核查
              </Button>
            </Group>
          </Group>
        </Paper>

        <SimpleGrid cols={{ base: 1, lg: 12 }} spacing="md" verticalSpacing="md">
          <Stack gap="md" style={{ gridColumn: 'span 2' }}>
            <Card padding="md" radius="xl" withBorder>
              <Stack gap="md">
                <Title order={5}>任务信息</Title>
                <Divider />
                <Group justify="space-between" align="flex-start">
                  <Text c="dimmed" size="sm">文件</Text>
                  <Text fw={600} size="sm">{item.source_pdf_name}</Text>
                </Group>
                <Group justify="space-between" align="flex-start">
                  <Text c="dimmed" size="sm">任务 ID</Text>
                  <Text fw={600} size="sm">{task.id.slice(0, 8)}</Text>
                </Group>
                <Group justify="space-between" align="flex-start">
                  <Text c="dimmed" size="sm">创建时间</Text>
                  <Text fw={600} size="sm">{new Date(task.created_at).toLocaleString('zh-CN')}</Text>
                </Group>
              </Stack>
            </Card>

            <Card padding="md" radius="xl" withBorder>
              <Stack gap="sm">
                <Title order={5}>核查步骤</Title>
                <Divider />
                {[
                  ['1', '查看模板预览', '了解模板结构和槽位位置'],
                  ['2', '核对 PDF 内容', '在 PDF 中找到对应信息'],
                  ['3', '检查回填值', '将核对结果填到回填值中'],
                  ['4', '提交核查', '确认后提交核查结果'],
                ].map(([step, title, description]) => (
                  <Paper key={step} p="sm" radius="lg" withBorder>
                    <Group align="flex-start" wrap="nowrap">
                      <Badge color="teal" radius="xl" variant="light">{step}</Badge>
                      <Stack gap={2}>
                        <Text fw={600} size="sm">{title}</Text>
                        <Text c="dimmed" size="xs">{description}</Text>
                      </Stack>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            </Card>

            <Card padding="md" radius="xl" withBorder>
              <Stack gap="sm">
                <Title order={5}>操作提示</Title>
                <Divider />
                <Text c="dimmed" size="sm">点击模板槽位卡片可在左侧 DOCX 预览中高亮定位。</Text>
                <Text c="dimmed" size="sm">对照 PDF 内容后，仅需填写回填值并检查证据来源。</Text>
                <Text c="dimmed" size="sm">本页已移除筛选、备注和证据预览，减少核查干扰。</Text>
              </Stack>
            </Card>
          </Stack>

          <Stack gap="md" style={{ gridColumn: 'span 10' }}>
            <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md" verticalSpacing="md">
              <Card padding="md" radius="xl" withBorder>
                <Stack gap="sm">
                  <Group justify="space-between" align="center">
                    <Group gap="sm" align="center">
                      <Title order={5}>模板预览</Title>
                      <Text c="dimmed" size="sm">
                        模板：{task.template_name_snapshot}
                      </Text>
                    </Group>
                  </Group>
                  <Divider />
                  {structuredTemplatePreview ? (
                    <ScrollArea
                      h={420}
                      offsetScrollbars
                      scrollbarSize={8}
                      type="always"
                      viewportRef={templatePreviewViewportRef}
                    >
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
                            lineHeight: 1.65,
                          }}
                        >
                          <div
                            style={{
                              width: '100%',
                              fontFamily: '"Times New Roman", "SimSun", "Songti SC", "STSong", serif',
                              fontSize: '16px',
                              lineHeight: 1.65,
                              whiteSpace: 'normal',
                              wordBreak: 'break-word',
                            }}
                          >
                            {structuredTemplatePreview}
                          </div>
                        </Paper>
                      </div>
                    </ScrollArea>
                  ) : item.template_preview_html ? (
                    <ScrollArea
                      h={420}
                      offsetScrollbars
                      scrollbarSize={8}
                      type="always"
                      viewportRef={templatePreviewViewportRef}
                    >
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
                            lineHeight: 1.65,
                          }}
                        >
                          <div
                            style={{
                              width: '100%',
                              fontFamily: '"Times New Roman", "SimSun", "Songti SC", "STSong", serif',
                              fontSize: '16px',
                              lineHeight: 1.65,
                              whiteSpace: 'normal',
                              wordBreak: 'break-word',
                            }}
                            dangerouslySetInnerHTML={{ __html: item.template_preview_html }}
                          />
                        </Paper>
                      </div>
                    </ScrollArea>
                  ) : (
                    <Alert color="yellow" radius="xl" title="暂无模板预览">
                      当前没有可显示的模板预览，但不会影响你继续核查槽位结果。
                    </Alert>
                  )}
                </Stack>
              </Card>

              <Card padding="md" radius="xl" withBorder style={{ minHeight: 500 }}>
                <Stack gap="sm" h="100%">
                  <Group justify="space-between" align="center">
                    <Group gap="sm">
                      <Title order={5}>PDF 预览</Title>
                      <Badge color="teal" radius="sm" variant="light">
                        已上传：{item.source_pdf_name}
                      </Badge>
                    </Group>
                  </Group>
                  <Divider />
                  {stablePdfPreviewUrl ? (
                    <div style={{ minHeight: 420, flex: 1 }}>
                      <StablePdfPreviewFrame src={stablePdfPreviewUrl} />
                    </div>
                  ) : (
                    <Alert color="yellow" radius="xl" title="暂时无法预览 PDF">
                      当前未能生成预览地址，但上传文件已经保存在任务中。你仍然可以完成槽位核查并保存结果。
                    </Alert>
                  )}
                </Stack>
              </Card>
            </SimpleGrid>

            <SimpleGrid cols={{ base: 1, lg: 12 }} spacing="md" verticalSpacing="md">
              <Card padding="md" radius="xl" withBorder style={{ gridColumn: 'span 8', height: 460 }}>
                <Stack gap="sm" h="100%">
                  <Group justify="space-between" align="center">
                    <Title order={5}>模板原始槽位</Title>
                    <Text c="dimmed" size="sm">共 {originalSlots.length} 个槽位</Text>
                  </Group>
                  <ScrollArea h="calc(100% - 32px)" offsetScrollbars>
                    <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="sm" verticalSpacing="sm">
                      {originalSlots.map((slot, index) => {
                        const isActive = slot.slot_key === activeOriginalSlotKey;
                        const linkedFilledSlotKey = resolveLinkedFilledSlotKey(slot, originalSlots, items);

                        return (
                        <Paper
                          key={slot.slot_key}
                          p="sm"
                          radius="lg"
                          withBorder
                          style={{
                            position: 'relative',
                            cursor: 'pointer',
                            minHeight: 120,
                            borderColor: isActive ? 'var(--mantine-color-teal-5)' : undefined,
                            background: isActive ? 'rgba(18, 184, 134, 0.06)' : undefined,
                          }}
                            onClick={() => {
                              setActiveOriginalSlotKey(slot.slot_key);
                              setActiveFilledSlotKey(linkedFilledSlotKey);
                            }}
                          >
                            <Stack gap={8}>
                              <Badge
                                color={isActive ? 'teal' : 'gray'}
                                radius="sm"
                                size="sm"
                                variant="light"
                                style={{
                                  position: 'absolute',
                                  top: 12,
                                  right: 12,
                                }}
                              >
                                #{index + 1}
                              </Badge>
                              <div style={{ paddingRight: 52 }}>
                                <Text fw={700} size="sm">{slot.field_category}</Text>
                                <Text c="dimmed" lineClamp={2} size="xs">
                                  {slot.meaning_to_applicant || '未填写槽位说明'}
                                </Text>
                              </div>
                            <div>
                              <Text c="dimmed" size="xs">模板值</Text>
                              <Text fw={600} lineClamp={2} size="sm">
                                {slot.original_value || '未识别到模板槽位值'}
                              </Text>
                            </div>
                          </Stack>
                        </Paper>
                      );
                    })}
                    </SimpleGrid>
                  </ScrollArea>
                </Stack>
              </Card>

              <Card padding="md" radius="xl" withBorder style={{ gridColumn: 'span 4', minHeight: 460 }}>
                {activeOriginalSlot || activeFilledItem ? (
                  <Stack gap="sm" h="100%">
                    <Title order={5}>填写回填值</Title>
                    <Text c="dimmed" size="sm">
                      当前槽位：
                      {activeFilledItem?.field_category ||
                        activeOriginalSlot?.field_category ||
                        '未选中槽位'}
                    </Text>

                    <TextInput
                      label="槽位含义"
                      radius="lg"
                      readOnly
                      size="sm"
                      value={
                        activeFilledItem?.meaning_to_applicant ??
                        activeOriginalSlot?.meaning_to_applicant ??
                        ''
                      }
                    />

                    <TextInput
                      label="模板原始槽位值"
                      radius="lg"
                      readOnly
                      size="sm"
                      value={activeOriginalSlot?.original_value ?? ''}
                    />

                    <TextInput
                      label="回填值"
                      radius="lg"
                      size="sm"
                      value={activeFilledItem?.original_value ?? ''}
                      onChange={(event) => {
                        const nextValue = event.currentTarget.value;
                        setItems((currentItems) =>
                          currentItems.map((currentItem) =>
                            currentItem.slot_key === activeFilledSlotKey
                              ? { ...currentItem, original_value: nextValue }
                              : currentItem,
                          ),
                        );
                      }}
                    />

                    <TextInput
                      label="证据位置"
                      radius="lg"
                      readOnly
                      size="sm"
                      value={formatPageNumbers(activeFilledItem?.evidence_page_numbers ?? [])}
                    />

                    <Text c="dimmed" size="xs">
                      模型抽取仅供参考，请结合 PDF 原文人工核对后再提交核查结果。
                    </Text>
                  </Stack>
                ) : (
                  <Alert color="yellow" radius="xl" title="暂无槽位结果">
                    当前任务项还没有可核查的槽位，请先回到批量生成列表确认视觉模型是否成功返回结果。
                  </Alert>
                )}
              </Card>
            </SimpleGrid>
          </Stack>
        </SimpleGrid>

        {isJsonPreviewDebugEnabled ? (
          <Card padding="md" radius="xl" withBorder>
            <Stack gap="sm">
              <Title order={5}>JSON 预览</Title>
              <Text c="dimmed" size="sm">
                当前预览会随着核查区编辑实时变化，便于保存前检查最终结构。
              </Text>
              <Paper
                p="md"
                radius="lg"
                style={{
                  minHeight: '220px',
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
          </Card>
        ) : null}
      </Stack>
    </Container>
  );
}
