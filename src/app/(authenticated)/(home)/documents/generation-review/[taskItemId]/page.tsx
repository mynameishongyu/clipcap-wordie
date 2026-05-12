'use client';

import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Loader,
  Paper,
  ScrollArea,
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
import { normalizeSlotCategoryLabel } from '@/src/lib/templates/slot-category';
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

interface GenerationPdfPreviewPage {
  pageNumber: number;
  originalPageNumber: number;
  imageUrl: string;
  storagePath: string;
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
      field_category: normalizeSlotCategoryLabel(String(record.field_category ?? '')),
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
        field_category: normalizeSlotCategoryLabel(String(record.field_category ?? '')),
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

function normalizeUploadedPageNumberMapping(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (
        entry,
      ): entry is {
        uploaded_page_number: number;
        original_page_number: number;
      } =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as { uploaded_page_number?: unknown }).uploaded_page_number === 'number' &&
        typeof (entry as { original_page_number?: unknown }).original_page_number === 'number',
    )
    .sort((left, right) => left.uploaded_page_number - right.uploaded_page_number);
}

function formatEvidenceSource(
  uploadedPageNumbers: number[],
  pageNumberMapping: Array<{ uploaded_page_number: number; original_page_number: number }>,
) {
  if (uploadedPageNumbers.length === 0) {
    return '未定位页码';
  }

  if (pageNumberMapping.length === 0) {
    return formatPageNumbers(uploadedPageNumbers);
  }

  const mappingMap = new Map(
    pageNumberMapping.map((entry) => [entry.uploaded_page_number, entry.original_page_number]),
  );
  const originalPageNumbers = uploadedPageNumbers
    .map((uploadedPageNumber) => mappingMap.get(uploadedPageNumber))
    .filter((pageNumber): pageNumber is number => typeof pageNumber === 'number');

  if (originalPageNumbers.length === 0) {
    return formatPageNumbers(uploadedPageNumbers);
  }

  return `上传页序第 ${uploadedPageNumbers.join('、')} 页，对应原 PDF 第 ${originalPageNumbers.join('、')} 页`;
}

function hasManualFillPending(value: string | null | undefined) {
  return !value?.trim();
}

function textStyleToCss(style: TextStyleSnapshot): CSSProperties {
  return {
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    textDecoration: style.underline ? 'underline' : undefined,
    color: style.color || undefined,
    backgroundColor: style.backgroundColor || undefined,
    fontSize: style.fontSizePt ? `${style.fontSizePt * DOCX_PREVIEW_FONT_SCALE}pt` : undefined,
    fontFamily: style.fontFamily || undefined,
    whiteSpace: 'pre-wrap',
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
    // Signed URLs can be cross-origin; the image still displays even if canvas sharpening is skipped.
  }
}

function PdfPreviewPageCanvas({
  alt,
  displayWidth,
  imageUrl,
  pageNumber,
}: {
  alt: string;
  displayWidth: number;
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
    const image = new Image();

    image.onload = () => {
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
      canvasRef.current.dataset.pageNumber = String(pageNumber);
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

    image.src = imageUrl;

    return () => {
      isDisposed = true;
    };
  }, [displayWidth, imageUrl, pageNumber]);

  return (
    <canvas
      aria-label={alt}
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
        fontSize: isLikelyTitle ? '14px' : undefined,
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
  const pdfPreviewViewportRef = useRef<HTMLDivElement | null>(null);
  const pdfPageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const initializedTaskItemIdRef = useRef<string | null>(null);
  const [items, setItems] = useState<EditableReviewedItem[]>([]);
  const [activeOriginalSlotKey, setActiveOriginalSlotKey] = useState<string | null>(null);
  const [activeFilledSlotKey, setActiveFilledSlotKey] = useState<string | null>(null);
  const [pdfZoom, setPdfZoom] = useState(1);

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
  const normalizedOriginalSlots = normalizeTemplateOriginalSlots(
    taskItemQuery.data?.item.template_preview_slots ?? null,
  );
  const originalSlots =
    templatePreviewDocument && taskItemQuery.data?.item.template_preview_upload_text
      ? resolveStructuredOriginalSlots(
          templatePreviewDocument,
          taskItemQuery.data.item.template_preview_upload_text,
          normalizedOriginalSlots,
        )
      : normalizedOriginalSlots;
  const activeFilledItem =
    items.find((item) => item.slot_key === activeFilledSlotKey) ?? null;
  const pendingManualFillItems = useMemo(
    () => items.filter((item) => hasManualFillPending(item.original_value)),
    [items],
  );
  const stablePdfPreviewUrl = taskItemQuery.data?.item.pdf_preview_url ?? null;
  const pdfPreviewPages = useMemo(
    () =>
      ((taskItemQuery.data?.item.pdf_preview_pages ?? []) as GenerationPdfPreviewPage[])
        .filter(
          (page) =>
            typeof page.pageNumber === 'number' &&
            typeof page.originalPageNumber === 'number' &&
            typeof page.imageUrl === 'string' &&
            page.imageUrl.trim().length > 0,
        )
        .sort((left, right) => left.pageNumber - right.pageNumber),
    [taskItemQuery.data?.item.pdf_preview_pages],
  );
  const uploadedPageNumberMapping = normalizeUploadedPageNumberMapping(
    taskItemQuery.data?.item.llm_input &&
      typeof taskItemQuery.data.item.llm_input === 'object'
      ? (taskItemQuery.data.item.llm_input as { uploaded_page_number_mapping?: unknown })
          .uploaded_page_number_mapping
      : null,
  );
  const selectedPageRangeLabel = useMemo(() => {
    if (
      !taskItemQuery.data?.item.llm_input ||
      typeof taskItemQuery.data.item.llm_input !== 'object'
    ) {
      return null;
    }

    const value = (
      taskItemQuery.data.item.llm_input as { selected_page_range_label?: unknown }
    ).selected_page_range_label;

    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }, [taskItemQuery.data?.item.llm_input]);
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

  const activePdfPageNumber =
    activeFilledItem?.evidence_page_numbers?.find((pageNumber) => pageNumber > 0) ?? null;
  const updatePdfZoom = (updater: (currentZoom: number) => number) => {
    setPdfZoom((currentZoom) => clampPdfZoom(updater(currentZoom)));
  };

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

  useEffect(() => {
    if (!activePdfPageNumber || !pdfPreviewViewportRef.current) {
      return;
    }

    const viewport = pdfPreviewViewportRef.current;
    const target = pdfPageRefs.current[activePdfPageNumber];

    if (!target) {
      return;
    }

    viewport.scrollTo({
      top: Math.max(0, target.offsetTop - 28),
      behavior: 'smooth',
    });
  }, [activePdfPageNumber, pdfPreviewPages.length]);

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
    <Container py="md" size={1760} style={{ fontSize: 12 }}>
      <Stack gap="sm">
        <Paper p="sm" radius="xl" withBorder>
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
              <Title order={3} size="h4">批量生成任务核查</Title>
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

        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(260px, 0.72fr) minmax(640px, 1.9fr) minmax(300px, 0.8fr)',
            gap: 12,
            minHeight: 'calc(100vh - 116px)',
          }}
        >
          <Card padding="md" radius="xl" withBorder style={{ overflow: 'hidden' }}>
            <Stack gap="xs" h="100%">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Title order={5}>DOCX 模板预览</Title>
                  <Text c="dimmed" size="xs">
                    模板：{task.template_name_snapshot}
                  </Text>
                </div>
                <Badge color="teal" radius="sm" variant="light">
                  {originalSlots.length} 个槽位
                </Badge>
              </Group>
              <Divider />
              {structuredTemplatePreview || item.template_preview_html ? (
                <ScrollArea
                  offsetScrollbars
                  scrollbarSize={8}
                  style={{ flex: 1, minHeight: 0 }}
                  type="always"
                  viewportRef={templatePreviewViewportRef}
                >
                  <Paper
                    p="md"
                    radius="lg"
                    style={{
                      minWidth: 280,
                      background: '#f7fbf9',
                      border: '1px solid #dbe9e1',
                      color: '#18211d',
                      lineHeight: 1.55,
                    }}
                  >
                    <div
                      style={{
                        width: '100%',
                        fontFamily: '"Times New Roman", "SimSun", "Songti SC", "STSong", serif',
                        fontSize: '11px',
                        lineHeight: 1.55,
                        whiteSpace: 'normal',
                        wordBreak: 'break-word',
                      }}
                    >
                      {structuredTemplatePreview ? (
                        structuredTemplatePreview
                      ) : (
                        <div dangerouslySetInnerHTML={{ __html: item.template_preview_html ?? '' }} />
                      )}
                    </div>
                  </Paper>
                </ScrollArea>
              ) : (
                <Alert color="yellow" radius="xl" title="暂无模板预览">
                  当前没有可显示的模板预览，但不会影响你继续核查槽位结果。
                </Alert>
              )}
            </Stack>
          </Card>

          <Card padding="md" radius="xl" withBorder style={{ overflow: 'hidden' }}>
            <Stack gap="xs" h="100%">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Title order={5}>新 PDF 预览</Title>
                  <Text c="dimmed" size="xs">
                    当前 PDF：{item.source_pdf_name}
                    {selectedPageRangeLabel ? `，上传范围：原 PDF 第 ${selectedPageRangeLabel} 页` : ''}
                  </Text>
                </div>
                <Group gap="xs">
                  <Button
                    color="gray"
                    radius="xl"
                    size="compact-sm"
                    variant="subtle"
                    onClick={() => updatePdfZoom((currentZoom) => currentZoom - PDF_PREVIEW_ZOOM_STEP)}
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
                    onClick={() => updatePdfZoom((currentZoom) => currentZoom + PDF_PREVIEW_ZOOM_STEP)}
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
                </Group>
              </Group>
              <Divider />
              {pdfPreviewPages.length > 0 ? (
                <ScrollArea
                  offsetScrollbars
                  scrollbarSize={8}
                  style={{ flex: 1, minHeight: 0 }}
                  type="always"
                  viewportRef={pdfPreviewViewportRef}
                >
                  <Stack gap="md">
                    {pdfPreviewPages.map((page) => {
                      const zoomedPageWidth = PDF_PREVIEW_BASE_WIDTH * pdfZoom;
                      const isActivePage = activePdfPageNumber === page.pageNumber;

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
                            boxShadow: isActivePage
                              ? '0 0 0 2px rgba(18, 184, 134, 0.65)'
                              : undefined,
                          }}
                        >
                          <Badge
                            color={isActivePage ? 'teal' : 'blue'}
                            radius="sm"
                            style={{
                              position: 'absolute',
                              left: 18,
                              top: 18,
                              zIndex: 3,
                            }}
                            variant="filled"
                          >
                            上传第 {page.pageNumber} 页 / 原 PDF 第 {page.originalPageNumber} 页
                          </Badge>
                          <PdfPreviewPageCanvas
                            alt={`${item.source_pdf_name} 第 ${page.originalPageNumber} 页`}
                            displayWidth={zoomedPageWidth}
                            imageUrl={page.imageUrl}
                            pageNumber={page.pageNumber}
                          />
                        </Box>
                      );
                    })}
                  </Stack>
                </ScrollArea>
              ) : stablePdfPreviewUrl ? (
                <Alert color="yellow" radius="xl" title="暂无页图预览">
                  当前任务没有返回可用于页图预览的 OCR 图片；请回到批量生成重新上传，或先使用浏览器 PDF 预览地址进行核对。
                </Alert>
              ) : (
                <Alert color="yellow" radius="xl" title="暂时无法预览 PDF">
                  当前未能生成预览地址，但上传文件已经保存在任务中。你仍然可以完成槽位核查并保存结果。
                </Alert>
              )}
            </Stack>
          </Card>

          <Card padding="md" radius="xl" withBorder style={{ overflow: 'hidden' }}>
            <Stack gap="xs" h="100%">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Title order={5}>回填槽位</Title>
                  <Text c="dimmed" size="xs">
                    点击槽位会联动左侧模板和中间 PDF 证据页。
                  </Text>
                </div>
                <Badge color={pendingManualFillItems.length > 0 ? 'yellow' : 'teal'} radius="xl" variant="filled">
                  {items.length} 个
                </Badge>
              </Group>
              <Button
                loading={reviewMutation.isPending}
                radius="xl"
                size="xs"
                onClick={handleSaveReview}
              >
                提交核查
              </Button>
              <Divider />
              {items.length > 0 ? (
                <ScrollArea offsetScrollbars scrollbarSize={8} style={{ flex: 1, minHeight: 0 }} type="always">
                  <Stack gap="sm">
                    {items.map((slotItem, index) => {
                      const isActive = slotItem.slot_key === activeFilledSlotKey;
                      const linkedOriginalSlotKey = resolveLinkedOriginalSlotKey(
                        slotItem,
                        originalSlots,
                        items,
                      );
                      const linkedOriginalSlot =
                        originalSlots.find((slot) => slot.slot_key === linkedOriginalSlotKey) ?? null;

                      return (
                        <Paper
                          key={slotItem.slot_key}
                          p="sm"
                          radius="lg"
                          withBorder
                          style={{
                            cursor: 'pointer',
                            borderColor: isActive ? 'var(--mantine-color-teal-5)' : undefined,
                            background: isActive ? 'rgba(18, 184, 134, 0.08)' : undefined,
                          }}
                          onClick={() => {
                            setActiveFilledSlotKey(slotItem.slot_key);
                            setActiveOriginalSlotKey(linkedOriginalSlotKey);
                          }}
                        >
                          <Stack gap={6}>
                            <Group justify="space-between" align="center">
                              <Badge color={isActive ? 'teal' : 'gray'} radius="sm" variant="filled">
                                {slotItem.field_category || `槽位 ${index + 1}`}
                              </Badge>
                              <Text c="dimmed" size="xs">
                                {formatEvidenceSource(slotItem.evidence_page_numbers ?? [], uploadedPageNumberMapping)}
                              </Text>
                            </Group>
                            <Text c="dimmed" lineClamp={2} size="xs">
                              槽位来源：{slotItem.meaning_to_applicant || '未填写'}
                            </Text>
                            <TextInput
                              label="模板值"
                              radius="lg"
                              readOnly
                              size="xs"
                              value={linkedOriginalSlot?.original_value ?? ''}
                            />
                            <TextInput
                              label="回填值"
                              radius="lg"
                              size="xs"
                              value={slotItem.original_value}
                              error={
                                hasManualFillPending(slotItem.original_value)
                                  ? '需人工确认'
                                  : undefined
                              }
                              onChange={(event) => {
                                const nextValue = event.currentTarget.value;
                                setItems((currentItems) =>
                                  currentItems.map((currentItem) =>
                                    currentItem.slot_key === slotItem.slot_key
                                      ? { ...currentItem, original_value: nextValue }
                                      : currentItem,
                                  ),
                                );
                              }}
                              onClick={(event) => event.stopPropagation()}
                            />
                          </Stack>
                        </Paper>
                      );
                    })}
                  </Stack>
                </ScrollArea>
              ) : (
                <Alert color="yellow" radius="xl" title="暂无槽位结果">
                  当前任务项还没有可核查的槽位，请先回到批量生成列表确认模型是否成功返回结果。
                </Alert>
              )}
              {pendingManualFillItems.length > 0 ? (
                <Text c="dimmed" size="xs">
                  仍有 {pendingManualFillItems.length} 个槽位回填值为空；如该槽位本就应为空，可直接提交。
                </Text>
              ) : null}
            </Stack>
          </Card>
        </Box>

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
