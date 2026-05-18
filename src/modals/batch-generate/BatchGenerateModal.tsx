'use client';

import {
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { ContextModalProps } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GenerationTaskItemSummary } from '@/src/app/api/types/generation-task';
import { requestReviewedDocxDownload } from '@/src/lib/generation/download-reviewed-docx';
import {
  getPdfVisionRenderConcurrency,
  parsePdf,
  renderPdfPagesForVision,
  type PdfVisionPageInput,
} from '@/src/lib/pdf/client-pdf';
import {
  useGenerationTask,
  useProcessGenerationTaskItem,
  useStartGenerationTaskItemSlotFill,
} from '@/src/querys/use-generation-task-runtime';
import { useCreateGenerationTask } from '@/src/querys/use-generation-tasks';

interface BatchGenerateModalInnerProps {
  templateId: string;
  templateName: string;
}

interface UploadRow {
  id: string;
  file: File | null;
  parsedPdf: Awaited<ReturnType<typeof parsePdf>> | null;
  isParsing: boolean;
  parseError: string | null;
  forceVisionPageFill: boolean;
}

interface DuplicatePdfFileNameAlert {
  fileName: string;
  selectedRowId: string;
  duplicateRows: Array<{
    rowId: string;
    rowNumber: number;
    fileName: string | null;
  }>;
}

type PageFilterPage = NonNullable<
  GenerationTaskItemSummary['pdf_page_filter_pages']
>[number];

declare global {
  interface Window {
    clipcapPdfPageImages?: Array<{
      fileName: string;
      originalPageNumber: number;
      uploadedPageNumber: number;
      previewUrl: string;
      imageDataUrl?: string;
      rotationApplied?: number;
    }>;
    clipcapSlotFillInputs?: Array<{
      fileName: string;
      label: string;
      data: {
        document_name: string;
        page_numbers: number[];
        slot_definitions: Array<{
          slot_key: string;
          slot_name: string;
          slot_meaning: string;
        }>;
        content: string;
      };
    }>;
    clipcapSlotFillPrompts?: Array<{
      fileName: string;
      label: string;
      data: {
        route?: string;
        model?: string;
        request_label?: string;
        messages?: Array<{
          role: string;
          content: unknown;
        }>;
      };
    }>;
    clipcapSlotFillActualRequestBodies?: Array<{
      fileName: string;
      label: string;
      data: Record<string, unknown>;
    }>;
    clipcapPageFilterPrompts?: Array<{
      fileName: string;
      label: string;
      data: Record<string, unknown>;
    }>;
    clipcapPageFilterResults?: Array<{
      fileName: string;
      label: string;
      data: Record<string, unknown>;
    }>;
    clipcapSlotFillRawResponses?: Array<{
      fileName: string;
      label: string;
      data: Record<string, unknown>;
    }>;
    clipcapReferencePageAlignmentPrompts?: Array<{
      fileName: string;
      taskItemId: string;
      data: Record<string, unknown>;
    }>;
    clipcapReferencePageAlignmentRequestBodies?: Array<{
      fileName: string;
      taskItemId: string;
      data: Record<string, unknown>;
    }>;
    clipcapReferencePageAlignmentRawResponses?: Array<{
      fileName: string;
      taskItemId: string;
      data: Record<string, unknown>;
    }>;
    clipcapReferencePageAlignments?: Array<{
      fileName: string;
      taskItemId: string;
      data: Record<string, unknown>;
    }>;
    clipcapSlotFillOutputs?: Array<{
      fileName: string;
      taskItemId: string;
      data: Record<string, unknown>;
    }>;
    clipcapConfirmedSlotFillPages?: Array<{
      fileName: string;
      taskItemId: string;
      data: Record<string, unknown>;
    }>;
    clipcapVisionPagesUsed?: Array<{
      fileName: string;
      taskItemId: string;
      data: Record<string, unknown>;
    }>;
    clipcapSlotFillReferenceImages?: Array<{
      fileName: string;
      taskItemId: string;
      examplePdfFileName?: string | null;
      referencePageNumber: number;
      originalReferencePageNumber?: number;
      slotKey: string;
      slotName: string;
      slotSource: string;
      exampleBox2d: [number, number, number, number] | null;
      exampleEvidenceText: string;
      exampleSlotValue: string;
      previewUrl: string;
      storagePath?: string | null;
    }>;
  }
}

function createUploadRow(): UploadRow {
  return {
    id: crypto.randomUUID(),
    file: null,
    parsedPdf: null,
    isParsing: false,
    parseError: null,
    forceVisionPageFill: false,
  };
}

function normalizeUploadFileName(fileName: string) {
  return fileName.trim().toLocaleLowerCase();
}

const DEFAULT_PDF_FILL_MAX_TASK_COUNT = 3;

function getPdfFillMaxTaskCount() {
  const rawValue = process.env.NEXT_PUBLIC_PDF_FILL_MAX_TASK_COUNT;
  const parsedValue = rawValue
    ? Number(rawValue)
    : DEFAULT_PDF_FILL_MAX_TASK_COUNT;

  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    return DEFAULT_PDF_FILL_MAX_TASK_COUNT;
  }

  return Math.min(parsedValue, 50);
}

function buildFullPageNumbers(totalPages: number) {
  return Array.from({ length: totalPages }, (_, index) => index + 1);
}

function formatCompactPageRanges(pageNumbers: number[]) {
  if (pageNumbers.length === 0) {
    return '';
  }

  const sorted = Array.from(new Set(pageNumbers)).sort(
    (left, right) => left - right,
  );
  const ranges: string[] = [];
  let rangeStart = sorted[0]!;
  let previous = sorted[0]!;

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index]!;

    if (current === previous + 1) {
      previous = current;
      continue;
    }

    ranges.push(
      rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`,
    );
    rangeStart = current;
    previous = current;
  }

  ranges.push(
    rangeStart === previous ? `${rangeStart}` : `${rangeStart}-${previous}`,
  );
  return ranges.join('、');
}

function parseTraceJson<T>(raw: string, label: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error(`[Batch Generate] Failed to parse ${label}.`, {
      raw,
      error,
    });
    return null;
  }
}

function logConsoleTextChunks(label: string, text: string) {
  const chunkSize = 12000;
  const totalChunks = Math.max(1, Math.ceil(text.length / chunkSize));

  for (let index = 0; index < totalChunks; index += 1) {
    const chunk = text.slice(index * chunkSize, (index + 1) * chunkSize);

    console.log(
      totalChunks === 1
        ? `${label}\n${chunk}`
        : `${label} chunk ${index + 1}/${totalChunks}\n${chunk}`,
    );
  }
}

function formatVisionImageAttachmentList(
  rawImagePlaceholders: unknown,
): string | null {
  if (
    !Array.isArray(rawImagePlaceholders) ||
    rawImagePlaceholders.length === 0
  ) {
    return null;
  }

  const lines = rawImagePlaceholders.flatMap((placeholder, index) => {
    if (!placeholder || typeof placeholder !== 'object') {
      return [];
    }

    const imagePlaceholder = placeholder as {
      label?: unknown;
      page_number?: unknown;
      image_size?: unknown;
    };
    const label =
      typeof imagePlaceholder.label === 'string'
        ? imagePlaceholder.label
        : `New PDF uploaded page ${index + 1}`;
    const pageNumber =
      typeof imagePlaceholder.page_number === 'number'
        ? imagePlaceholder.page_number
        : index + 1;
    const imageSize =
      typeof imagePlaceholder.image_size === 'string'
        ? `，大小 ${imagePlaceholder.image_size}`
        : '';

    return [label, `[图片：第 ${pageNumber} 张保留页面${imageSize}]`, ''];
  });

  return lines.length > 0 ? lines.join('\n').trimEnd() : null;
}

function formatReferenceImageAttachmentList(
  rawImagePlaceholders: unknown,
): string | null {
  if (
    !Array.isArray(rawImagePlaceholders) ||
    rawImagePlaceholders.length === 0
  ) {
    return null;
  }

  const lines = rawImagePlaceholders.flatMap((placeholder, index) => {
    if (!placeholder || typeof placeholder !== 'object') {
      return [];
    }

    const imagePlaceholder = placeholder as {
      label?: unknown;
      page_number?: unknown;
      original_page_number?: unknown;
      file_name?: unknown;
      image_size?: unknown;
      annotated_preview_url?: unknown;
      annotated_storage_path?: unknown;
      annotated_slot_count?: unknown;
      annotated_slot_keys?: unknown;
    };
    const label =
      typeof imagePlaceholder.label === 'string'
        ? imagePlaceholder.label
        : `Annotated reference example PDF page ${index + 1}`;
    const pageNumber =
      typeof imagePlaceholder.page_number === 'number'
        ? imagePlaceholder.page_number
        : index + 1;
    const originalPageNumber =
      typeof imagePlaceholder.original_page_number === 'number'
        ? imagePlaceholder.original_page_number
        : pageNumber;
    const imageSize =
      typeof imagePlaceholder.image_size === 'string'
        ? `，大小 ${imagePlaceholder.image_size}`
        : '';
    const fileName =
      typeof imagePlaceholder.file_name === 'string' &&
      imagePlaceholder.file_name.trim()
        ? `，参考 PDF：${imagePlaceholder.file_name}`
        : '';
    const slotCount =
      typeof imagePlaceholder.annotated_slot_count === 'number'
        ? `，标注槽位 ${imagePlaceholder.annotated_slot_count} 个`
        : '';
    const slotKeys = Array.isArray(imagePlaceholder.annotated_slot_keys)
      ? imagePlaceholder.annotated_slot_keys
          .filter((slotKey): slotKey is string => typeof slotKey === 'string')
          .join(', ')
      : '';
    const slotKeysText = slotKeys ? `，slot_keys=${slotKeys}` : '';
    const storagePath =
      typeof imagePlaceholder.annotated_storage_path === 'string'
        ? imagePlaceholder.annotated_storage_path
        : 'none';
    const previewUrl =
      typeof imagePlaceholder.annotated_preview_url === 'string'
        ? imagePlaceholder.annotated_preview_url
        : 'none';

    return [
      label,
      `[图片：参考 PDF 第 ${pageNumber} 页，原 PDF 第 ${originalPageNumber} 页，已画 bbox${imageSize}${fileName}${slotCount}${slotKeysText}]`,
      `storage_path=${storagePath}`,
      `signed_url=${previewUrl}`,
      '',
    ];
  });

  return lines.length > 0 ? lines.join('\n').trimEnd() : null;
}

function formatPageFilterDropExampleAttachmentList(
  rawDropExamples: unknown,
): string | null {
  if (!Array.isArray(rawDropExamples) || rawDropExamples.length === 0) {
    return null;
  }

  const lines = rawDropExamples.flatMap((example, index) => {
    if (!example || typeof example !== 'object') {
      return [];
    }

    const dropExample = example as {
      file_name?: unknown;
      image_size?: unknown;
    };
    const fileName =
      typeof dropExample.file_name === 'string'
        ? dropExample.file_name
        : `drop-example-${index + 1}`;
    const imageSize =
      typeof dropExample.image_size === 'string'
        ? `，大小 ${dropExample.image_size}`
        : '';

    return [
      `Drop example ${index + 1}: ${fileName}`,
      `[图片：过滤样例 ${index + 1}${imageSize}]`,
      '',
    ];
  });

  return lines.length > 0 ? lines.join('\n').trimEnd() : null;
}

function dataUrlToObjectUrl(dataUrl: string) {
  const [header, base64Payload] = dataUrl.split(',', 2);

  if (!header || !base64Payload) {
    throw new Error('PDF 页面图片数据无效，无法生成预览链接。');
  }

  const mimeTypeMatch = header.match(/^data:(.*?);base64$/);
  const mimeType = mimeTypeMatch?.[1] || 'image/png';
  const binary = atob(base64Payload);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function pdfVisionPageToObjectUrl(visionPage: PdfVisionPageInput) {
  if (visionPage.imageBlob) {
    return URL.createObjectURL(visionPage.imageBlob);
  }

  if (visionPage.imageDataUrl) {
    return dataUrlToObjectUrl(visionPage.imageDataUrl);
  }

  throw new Error('PDF 页面图片数据无效，无法生成预览链接。');
}

function getStatusColor(status: string) {
  switch (status) {
    case 'uploaded':
      return 'blue';
    case 'pdf_pages_ready':
      return 'blue';
    case 'running':
    case 'ocr_running':
    case 'page_preparing':
    case 'slot_filling':
      return 'orange';
    case 'review_pending':
      return 'teal';
    case 'reviewed':
      return 'green';
    case 'failed':
      return 'red';
    default:
      return 'gray';
  }
}

function getStatusLabel(status: string) {
  switch (status) {
    case 'pending':
      return '等待中';
    case 'uploaded':
      return '处理中';
    case 'running':
      return '处理中';
    case 'ocr_running':
    case 'page_preparing':
      return '处理中';
    case 'pdf_pages_ready':
      return '待确认页面';
    case 'slot_filling':
      return '处理中';
    case 'review_pending':
      return '待核查';
    case 'reviewed':
      return '核查完毕';
    case 'failed':
      return '处理失败';
    default:
      return status;
  }
}

function getPageFilterPageLabel(page: PageFilterPage) {
  return `第 ${page.originalPageNumber} 页`;
}

function PageFilterPageTile({
  page,
  retained,
  onAction,
}: {
  page: PageFilterPage;
  retained: boolean;
  onAction: () => void;
}) {
  const pageLabel = getPageFilterPageLabel(page);
  const statusLabel = retained ? '保留' : '已过滤';
  const nextActionLabel = retained ? '过滤' : '保留';
  const borderColor = retained
    ? 'rgba(16, 185, 129, 0.62)'
    : 'rgba(248, 113, 113, 0.62)';
  const background = retained
    ? 'rgba(16, 185, 129, 0.12)'
    : 'rgba(248, 113, 113, 0.08)';

  return (
    <Box
      role="button"
      tabIndex={0}
      title={page.filterReason ?? `${pageLabel}：${statusLabel}`}
      onClick={onAction}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onAction();
        }
      }}
      style={{
        minHeight: 64,
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        background,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '9px 10px',
      }}
    >
      <Group justify="space-between" align="center" gap={8} wrap="nowrap">
        <Text fw={700} size="xs">
          {pageLabel}
        </Text>
        <Badge
          color={retained ? 'red' : 'teal'}
          radius="sm"
          size="xs"
          variant="light"
        >
          {nextActionLabel}
        </Badge>
      </Group>
      <Group justify="space-between" align="center" gap={6} wrap="nowrap">
        <Text c="dimmed" size="xs">
          点击{nextActionLabel}
        </Text>
        {page.imageUrl ? (
          <Button
            radius="sm"
            size="compact-xs"
            variant="subtle"
            onClick={(event) => {
              event.stopPropagation();
              window.open(page.imageUrl ?? '', '_blank', 'noopener,noreferrer');
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
            }}
          >
            查看
          </Button>
        ) : null}
      </Group>
    </Box>
  );
}

function formatElapsedSeconds(
  item: GenerationTaskItemSummary,
  now: number,
  startedAt: number | null,
) {
  if (
    [
      'uploaded',
      'running',
      'pending',
      'page_preparing',
      'ocr_running',
      'pdf_pages_ready',
      'slot_filling',
    ].includes(item.status) &&
    startedAt
  ) {
    return Math.max(item.elapsed_seconds, Math.floor((now - startedAt) / 1000));
  }

  return item.elapsed_seconds;
}

function formatDurationMs(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '0.00 秒';
  }

  if (durationMs < 1000) {
    return `${durationMs} 毫秒`;
  }

  return `${(durationMs / 1000).toFixed(2)} 秒`;
}

function getTraceTimestampMs(line: string) {
  const timestampMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);

  if (!timestampMatch?.[1]) {
    return null;
  }

  const parsedTimestamp = Date.parse(timestampMatch[1]);

  return Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
}

function getPendingSlotCount(item: GenerationTaskItemSummary) {
  return Math.max(0, item.slot_total_count - item.slot_completed_count);
}

export function BatchGenerateModal({
  context,
  id,
  innerProps,
}: ContextModalProps<BatchGenerateModalInnerProps>) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<UploadRow[]>([createUploadRow()]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const [isPreparingFiles, setIsPreparingFiles] = useState(false);
  const [submissionStartedAt, setSubmissionStartedAt] = useState<number | null>(
    null,
  );
  const [duplicatePdfFileNameAlert, setDuplicatePdfFileNameAlert] =
    useState<DuplicatePdfFileNameAlert | null>(null);
  const [itemStartedAtById, setItemStartedAtById] = useState<
    Record<string, number>
  >({});
  const createGenerationTaskMutation = useCreateGenerationTask();
  const processGenerationTaskItemMutation = useProcessGenerationTaskItem();
  const startGenerationTaskItemSlotFillMutation =
    useStartGenerationTaskItemSlotFill();
  const maxPdfFillTaskCount = getPdfFillMaxTaskCount();
  const taskQuery = useGenerationTask(taskId);
  const launchedPagePreparationItemIdsRef = useRef<Set<string>>(new Set());
  const launchedSlotFillItemIdsRef = useRef<Set<string>>(new Set());
  const pendingSlotFillRefreshTimeoutsRef = useRef<Map<string, number[]>>(
    new Map(),
  );
  const itemTraceRef = useRef<Map<string, string>>(new Map());
  const pageFilterStartedAtRef = useRef<Map<string, number>>(new Map());
  const pageFilterDurationLoggedItemIdsRef = useRef<Set<string>>(new Set());
  const [confirmedPageNumbersByItemId, setConfirmedPageNumbersByItemId] =
    useState<Record<string, number[]>>({});
  const refreshTaskLists = async () => {
    await Promise.all([
      taskId
        ? queryClient.invalidateQueries({
            queryKey: ['generation-task', taskId],
          })
        : Promise.resolve(),
      queryClient.invalidateQueries({
        queryKey: ['generation-template-tasks'],
      }),
      queryClient.invalidateQueries({ queryKey: ['saved-templates'] }),
    ]);
  };
  const removePageFromSlotFill = (
    itemId: string,
    fallbackPageNumbers: number[],
    uploadedPageNumber: number,
  ) => {
    setConfirmedPageNumbersByItemId((current) => {
      const currentPages = current[itemId] ?? fallbackPageNumbers;
      const nextPageSet = new Set(currentPages);
      nextPageSet.delete(uploadedPageNumber);

      return {
        ...current,
        [itemId]: Array.from(nextPageSet).sort((left, right) => left - right),
      };
    });
  };
  const restorePageForSlotFill = (
    itemId: string,
    fallbackPageNumbers: number[],
    uploadedPageNumber: number,
  ) => {
    setConfirmedPageNumbersByItemId((current) => {
      const currentPages = current[itemId] ?? fallbackPageNumbers;
      const nextPageSet = new Set(currentPages);
      nextPageSet.add(uploadedPageNumber);

      return {
        ...current,
        [itemId]: Array.from(nextPageSet).sort((left, right) => left - right),
      };
    });
  };
  const launchSlotFillForItem = useCallback(
    (
      item: GenerationTaskItemSummary,
      trigger: 'manual' | 'polling' | 'trace',
      confirmedPageNumbers?: number[],
    ) => {
      if (launchedSlotFillItemIdsRef.current.has(item.id)) {
        console.log(
          `[Batch Generate][${item.source_pdf_name}] Slot fill launch skipped for task item ${item.id}; already launched previously (trigger: ${trigger}, current status: ${item.status}).`,
        );
        return;
      }

      if (trigger === 'trace' && item.status !== 'pdf_pages_ready') {
        console.log(
          `[Batch Generate][${item.source_pdf_name}] Slot fill launch deferred for task item ${item.id}; trace arrived before status became pdf_pages_ready (trigger: ${trigger}, current status: ${item.status}).`,
        );
        const existingTimeouts =
          pendingSlotFillRefreshTimeoutsRef.current.get(item.id) ?? [];

        if (existingTimeouts.length === 0) {
          const retryDelaysMs = [800, 2000, 4000];
          const timeoutIds = retryDelaysMs.map((delayMs) =>
            window.setTimeout(() => {
              console.log(
                `[Batch Generate][${item.source_pdf_name}] Forcing task refresh after deferred slot-fill launch for task item ${item.id} (+${delayMs}ms).`,
              );
              void refreshTaskLists();
            }, delayMs),
          );
          pendingSlotFillRefreshTimeoutsRef.current.set(item.id, timeoutIds);
        }

        return;
      }

      const pendingTimeouts = pendingSlotFillRefreshTimeoutsRef.current.get(
        item.id,
      );
      if (pendingTimeouts && pendingTimeouts.length > 0) {
        pendingTimeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
        pendingSlotFillRefreshTimeoutsRef.current.delete(item.id);
      }

      console.log(
        `[Batch Generate][${item.source_pdf_name}] Starting slot fill for task item ${item.id} via /api/generation-task-items/${item.id}/slot-fill (trigger: ${trigger}, current status: ${item.status}).`,
      );
      console.log(
        `[Batch Generate][${item.source_pdf_name}] User confirmed pages for slot fill`,
        {
          taskItemId: item.id,
          trigger,
          confirmedPageNumbers,
          pageFilterPages: item.pdf_page_filter_pages ?? [],
        },
      );
      launchedSlotFillItemIdsRef.current.add(item.id);

      void startGenerationTaskItemSlotFillMutation
        .mutateAsync({
          taskItemId: item.id,
          confirmedPageNumbers,
        })
        .then(() => {
          console.log(
            `[Batch Generate][${item.source_pdf_name}] Slot fill request accepted for task item ${item.id} via /api/generation-task-items/${item.id}/slot-fill (trigger: ${trigger}).`,
          );
          void refreshTaskLists();
        })
        .catch((error) => {
          launchedSlotFillItemIdsRef.current.delete(item.id);
          console.error(
            `[Batch Generate][${item.source_pdf_name}] Slot fill request failed for task item ${item.id} (trigger: ${trigger}).`,
            error,
          );

          const errorMessage =
            error instanceof Error
              ? error.message
              : `${item.source_pdf_name} 槽位回填启动失败，请稍后重试。`;

          if (!errorMessage.includes('尚未完成页面准备')) {
            notifications.show({
              color: 'red',
              title: '槽位回填失败',
              message:
                error instanceof Error
                  ? `${item.source_pdf_name}：${error.message}`
                  : `${item.source_pdf_name} 槽位回填启动失败，请稍后重试。`,
            });
          } else {
            console.log(
              `[Batch Generate][${item.source_pdf_name}] Slot fill launch will be retried after page preparation status catches up for task item ${item.id}.`,
            );
          }

          void refreshTaskLists();
        });
    },
    [startGenerationTaskItemSlotFillMutation],
  );

  const rowsWithFiles = rows.filter((row): row is UploadRow & { file: File } =>
    Boolean(row.file),
  );
  const hasParsingRows = rowsWithFiles.some((row) => row.isParsing);
  const hasRowParseError = rowsWithFiles.some((row) => Boolean(row.parseError));
  const hasUnparsedRows = rowsWithFiles.some((row) => !row.parsedPdf);
  const selectedFiles = rowsWithFiles.map((row) => row.file);
  const canAddUploadRow =
    !taskId && !isPreparingFiles && rows.length < maxPdfFillTaskCount;
  const rowSelectionStates = useMemo(
    () =>
      rows.map((row) => {
        const totalPages = row.parsedPdf?.pages.length ?? 0;
        const selectedPageNumbers =
          totalPages > 0 ? buildFullPageNumbers(totalPages) : [];

        return {
          rowId: row.id,
          totalPages,
          selectedPageNumbers,
          selectedPageRangeLabel: formatCompactPageRanges(selectedPageNumbers),
        };
      }),
    [rows],
  );

  const canSubmit =
    selectedFiles.length > 0 &&
    rowsWithFiles.length <= maxPdfFillTaskCount &&
    !createGenerationTaskMutation.isPending &&
    !isPreparingFiles &&
    !taskId &&
    !hasParsingRows &&
    !hasRowParseError &&
    !hasUnparsedRows;
  const isSubmittingTask =
    !taskId && (createGenerationTaskMutation.isPending || isPreparingFiles);
  const submissionElapsedSeconds = submissionStartedAt
    ? Math.max(0, Math.floor((tick - submissionStartedAt) / 1000))
    : 0;

  const taskItems = taskQuery.data?.items ?? [];
  const hasRunningItems = taskItems.some((item) =>
    [
      'uploaded',
      'running',
      'pending',
      'page_preparing',
      'ocr_running',
      'pdf_pages_ready',
      'slot_filling',
    ].includes(item.status),
  );
  const succeededCount = taskItems.filter((item) =>
    ['review_pending', 'reviewed'].includes(item.status),
  ).length;
  const failedCount = taskItems.filter(
    (item) => item.status === 'failed',
  ).length;
  const progressValue =
    taskItems.length > 0
      ? ((succeededCount + failedCount) / taskItems.length) * 100
      : 0;
  const canCloseTaskModal =
    !isPreparingFiles &&
    (!taskId || (!taskQuery.isLoading && !hasRunningItems));
  const closeModalWithRefresh = () => {
    if (!canCloseTaskModal) {
      return;
    }

    context.closeModal(id);
    void refreshTaskLists();
  };

  useEffect(() => {
    if (!hasRunningItems && !isSubmittingTask) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setTick(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasRunningItems, isSubmittingTask]);

  useEffect(() => {
    return () => {
      pendingSlotFillRefreshTimeoutsRef.current.forEach((timeoutIds) => {
        timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
      });
      pendingSlotFillRefreshTimeoutsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      if (
        !event.data ||
        typeof event.data !== 'object' ||
        !('type' in event.data) ||
        event.data.type !== 'generation-task-reviewed'
      ) {
        return;
      }

      void refreshTaskLists();
    };

    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [queryClient, taskId]);

  useEffect(() => {
    if (!taskId || !taskQuery.data) {
      return;
    }

    taskQuery.data.items.forEach((item) => {
      if (!['uploaded', 'pending'].includes(item.status)) {
        return;
      }

      if (launchedPagePreparationItemIdsRef.current.has(item.id)) {
        return;
      }

      launchedPagePreparationItemIdsRef.current.add(item.id);
      const clientStartedAt = Date.now();
      setItemStartedAtById((current) =>
        current[item.id] ? current : { ...current, [item.id]: clientStartedAt },
      );
      console.log(
        `[Batch Generate][${item.source_pdf_name}] Preparing PDF page images for task item ${item.id} via /api/generation-task-items/${item.id}/page-preparation.`,
      );

      void processGenerationTaskItemMutation
        .mutateAsync(item.id)
        .then(() => {
          void refreshTaskLists();
        })
        .catch((error) => {
          notifications.show({
            color: 'red',
            title: '页面准备失败',
            message:
              error instanceof Error
                ? `${item.source_pdf_name}：${error.message}`
                : `${item.source_pdf_name} 处理失败，请稍后重试。`,
          });

          void refreshTaskLists();
        });
    });
  }, [processGenerationTaskItemMutation, queryClient, taskId, taskQuery.data]);

  useEffect(() => {
    if (!taskId || !taskQuery.data) {
      return;
    }

    let isDisposed = false;

    queueMicrotask(() => {
      if (isDisposed) {
        return;
      }

      setConfirmedPageNumbersByItemId((current) => {
        let hasChanges = false;
        const next = { ...current };

        taskQuery.data.items.forEach((item) => {
          if (item.status !== 'pdf_pages_ready' || next[item.id]) {
            return;
          }

          const selectedPageNumbers = (item.pdf_page_filter_pages ?? [])
            .filter((page) => page.selectedForSlotFill !== false)
            .map((page) => page.uploadedPageNumber);

          next[item.id] = selectedPageNumbers;
          hasChanges = true;
        });

        return hasChanges ? next : current;
      });
    });

    return () => {
      isDisposed = true;
    };
  }, [taskId, taskQuery.data]);

  useEffect(() => {
    if (!taskQuery.data) {
      return;
    }

    const nextKnownIds = new Set<string>();

    taskQuery.data.items.forEach((item) => {
      nextKnownIds.add(item.id);

      const nextTrace = item.processing_trace ?? '';
      const previousTrace = itemTraceRef.current.get(item.id) ?? '';

      if (!nextTrace || nextTrace === previousTrace) {
        if (!itemTraceRef.current.has(item.id)) {
          itemTraceRef.current.set(item.id, nextTrace);
        }
        return;
      }

      const previousLines = previousTrace ? previousTrace.split(/\r?\n/) : [];
      const nextLines = nextTrace.split(/\r?\n/);
      const newLines = nextLines
        .slice(previousLines.length)
        .filter((line) => line.trim().length > 0);

      newLines.forEach((line) => {
        const traceTimestampMs = getTraceTimestampMs(line);
        const traceLine = line.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+/, '');
        const slotFillInputMatch = traceLine.match(
          /^(?:\[PDF Fill\])?\[TextInputData\]\[([^\]]+)\] (.+)$/,
        );
        const slotFillPromptMatch = traceLine.match(
          /^(?:\[PDF Fill\])?\[TextPrompt\]\[([^\]]+)\] (.+)$/,
        );
        const slotFillPromptPreviewMatch = traceLine.match(
          /^(?:\[PDF Fill\])?\[TextPromptPreview\]\[([^\]]+)\] (.+)$/,
        );
        const slotFillReferenceImagesMatch = traceLine.match(
          /^\[PDF Fill\]\[ReferenceExampleImages\] (.+)$/,
        );
        const slotFillReferenceMissingMatch = traceLine.match(
          /^\[PDF Fill\]\[ReferenceExampleMissing\] (.+)$/,
        );
        const slotFillPreflightMatch = traceLine.match(
          /^\[PDF Fill\]\[SlotFillPreflight\] (.+)$/,
        );
        const errorDetailsMatch = traceLine.match(
          /^\[PDF Fill\]\[(PagePreparation|Text)\]\[ErrorDetails\]\[([^\]]+)\] (.+)$/,
        );
        const routeErrorDetailsMatch = traceLine.match(
          /^\[RouteErrorDetails\]\[([^\]]+)\] (.+)$/,
        );
        const pageFilterPromptMatch = traceLine.match(
          /^\[PDF Fill\]\[PageFilterPrompt\]\[([^\]]+)\] (.+)$/,
        );
        const pageFilterRawMatch = traceLine.match(
          /^\[PDF Fill\]\[PageFilterRaw\]\[([^\]]+)\] (.+)$/,
        );
        const directVisionPromptMatch = traceLine.match(
          /^\[PDF Fill\]\[DirectVisionPrompt\]\[([^\]]+)\] (.+)$/,
        );
        const directVisionRequestBodyMatch = traceLine.match(
          /^\[PDF Fill\]\[DirectVisionRequestBody\]\[([^\]]+)\] (.+)$/,
        );
        const directVisionTimingMatch = traceLine.match(
          /^\[PDF Fill\]\[DirectVisionTiming\]\[([^\]]+)\] (.+)$/,
        );
        const directVisionRawMatch = traceLine.match(
          /^\[PDF Fill\]\[DirectVisionRaw\]\[([^\]]+)\] (.+)$/,
        );
        const referenceAlignmentPromptMatch = traceLine.match(
          /^\[PDF Fill\]\[ReferenceAlignmentPrompt\] (.+)$/,
        );
        const referenceAlignmentRequestBodyMatch = traceLine.match(
          /^\[PDF Fill\]\[ReferenceAlignmentRequestBody\] (.+)$/,
        );
        const referenceAlignmentRawMatch = traceLine.match(
          /^\[PDF Fill\]\[ReferenceAlignmentRaw\] (.+)$/,
        );
        const referenceAlignmentResultMatch = traceLine.match(
          /^\[PDF Fill\]\[ReferenceAlignmentResult\] (.+)$/,
        );
        const slotFillOutputMatch = traceLine.match(
          /^\[PDF Fill\]\[SlotFillOutput\] (.+)$/,
        );
        const confirmedPagesMatch = traceLine.match(
          /^\[PDF Fill\]\[ConfirmedPages\] (.+)$/,
        );
        const visionPagesUsedMatch = traceLine.match(
          /^\[PDF Fill\]\[VisionPagesUsed\] (.+)$/,
        );
        const rawErrorMatch = traceLine.match(
          /^\[PDF Fill\]\[RawError\]\[([^\]]+)\] (.*)$/,
        );

        if (
          traceLine.includes(
            '[PDF Fill][PageFilter] Starting visual page filter batch 1/',
          ) &&
          traceTimestampMs !== null
        ) {
          pageFilterStartedAtRef.current.set(item.id, traceTimestampMs);
          console.info(
            `[Batch Generate][${item.source_pdf_name}] 页面过滤开始`,
            {
              taskItemId: item.id,
              startedAt: new Date(traceTimestampMs).toISOString(),
            },
          );
        }

        if (
          traceLine.includes(
            '[PDF Fill][PageFilter] PDF page images prepared and visually filtered',
          )
        ) {
          const startedAt = pageFilterStartedAtRef.current.get(item.id);
          const finishedAt = traceTimestampMs ?? Date.now();

          if (
            startedAt &&
            !pageFilterDurationLoggedItemIdsRef.current.has(item.id)
          ) {
            pageFilterDurationLoggedItemIdsRef.current.add(item.id);
            console.info(
              `[Batch Generate][${item.source_pdf_name}] 页面过滤总耗时：${formatDurationMs(
                finishedAt - startedAt,
              )}`,
              {
                taskItemId: item.id,
                startedAt: new Date(startedAt).toISOString(),
                finishedAt: new Date(finishedAt).toISOString(),
                durationMs: finishedAt - startedAt,
              },
            );
          }
        }

        if (traceLine.includes('[PDF Fill][RawError][PageFilter]')) {
          const startedAt = pageFilterStartedAtRef.current.get(item.id);
          const finishedAt = traceTimestampMs ?? Date.now();

          if (
            startedAt &&
            !pageFilterDurationLoggedItemIdsRef.current.has(item.id)
          ) {
            pageFilterDurationLoggedItemIdsRef.current.add(item.id);
            console.warn(
              `[Batch Generate][${item.source_pdf_name}] 页面过滤失败前耗时：${formatDurationMs(
                finishedAt - startedAt,
              )}`,
              {
                taskItemId: item.id,
                startedAt: new Date(startedAt).toISOString(),
                finishedAt: new Date(finishedAt).toISOString(),
                durationMs: finishedAt - startedAt,
              },
            );
          }
        }

        if (pageFilterPromptMatch) {
          const label = pageFilterPromptMatch[1] ?? 'batch';
          const parsedPrompt = parseTraceJson<Record<string, unknown>>(
            pageFilterPromptMatch[2] ?? '{}',
            `page filter prompt ${label}`,
          );

          if (!parsedPrompt) {
            return;
          }

          const currentEntries = window.clipcapPageFilterPrompts ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name && entry.label === label
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            label,
            data: parsedPrompt,
          });
          window.clipcapPageFilterPrompts = nextEntries.sort((left, right) => {
            if (left.fileName === right.fileName) {
              return left.label.localeCompare(right.label);
            }

            return left.fileName.localeCompare(right.fileName);
          });

          console.log(
            `[Batch Generate][${item.source_pdf_name}] PDF page filter VISION_LLM prompt (${label})`,
            parsedPrompt,
          );

          const userPromptContent =
            Array.isArray(parsedPrompt.messages) &&
            parsedPrompt.messages.find(
              (message) =>
                !!message &&
                typeof message === 'object' &&
                (message as { role?: unknown }).role === 'user',
            )
              ? (
                  parsedPrompt.messages.find(
                    (message) =>
                      !!message &&
                      typeof message === 'object' &&
                      (message as { role?: unknown }).role === 'user',
                  ) as { content?: unknown }
                ).content
              : null;

          console.log(
            `[Batch Generate][${item.source_pdf_name}] PDF page filter VISION_LLM user prompt content (${label})`,
            {
              route: parsedPrompt.route,
              model: parsedPrompt.model,
              provider: parsedPrompt.provider,
              requestLabel: parsedPrompt.request_label,
              imagePayload: parsedPrompt.image_payload,
              imagePlaceholders: parsedPrompt.image_placeholders,
              dropExamples: parsedPrompt.drop_examples,
              prompt: userPromptContent,
            },
          );

          const imageAttachmentList = formatVisionImageAttachmentList(
            parsedPrompt.image_placeholders,
          );

          if (imageAttachmentList) {
            logConsoleTextChunks(
              `[Batch Generate][${item.source_pdf_name}] PDF page filter candidate image attachments (${label})`,
              imageAttachmentList,
            );
          }

          const dropExampleAttachmentList =
            formatPageFilterDropExampleAttachmentList(
              parsedPrompt.drop_examples,
            );

          if (dropExampleAttachmentList) {
            logConsoleTextChunks(
              `[Batch Generate][${item.source_pdf_name}] PDF page filter drop example attachments (${label})`,
              dropExampleAttachmentList,
            );
          }

          logConsoleTextChunks(
            `[Batch Generate][${item.source_pdf_name}] PDF page filter VISION_LLM user prompt JSON (${label})`,
            JSON.stringify(userPromptContent, null, 2),
          );
          return;
        }

        if (pageFilterRawMatch) {
          const label = pageFilterRawMatch[1] ?? 'batch';
          const parsedResult = parseTraceJson<Record<string, unknown>>(
            pageFilterRawMatch[2] ?? '{}',
            `page filter raw result ${label}`,
          );

          if (!parsedResult) {
            return;
          }

          const currentEntries = window.clipcapPageFilterResults ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name && entry.label === label
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            label,
            data: parsedResult,
          });
          window.clipcapPageFilterResults = nextEntries.sort((left, right) => {
            if (left.fileName === right.fileName) {
              return left.label.localeCompare(right.label);
            }

            return left.fileName.localeCompare(right.fileName);
          });

          console.log(
            `[Batch Generate][${item.source_pdf_name}] PDF page filter VISION_LLM raw result (${label})`,
            parsedResult,
          );

          const rawResponse = parsedResult.raw_response;

          if (typeof rawResponse === 'string' && rawResponse.trim()) {
            logConsoleTextChunks(
              `[Batch Generate][${item.source_pdf_name}] PDF page filter VISION_LLM raw model output (${label})`,
              rawResponse,
            );
          }

          logConsoleTextChunks(
            `[Batch Generate][${item.source_pdf_name}] PDF page filter VISION_LLM parsed result JSON (${label})`,
            JSON.stringify(parsedResult.parsed_results ?? parsedResult, null, 2),
          );
          return;
        }

        if (referenceAlignmentPromptMatch) {
          const parsedPrompt = parseTraceJson<Record<string, unknown>>(
            referenceAlignmentPromptMatch[1] ?? '{}',
            'reference page alignment prompt',
          );

          if (!parsedPrompt) {
            return;
          }

          const currentEntries =
            window.clipcapReferencePageAlignmentPrompts ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name &&
                entry.taskItemId === item.id
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            taskItemId: item.id,
            data: parsedPrompt,
          });
          window.clipcapReferencePageAlignmentPrompts = nextEntries.sort(
            (left, right) => {
              if (left.fileName === right.fileName) {
                return left.taskItemId.localeCompare(right.taskItemId);
              }

              return left.fileName.localeCompare(right.fileName);
            },
          );

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Reference page alignment prompt`,
            parsedPrompt,
          );

          const userPromptContent =
            Array.isArray(parsedPrompt.messages) &&
            parsedPrompt.messages.find(
              (message) =>
                !!message &&
                typeof message === 'object' &&
                (message as { role?: unknown }).role === 'user',
            )
              ? (
                  parsedPrompt.messages.find(
                    (message) =>
                      !!message &&
                      typeof message === 'object' &&
                      (message as { role?: unknown }).role === 'user',
                  ) as { content?: unknown }
                ).content
              : null;

          const imageAttachmentList = formatVisionImageAttachmentList(
            parsedPrompt.image_placeholders,
          );

          if (imageAttachmentList) {
            logConsoleTextChunks(
              `[Batch Generate][${item.source_pdf_name}] Reference page alignment new PDF image attachments`,
              imageAttachmentList,
            );
          }

          const referenceImageAttachmentList =
            formatReferenceImageAttachmentList(
              parsedPrompt.reference_image_placeholders,
            );

          if (referenceImageAttachmentList) {
            logConsoleTextChunks(
              `[Batch Generate][${item.source_pdf_name}] Reference page alignment reference image attachments`,
              referenceImageAttachmentList,
            );
          }

          logConsoleTextChunks(
            `[Batch Generate][${item.source_pdf_name}] Reference page alignment user prompt JSON`,
            JSON.stringify(userPromptContent, null, 2),
          );
          return;
        }

        if (referenceAlignmentRequestBodyMatch) {
          const parsedRequestBody = parseTraceJson<Record<string, unknown>>(
            referenceAlignmentRequestBodyMatch[1] ?? '{}',
            'reference page alignment request body',
          );

          if (!parsedRequestBody) {
            return;
          }

          const currentEntries =
            window.clipcapReferencePageAlignmentRequestBodies ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name &&
                entry.taskItemId === item.id
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            taskItemId: item.id,
            data: parsedRequestBody,
          });
          window.clipcapReferencePageAlignmentRequestBodies = nextEntries.sort(
            (left, right) => {
              if (left.fileName === right.fileName) {
                return left.taskItemId.localeCompare(right.taskItemId);
              }

              return left.fileName.localeCompare(right.fileName);
            },
          );

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Reference page alignment actual Gemini request body`,
            parsedRequestBody,
          );
          logConsoleTextChunks(
            `[Batch Generate][${item.source_pdf_name}] Reference page alignment actual Gemini request body JSON`,
            JSON.stringify(
              parsedRequestBody.request_body ?? parsedRequestBody,
              null,
              2,
            ),
          );
          return;
        }

        if (referenceAlignmentRawMatch) {
          const parsedRaw = parseTraceJson<Record<string, unknown>>(
            referenceAlignmentRawMatch[1] ?? '{}',
            'reference page alignment raw result',
          );

          if (!parsedRaw) {
            return;
          }

          const currentEntries =
            window.clipcapReferencePageAlignmentRawResponses ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name &&
                entry.taskItemId === item.id
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            taskItemId: item.id,
            data: parsedRaw,
          });
          window.clipcapReferencePageAlignmentRawResponses = nextEntries.sort(
            (left, right) => {
              if (left.fileName === right.fileName) {
                return left.taskItemId.localeCompare(right.taskItemId);
              }

              return left.fileName.localeCompare(right.fileName);
            },
          );

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Reference page alignment raw result`,
            parsedRaw,
          );
          console.log(
            `[Batch Generate][${item.source_pdf_name}] Reference page alignment raw model output`,
            parsedRaw.raw_response ?? parsedRaw,
          );
          return;
        }

        if (referenceAlignmentResultMatch) {
          const parsedResult = parseTraceJson<Record<string, unknown>>(
            referenceAlignmentResultMatch[1] ?? '{}',
            'reference page alignment result',
          );

          if (!parsedResult) {
            return;
          }

          const currentEntries = window.clipcapReferencePageAlignments ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name &&
                entry.taskItemId === item.id
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            taskItemId: item.id,
            data: parsedResult,
          });
          window.clipcapReferencePageAlignments = nextEntries.sort(
            (left, right) => {
              if (left.fileName === right.fileName) {
                return left.taskItemId.localeCompare(right.taskItemId);
              }

              return left.fileName.localeCompare(right.fileName);
            },
          );

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Reference page alignment result`,
            parsedResult,
          );
          return;
        }

        if (directVisionRequestBodyMatch) {
          const label = directVisionRequestBodyMatch[1] ?? 'Full';
          const parsedRequestBody = parseTraceJson<Record<string, unknown>>(
            directVisionRequestBodyMatch[2] ?? '{}',
            `direct vision request body ${label}`,
          );

          if (!parsedRequestBody) {
            return;
          }

          const currentEntries =
            window.clipcapSlotFillActualRequestBodies ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name && entry.label === label
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            label,
            data: parsedRequestBody,
          });
          window.clipcapSlotFillActualRequestBodies = nextEntries.sort(
            (left, right) => {
              if (left.fileName === right.fileName) {
                return left.label.localeCompare(right.label);
              }

              return left.fileName.localeCompare(right.fileName);
            },
          );

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Direct VISION slot-fill actual Gemini request body (${label})`,
            parsedRequestBody,
          );
          logConsoleTextChunks(
            `[Batch Generate][${item.source_pdf_name}] Direct VISION slot-fill actual Gemini request body JSON (${label})`,
            JSON.stringify(
              parsedRequestBody.request_body ?? parsedRequestBody,
              null,
              2,
            ),
          );
          return;
        }

        if (directVisionTimingMatch) {
          const label = directVisionTimingMatch[1] ?? 'Full';
          const parsedTiming = parseTraceJson<Record<string, unknown>>(
            directVisionTimingMatch[2] ?? '{}',
            `direct vision timing ${label}`,
          );

          if (!parsedTiming) {
            return;
          }

          const totalDurationMs = parsedTiming.total_duration_ms;
          const modelRequestDurationMs =
            parsedTiming.model_request_duration_ms;

          console.info(
            `[Batch Generate][${item.source_pdf_name}] Direct VISION 槽位回填总耗时（${label}）：${
              typeof totalDurationMs === 'number'
                ? formatDurationMs(totalDurationMs)
                : '未记录'
            }`,
            parsedTiming,
          );

          if (typeof modelRequestDurationMs === 'number') {
            logConsoleTextChunks(
              `[Batch Generate][${item.source_pdf_name}] Direct VISION 槽位回填耗时摘要（${label}）`,
              [
                `模型请求链路：${formatDurationMs(modelRequestDurationMs)}`,
                `Direct Vision 总耗时：${
                  typeof totalDurationMs === 'number'
                    ? formatDurationMs(totalDurationMs)
                    : '未记录'
                }`,
              ].join('\n'),
            );
          }

          return;
        }

        if (directVisionPromptMatch) {
          const label = directVisionPromptMatch[1] ?? 'Full';
          const parsedPrompt = parseTraceJson<
            Record<string, unknown> & {
              route?: string;
              model?: string;
              request_label?: string;
              messages?: Array<{
                role: string;
                content: unknown;
              }>;
            }
          >(
            directVisionPromptMatch[2] ?? '{}',
            `direct vision prompt ${label}`,
          );

          if (!parsedPrompt) {
            return;
          }

          const currentEntries = window.clipcapSlotFillPrompts ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name && entry.label === label
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            label,
            data: parsedPrompt,
          });
          window.clipcapSlotFillPrompts = nextEntries.sort((left, right) => {
            if (left.fileName === right.fileName) {
              return left.label.localeCompare(right.label);
            }

            return left.fileName.localeCompare(right.fileName);
          });

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Direct VISION slot-fill prompt (${label})`,
            parsedPrompt,
          );
          const userPromptContent = parsedPrompt.messages?.find(
            (message) => message.role === 'user',
          )?.content;
          const slotDefinitionCount =
            userPromptContent &&
            typeof userPromptContent === 'object' &&
            !Array.isArray(userPromptContent) &&
            Array.isArray(
              (userPromptContent as { slot_definitions?: unknown })
                .slot_definitions,
            )
              ? (userPromptContent as { slot_definitions: unknown[] })
                  .slot_definitions.length
              : null;

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Direct VISION slot-fill user prompt content (${label})`,
            {
              route: parsedPrompt.route,
              model: parsedPrompt.model,
              requestLabel: parsedPrompt.request_label,
              slotDefinitionCount,
              imagePayload: parsedPrompt.image_payload,
              imagePlaceholders: parsedPrompt.image_placeholders,
              referenceImagePlaceholders:
                parsedPrompt.reference_image_placeholders,
              prompt: userPromptContent,
            },
          );
          const imageAttachmentList = formatVisionImageAttachmentList(
            parsedPrompt.image_placeholders,
          );

          if (imageAttachmentList) {
            logConsoleTextChunks(
              `[Batch Generate][${item.source_pdf_name}] Direct VISION slot-fill image attachments (${label})`,
              imageAttachmentList,
            );
          }

          const referenceImageAttachmentList =
            formatReferenceImageAttachmentList(
              parsedPrompt.reference_image_placeholders,
            );

          if (referenceImageAttachmentList) {
            logConsoleTextChunks(
              `[Batch Generate][${item.source_pdf_name}] Direct VISION slot-fill reference image attachments (${label})`,
              referenceImageAttachmentList,
            );
          }

          logConsoleTextChunks(
            `[Batch Generate][${item.source_pdf_name}] Direct VISION slot-fill user prompt JSON (${label})`,
            JSON.stringify(userPromptContent, null, 2),
          );
          return;
        }

        if (directVisionRawMatch) {
          const label = directVisionRawMatch[1] ?? 'Full';
          const parsedRaw = parseTraceJson<Record<string, unknown>>(
            directVisionRawMatch[2] ?? '{}',
            `direct vision raw result ${label}`,
          );

          if (!parsedRaw) {
            return;
          }

          const currentEntries = window.clipcapSlotFillRawResponses ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name && entry.label === label
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            label,
            data: parsedRaw,
          });
          window.clipcapSlotFillRawResponses = nextEntries.sort(
            (left, right) => {
              if (left.fileName === right.fileName) {
                return left.label.localeCompare(right.label);
              }

              return left.fileName.localeCompare(right.fileName);
            },
          );

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Direct VISION slot-fill raw result (${label})`,
            parsedRaw,
          );
          console.log(
            `[Batch Generate][${item.source_pdf_name}] Direct VISION slot-fill raw model output (${label})`,
            parsedRaw.raw_response ?? parsedRaw,
          );
          return;
        }

        if (slotFillOutputMatch) {
          const parsedOutput = parseTraceJson<Record<string, unknown>>(
            slotFillOutputMatch[1] ?? '{}',
            'slot fill output',
          );

          if (!parsedOutput) {
            return;
          }

          const currentEntries = window.clipcapSlotFillOutputs ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name &&
                entry.taskItemId === item.id
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            taskItemId: item.id,
            data: parsedOutput,
          });
          window.clipcapSlotFillOutputs = nextEntries.sort((left, right) => {
            if (left.fileName === right.fileName) {
              return left.taskItemId.localeCompare(right.taskItemId);
            }

            return left.fileName.localeCompare(right.fileName);
          });

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Slot fill LLM parsed output`,
            parsedOutput,
          );
          return;
        }

        if (confirmedPagesMatch) {
          const parsedConfirmedPages = parseTraceJson<Record<string, unknown>>(
            confirmedPagesMatch[1] ?? '{}',
            'confirmed slot-fill pages',
          );

          if (!parsedConfirmedPages) {
            return;
          }

          const currentEntries = window.clipcapConfirmedSlotFillPages ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name &&
                entry.taskItemId === item.id
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            taskItemId: item.id,
            data: parsedConfirmedPages,
          });
          window.clipcapConfirmedSlotFillPages = nextEntries.sort(
            (left, right) => {
              if (left.fileName === right.fileName) {
                return left.taskItemId.localeCompare(right.taskItemId);
              }

              return left.fileName.localeCompare(right.fileName);
            },
          );

          console.log(
            `[Batch Generate][${item.source_pdf_name}] User confirmed slot-fill pages`,
            parsedConfirmedPages,
          );
          return;
        }

        if (visionPagesUsedMatch) {
          const parsedPagesUsed = parseTraceJson<Record<string, unknown>>(
            visionPagesUsedMatch[1] ?? '{}',
            'vision pages used',
          );

          if (!parsedPagesUsed) {
            return;
          }

          const currentEntries = window.clipcapVisionPagesUsed ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name &&
                entry.taskItemId === item.id
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            taskItemId: item.id,
            data: parsedPagesUsed,
          });
          window.clipcapVisionPagesUsed = nextEntries.sort((left, right) => {
            if (left.fileName === right.fileName) {
              return left.taskItemId.localeCompare(right.taskItemId);
            }

            return left.fileName.localeCompare(right.fileName);
          });

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Pages actually sent to VISION_LLM`,
            parsedPagesUsed,
          );
          return;
        }

        if (rawErrorMatch) {
          const scope = rawErrorMatch[1] ?? 'Unknown';
          const rawMessage = rawErrorMatch[2] ?? '';

          console.error(
            `[Batch Generate][${item.source_pdf_name}] Raw ${scope} error`,
            rawMessage,
          );
          return;
        }

        if (slotFillPreflightMatch) {
          const parsedPreflight = parseTraceJson<Record<string, unknown>>(
            slotFillPreflightMatch[1] ?? '{}',
            'slot fill preflight',
          );

          if (!parsedPreflight) {
            return;
          }

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Slot fill preflight: images and slots before VISION_LLM`,
            parsedPreflight,
          );
          return;
        }

        if (slotFillInputMatch) {
          const label = slotFillInputMatch[1] ?? 'Full';
          const parsedData = JSON.parse(slotFillInputMatch[2] ?? '{}') as {
            document_name: string;
            page_numbers: number[];
            slot_definitions: Array<{
              slot_key: string;
              slot_name: string;
              slot_meaning: string;
            }>;
            content: string;
          };
          const currentEntries = window.clipcapSlotFillInputs ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name && entry.label === label
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            label,
            data: parsedData,
          });

          window.clipcapSlotFillInputs = nextEntries.sort((left, right) => {
            if (left.fileName === right.fileName) {
              return left.label.localeCompare(right.label);
            }

            return left.fileName.localeCompare(right.fileName);
          });

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Slot fill input stored in window.clipcapSlotFillInputs (${label}).`,
          );
          return;
        }

        if (slotFillPromptMatch) {
          const label = slotFillPromptMatch[1] ?? 'Full';
          const parsedPrompt = JSON.parse(slotFillPromptMatch[2] ?? '{}') as {
            route?: string;
            model?: string;
            request_label?: string;
            messages?: Array<{
              role: string;
              content: unknown;
            }>;
          };
          const currentEntries = window.clipcapSlotFillPrompts ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name && entry.label === label
              ),
          );

          nextEntries.push({
            fileName: item.source_pdf_name,
            label,
            data: parsedPrompt,
          });

          window.clipcapSlotFillPrompts = nextEntries.sort((left, right) => {
            if (left.fileName === right.fileName) {
              return left.label.localeCompare(right.label);
            }

            return left.fileName.localeCompare(right.fileName);
          });

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Slot fill prompt via ${
              parsedPrompt.route ??
              '/api/generation-task-items/[taskItemId]/slot-fill'
            } (${label})`,
            parsedPrompt,
          );
          return;
        }

        if (slotFillPromptPreviewMatch) {
          const label = slotFillPromptPreviewMatch[1] ?? 'DirectVision';
          const parsedPrompt = JSON.parse(
            slotFillPromptPreviewMatch[2] ?? '{}',
          ) as {
            route?: string;
            request_label?: string;
            document_name?: string;
            messages?: Array<{
              role: string;
              content: unknown;
            }>;
          };

          console.log(
            `[Batch Generate][${item.source_pdf_name}] Slot fill prompt preview via ${
              parsedPrompt.route ??
              '/api/generation-task-items/[taskItemId]/slot-fill'
            } (${label})`,
            parsedPrompt,
          );
          return;
        }

        if (slotFillReferenceImagesMatch) {
          const parsedReferenceImages = JSON.parse(
            slotFillReferenceImagesMatch[1] ?? '{}',
          ) as {
            document_name?: string;
            skipped_reference_page_downloads?: Array<{
              page_number?: number;
              storage_path?: string;
              slot_count?: number;
              error_message?: string;
            }>;
            pages?: Array<{
              example_pdf_file_name?: string | null;
              page_number?: number;
              original_page_number?: number;
              annotated_preview_url?: string | null;
              annotated_storage_path?: string | null;
              annotated_slots?: Array<{
                slot_key?: string;
                slot_name?: string;
                slot_source?: string;
                example_box_2d?: [number, number, number, number] | null;
                example_evidence_text?: string;
                example_slot_value?: string;
              }>;
            }>;
          };
          const skippedReferencePageDownloads =
            parsedReferenceImages.skipped_reference_page_downloads ?? [];

          if (skippedReferencePageDownloads.length > 0) {
            console.warn(
              `[Batch Generate][${item.source_pdf_name}] Slot fill reference PDF page images were not attached because Storage objects are missing.`,
              skippedReferencePageDownloads,
            );

            skippedReferencePageDownloads.forEach((downloadFailure) => {
              console.warn(
                `[Batch Generate][${item.source_pdf_name}][PDF Fill][ReferenceExampleMissing] ` +
                  `reference_page=${downloadFailure.page_number ?? 'unknown'}, storage_path=${
                    downloadFailure.storage_path ?? 'none'
                  }, slot_count=${downloadFailure.slot_count ?? 0}, error=${
                    downloadFailure.error_message ?? 'unknown'
                  }`,
              );
            });
          }

          const currentEntries = window.clipcapSlotFillReferenceImages ?? [];
          const nextEntries = currentEntries.filter(
            (entry) =>
              !(
                entry.fileName === item.source_pdf_name &&
                entry.taskItemId === item.id
              ),
          );

          (parsedReferenceImages.pages ?? []).forEach((page) => {
            const previewUrl = page.annotated_preview_url ?? '';

            if (!previewUrl) {
              return;
            }

            (page.annotated_slots ?? []).forEach((slot) => {
              nextEntries.push({
                fileName: item.source_pdf_name,
                taskItemId: item.id,
                examplePdfFileName: page.example_pdf_file_name ?? null,
                referencePageNumber: page.page_number ?? 0,
                originalReferencePageNumber: page.original_page_number,
                slotKey: slot.slot_key ?? '',
                slotName: slot.slot_name ?? '',
                slotSource: slot.slot_source ?? '',
                exampleBox2d: slot.example_box_2d ?? null,
                exampleEvidenceText: slot.example_evidence_text ?? '',
                exampleSlotValue: slot.example_slot_value ?? '',
                previewUrl,
                storagePath: page.annotated_storage_path ?? null,
              });
            });
          });

          window.clipcapSlotFillReferenceImages = nextEntries.sort(
            (left, right) => {
              if (left.fileName === right.fileName) {
                if (left.referencePageNumber === right.referencePageNumber) {
                  return left.slotKey.localeCompare(right.slotKey);
                }

                return left.referencePageNumber - right.referencePageNumber;
              }

              return left.fileName.localeCompare(right.fileName);
            },
          );

          const currentFileReferenceEntries =
            window.clipcapSlotFillReferenceImages.filter(
              (entry) =>
                entry.fileName === item.source_pdf_name &&
                entry.taskItemId === item.id,
            );

          console.info(
            `[Batch Generate][${item.source_pdf_name}] Slot fill reference example images stored in window.clipcapSlotFillReferenceImages. Run window.open(window.clipcapSlotFillReferenceImages[0].previewUrl) to inspect the annotated example image.`,
            currentFileReferenceEntries,
          );

          const referencePagesByKey = new Map<
            string,
            {
              referencePageNumber: number;
              originalReferencePageNumber?: number;
              examplePdfFileName?: string | null;
              previewUrl: string;
              storagePath?: string | null;
              slotKeys: string[];
            }
          >();

          currentFileReferenceEntries.forEach((entry) => {
            const pageKey = `${entry.referencePageNumber}:${entry.previewUrl}`;
            const existingPage = referencePagesByKey.get(pageKey);

            if (existingPage) {
              existingPage.slotKeys.push(entry.slotKey);
              return;
            }

            referencePagesByKey.set(pageKey, {
              referencePageNumber: entry.referencePageNumber,
              originalReferencePageNumber: entry.originalReferencePageNumber,
              examplePdfFileName: entry.examplePdfFileName,
              previewUrl: entry.previewUrl,
              storagePath: entry.storagePath,
              slotKeys: [entry.slotKey],
            });
          });

          [...referencePagesByKey.values()].forEach((page) => {
            console.info(
              `[Batch Generate][${item.source_pdf_name}][PDF Fill][ReferenceExampleImage] ` +
                `reference_page=${page.referencePageNumber}, original_page=${
                  page.originalReferencePageNumber ?? page.referencePageNumber
                }, example_pdf=${page.examplePdfFileName ?? 'none'}, storage_path=${
                  page.storagePath ?? 'none'
                }, slot_keys=${page.slotKeys.join(',')}, signed_url=${
                  page.previewUrl
                }`,
            );
            console.info(page.previewUrl);
          });
          return;
        }

        if (slotFillReferenceMissingMatch) {
          const parsedMissingReferencePage = parseTraceJson<{
            document_name?: string;
            page_number?: number;
            storage_path?: string;
            slot_count?: number;
            error_message?: string;
          }>(
            slotFillReferenceMissingMatch[1] ?? '{}',
            'slot fill missing reference example page',
          );

          if (!parsedMissingReferencePage) {
            return;
          }

          console.warn(
            `[Batch Generate][${item.source_pdf_name}][PDF Fill][ReferenceExampleMissing] ` +
              `reference_page=${parsedMissingReferencePage.page_number ?? 'unknown'}, storage_path=${
                parsedMissingReferencePage.storage_path ?? 'none'
              }, slot_count=${parsedMissingReferencePage.slot_count ?? 0}, error=${
                parsedMissingReferencePage.error_message ?? 'unknown'
              }`,
            parsedMissingReferencePage,
          );
          return;
        }

        if (errorDetailsMatch) {
          const scope = errorDetailsMatch[1] ?? 'Unknown';
          const label = errorDetailsMatch[2] ?? 'Unknown';
          const parsedDetails = parseTraceJson<Record<string, unknown>>(
            errorDetailsMatch[3] ?? '{}',
            `${scope} error details ${label}`,
          );

          if (!parsedDetails) {
            return;
          }

          console.error(
            `[Batch Generate][${item.source_pdf_name}] ${scope} error details (${label})`,
            parsedDetails,
          );
          return;
        }

        if (routeErrorDetailsMatch) {
          const scope = routeErrorDetailsMatch[1] ?? 'Unknown';
          const parsedDetails = parseTraceJson<Record<string, unknown>>(
            routeErrorDetailsMatch[2] ?? '{}',
            `route error details ${scope}`,
          );

          if (!parsedDetails) {
            return;
          }

          console.error(
            `[Batch Generate][${item.source_pdf_name}] Route error details (${scope})`,
            parsedDetails,
          );
          return;
        }

        if (
          line.includes(
            'PDF 页面图片已准备完成，前端轮询检测到后将显示页面确认区域',
          ) ||
          line.includes('已完成视觉页面过滤，等待用户确认用于回填的页面')
        ) {
          console.log(
            `[Batch Generate][${item.source_pdf_name}] PDF page ready trace observed for task item ${item.id}; waiting for user page confirmation.`,
          );
          console.log(`[Batch Generate][${item.source_pdf_name}] ${line}`);
          return;
        }

        if (
          line.includes('[PDF Fill][PagePreparation] Failed') ||
          line.includes('页面准备失败')
        ) {
          console.error(`[Batch Generate][${item.source_pdf_name}] ${line}`);
          return;
        }

        if (
          line.includes('[PDF Fill][Text] Failed') ||
          line.includes('Text slot fill failed') ||
          line.includes('模型自动回填失败') ||
          line.includes('upstream fetch failed') ||
          line.includes('Text model request failed') ||
          line.includes('Vision model request failed')
        ) {
          console.error(`[Batch Generate][${item.source_pdf_name}] ${line}`);
          return;
        }

        if (
          line.includes('[PDF Fill][Text]') ||
          line.includes('Text slot fill') ||
          line.includes('槽位回填')
        ) {
          console.log(`[Batch Generate][${item.source_pdf_name}] ${line}`);
          return;
        }

        console.info(`[Batch Generate][${item.source_pdf_name}] ${line}`);
      });

      itemTraceRef.current.set(item.id, nextTrace);
    });

    Array.from(itemTraceRef.current.keys()).forEach((itemId) => {
      if (!nextKnownIds.has(itemId)) {
        itemTraceRef.current.delete(itemId);
        pageFilterStartedAtRef.current.delete(itemId);
        pageFilterDurationLoggedItemIdsRef.current.delete(itemId);
      }
    });
  }, [taskQuery.data]);

  const updateRow = (rowId: string, patch: Partial<UploadRow>) => {
    setRows((currentRows) =>
      currentRows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
    );
  };

  const logSubmissionStage = (stage: {
    title: string;
    description: string;
  }) => {
    console.info(
      `[Batch Generate][Stage] ${stage.title}：${stage.description}`,
    );
  };

  const handleSelectPdfFile = async (rowId: string, file: File | null) => {
    if (file) {
      const normalizedSelectedFileName = normalizeUploadFileName(file.name);
      const duplicateRows = rows.filter(
        (row) =>
          row.id !== rowId &&
          row.file &&
          normalizeUploadFileName(row.file.name) === normalizedSelectedFileName,
      );

      if (duplicateRows.length > 0) {
        const duplicateRowDetails = duplicateRows.map((row) => ({
          rowId: row.id,
          rowNumber:
            rows.findIndex((currentRow) => currentRow.id === row.id) + 1,
          fileName: row.file?.name ?? null,
        }));

        console.warn('[Batch Generate][Duplicate PDF File Name]', {
          selectedFileName: file.name,
          selectedRowId: rowId,
          duplicateRows: duplicateRowDetails.map((row, index) => ({
            ...row,
            duplicateIndex: index + 1,
          })),
        });

        setDuplicatePdfFileNameAlert({
          fileName: file.name,
          selectedRowId: rowId,
          duplicateRows: duplicateRowDetails,
        });
        return;
      }
    }

    updateRow(rowId, {
      file,
      parsedPdf: null,
      isParsing: Boolean(file),
      parseError: null,
      forceVisionPageFill: false,
    });

    if (!file) {
      updateRow(rowId, {
        isParsing: false,
      });
      return;
    }

    try {
      const parsedPdf = await parsePdf(file);

      updateRow(rowId, {
        parsedPdf,
        isParsing: false,
        parseError: null,
      });
    } catch (error) {
      updateRow(rowId, {
        parsedPdf: null,
        isParsing: false,
        parseError:
          error instanceof Error
            ? error.message
            : 'PDF 解析失败，请重新选择文件。',
      });
    }
  };

  const handleCreateTask = async () => {
    if (rowsWithFiles.length > maxPdfFillTaskCount) {
      notifications.show({
        color: 'yellow',
        title: '任务数量超过限制',
        message: `当前最多一次添加 ${maxPdfFillTaskCount} 个 PDF 回填任务。`,
      });
      return;
    }

    if (!canSubmit) {
      return;
    }

    setIsPreparingFiles(true);
    const submissionStartedAtMs = Date.now();
    setSubmissionStartedAt(submissionStartedAtMs);
    logSubmissionStage({
      title: '正在准备文件',
      description:
        '正在解析 PDF 并准备批量任务输入，回填将使用上传 PDF 的全部页面。',
    });

    try {
      const renderAllStartedAt = Date.now();
      const preparedFiles = await Promise.all(
        rowsWithFiles.map(async (row, rowIndex) => {
          const file = row.file;
          const parsedPdf = row.parsedPdf;
          const rowSelectionState = rowSelectionStates.find(
            (state) => state.rowId === row.id,
          );

          if (!parsedPdf || !rowSelectionState) {
            throw new Error('当前 PDF 尚未解析完成，请稍候再试。');
          }

          const selectedOriginalPageNumbers =
            rowSelectionState.selectedPageNumbers;
          const uploadedPageNumberMapping = selectedOriginalPageNumbers.map(
            (originalPageNumber, index) => ({
              uploaded_page_number: index + 1,
              original_page_number: originalPageNumber,
            }),
          );
          const pdfPageRenderConcurrency = getPdfVisionRenderConcurrency();
          logSubmissionStage({
            title: '正在生成 PDF 页面图片',
            description: `${file.name}：正在并行生成 PDF 页面图片（文件 ${rowIndex + 1}/${rowsWithFiles.length}，共 ${selectedOriginalPageNumbers.length} 页，并发数 ${pdfPageRenderConcurrency}）。`,
          });
          const renderStartedAt = Date.now();
          const pdfVisionPages = await renderPdfPagesForVision(
            file,
            selectedOriginalPageNumbers,
            {
              concurrency: pdfPageRenderConcurrency,
              onPageRendered: ({ index, total }) => {
                logSubmissionStage({
                  title: '正在生成 PDF 页面图片',
                  description: `${file.name}：已生成 ${index}/${total} 张 PDF 页面图片，并发数 ${pdfPageRenderConcurrency}。`,
                });
              },
            },
          );
          const renderDurationMs = Date.now() - renderStartedAt;
          console.info(
            `[Batch Generate][${file.name}] PDF 转 PNG 总耗时：${formatDurationMs(
              renderDurationMs,
            )}`,
            {
              fileName: file.name,
              pageCount: pdfVisionPages.length,
              selectedOriginalPageNumbers,
              renderConcurrency: pdfPageRenderConcurrency,
              durationMs: renderDurationMs,
            },
          );
          logSubmissionStage({
            title: 'PDF 页面图片生成完成',
            description: `${file.name}：已生成 ${pdfVisionPages.length} 张 PDF 页面图片，准备上传到存储。`,
          });

          const currentImages = window.clipcapPdfPageImages ?? [];
          const nextImages = currentImages.filter(
            (entry) => entry.fileName !== file.name,
          );

          pdfVisionPages.forEach((visionPage, index) => {
            const uploadedPageNumber =
              uploadedPageNumberMapping[index]?.uploaded_page_number ??
              index + 1;
            const originalPageNumber =
              uploadedPageNumberMapping[index]?.original_page_number ??
              visionPage.pageNumber;
            const previewUrl = pdfVisionPageToObjectUrl(visionPage);

            nextImages.push({
              fileName: file.name,
              originalPageNumber,
              uploadedPageNumber,
              previewUrl,
              rotationApplied: visionPage.rotationApplied ?? 0,
              ...(visionPage.imageDataUrl
                ? { imageDataUrl: visionPage.imageDataUrl }
                : {}),
            });
          });

          window.clipcapPdfPageImages = nextImages.sort((left, right) => {
            if (left.fileName === right.fileName) {
              return left.uploadedPageNumber - right.uploadedPageNumber;
            }

            return left.fileName.localeCompare(right.fileName);
          });

          console.info(
            `[Batch Generate][${file.name}] PDF page images prepared: ${pdfVisionPages.length} page(s). Use window.clipcapPdfPageImages in the browser console, or run window.open(window.clipcapPdfPageImages[0].previewUrl).`,
          );
          pdfVisionPages.forEach((visionPage, index) => {
            const uploadedPageNumber =
              uploadedPageNumberMapping[index]?.uploaded_page_number ??
              index + 1;
            const originalPageNumber =
              uploadedPageNumberMapping[index]?.original_page_number ??
              visionPage.pageNumber;
            const previewUrl =
              window.clipcapPdfPageImages?.find(
                (entry) =>
                  entry.fileName === file.name &&
                  entry.uploadedPageNumber === uploadedPageNumber,
              )?.previewUrl ?? '';

            console.info(
              `[Batch Generate][${file.name}][PDF Page Image] uploaded page ${uploadedPageNumber}, original PDF page ${originalPageNumber}, rotation=${visionPage.rotationApplied ?? 0}: ${previewUrl}`,
            );
          });

          return {
            file,
            pageVisionPages: pdfVisionPages,
            selectedOriginalPageNumbers,
            uploadedPageNumberMapping,
            originalTotalPages: parsedPdf.pages.length,
            forceVisionPageFill: true,
            selectedPageRangeLabel:
              rowSelectionState.selectedPageRangeLabel || '',
          };
        }),
      );
      const renderAllDurationMs = Date.now() - renderAllStartedAt;
      console.info(
        `[Batch Generate] PDF 转 PNG 全部文件总耗时：${formatDurationMs(
          renderAllDurationMs,
        )}`,
        {
          fileCount: preparedFiles.length,
          fileNames: preparedFiles.map((item) => item.file.name),
          durationMs: renderAllDurationMs,
        },
      );

      const uploadAllStartedAt = Date.now();
      const result = await createGenerationTaskMutation.mutateAsync({
        templateId: innerProps.templateId,
        templateName: innerProps.templateName,
        files: preparedFiles,
        onStageChange: logSubmissionStage,
      });
      const uploadAndCreateDurationMs = Date.now() - uploadAllStartedAt;
      console.info(
        `[Batch Generate] 上传 PDF 页面图片并创建任务总耗时：${formatDurationMs(
          uploadAndCreateDurationMs,
        )}`,
        {
          fileCount: preparedFiles.length,
          itemCount: result.items.length,
          durationMs: uploadAndCreateDurationMs,
        },
      );

      setTaskId(result.task.id);
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['generation-template-tasks'],
        }),
        queryClient.invalidateQueries({ queryKey: ['saved-templates'] }),
      ]);
      notifications.show({
        color: 'teal',
        title: '页面准备已开始',
        message: `已创建 1 个任务，包含 ${result.items.length} 个 PDF 子任务。页面准备完成后会继续进入回填确认流程。`,
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: '创建任务失败',
        message:
          error instanceof Error
            ? error.message
            : '页面准备任务创建失败，请稍后重试。',
      });
    } finally {
      setIsPreparingFiles(false);
      setSubmissionStartedAt(null);
    }
  };

  const modalDescription = useMemo(() => {
    if (!taskId) {
      return '每条记录上传一个 PDF。点击后会先解析、上传并准备页面。';
    }

    if (taskQuery.isLoading) {
      return '任务已创建，正在同步最新状态。';
    }

    return '任务已经开始执行。页面准备完成后会进入回填确认；核查完毕后会显示下载结果按钮。';
  }, [taskId, taskQuery.isLoading]);

  return (
    <Box
      style={{
        position: 'relative',
        borderRadius: 24,
        overflow: 'hidden',
        isolation: 'isolate',
        padding: 24,
      }}
    >
      <Modal
        centered
        opened={Boolean(duplicatePdfFileNameAlert)}
        title="PDF 文件名重复"
        zIndex={1000}
        onClose={() => setDuplicatePdfFileNameAlert(null)}
      >
        {duplicatePdfFileNameAlert ? (
          <Stack gap="sm">
            <Text size="sm">
              当前选择的文件名“{duplicatePdfFileNameAlert.fileName}
              ”已经上传过，请选择其他 PDF，或先删除/替换已有记录。
            </Text>
            {duplicatePdfFileNameAlert.duplicateRows.length > 0 ? (
              <Text c="dimmed" size="xs">
                重复位置：
                {duplicatePdfFileNameAlert.duplicateRows
                  .map((row) => `第 ${row.rowNumber} 条`)
                  .join('、')}
              </Text>
            ) : null}
            <Button
              fullWidth
              radius="xl"
              onClick={() => setDuplicatePdfFileNameAlert(null)}
            >
              知道了
            </Button>
          </Stack>
        ) : null}
      </Modal>

      {isSubmittingTask ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: 'rgba(18, 18, 18, 0.78)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        >
          <Paper
            p="xl"
            radius="xl"
            withBorder
            style={{
              width: 'min(420px, 100%)',
              boxShadow: '0 18px 60px rgba(0, 0, 0, 0.32)',
              background: 'rgba(38, 38, 38, 0.92)',
            }}
          >
            <Stack align="center" gap="sm">
              <Loader color="teal" />
              <Title order={4}>正在上传文件</Title>
              <Text c="dimmed" size="sm" ta="center">
                系统正在上传并解析 PDF，随后会创建页面准备任务。
                这个过程可能需要一点时间，请稍候。已处理{' '}
                {submissionElapsedSeconds} 秒。
              </Text>
            </Stack>
          </Paper>
        </div>
      ) : null}

      <Stack gap="lg">
        <Stack gap="xs">
          <Title order={3}>页面准备任务</Title>
          <Text c="dimmed" size="sm">
            当前模板：{innerProps.templateName}。{modalDescription}
          </Text>
        </Stack>

        {!taskId ? (
          <>
            <Stack gap="md">
              {rows.map((row, index) => (
                <Paper key={row.id} p="md" radius="xl" withBorder>
                  <Stack gap="sm">
                    <Group justify="space-between" align="center">
                      <Text fw={700}>#{index + 1}</Text>
                      {rows.length > 1 ? (
                        <Button
                          color="red"
                          radius="xl"
                          size="compact-sm"
                          variant="subtle"
                          onClick={() => {
                            setRows((currentRows) =>
                              currentRows.filter(
                                (currentRow) => currentRow.id !== row.id,
                              ),
                            );
                          }}
                        >
                          删除
                        </Button>
                      ) : null}
                    </Group>

                    <input
                      accept="application/pdf,.pdf"
                      id={`generation-pdf-${row.id}`}
                      style={{ display: 'none' }}
                      type="file"
                      onChange={(event) => {
                        void handleSelectPdfFile(
                          row.id,
                          event.currentTarget.files?.[0] ?? null,
                        );
                        event.currentTarget.value = '';
                      }}
                    />

                    <Group justify="space-between" align="center">
                      <Text c={row.file ? undefined : 'dimmed'} size="sm">
                        {row.file ? row.file.name : '还未上传 PDF'}
                      </Text>
                      <Button
                        component="label"
                        htmlFor={`generation-pdf-${row.id}`}
                        radius="xl"
                        variant={row.file ? 'default' : 'light'}
                      >
                        {row.file ? '重新选择 PDF' : '上传 PDF'}
                      </Button>
                    </Group>
                    {row.file && row.parsedPdf ? (
                      <Paper
                        p="sm"
                        radius="lg"
                        style={{
                          background: 'rgba(255,255,255,0.03)',
                          border: '1px solid rgba(255,255,255,0.06)',
                        }}
                      >
                        <Stack gap="sm">
                          {(() => {
                            const selectionState = rowSelectionStates.find(
                              (state) => state.rowId === row.id,
                            );

                            if (!selectionState) {
                              return null;
                            }

                            return (
                              <Group gap="xs">
                                <Badge color="teal" radius="xl" variant="light">
                                  全部页面
                                </Badge>
                                <Text c="dimmed" size="xs">
                                  将上传{' '}
                                  {selectionState.selectedPageNumbers.length}{' '}
                                  页，对应原 PDF 第{' '}
                                  {selectionState.selectedPageRangeLabel}{' '}
                                  页，先参与页面准备，再进入槽位回填。
                                </Text>
                              </Group>
                            );
                          })()}
                        </Stack>
                      </Paper>
                    ) : null}
                  </Stack>
                </Paper>
              ))}
            </Stack>

            <Group justify="space-between">
              <Stack gap={4}>
                <Button
                  disabled={!canAddUploadRow}
                  radius="xl"
                  variant="subtle"
                  onClick={() => {
                    setRows((currentRows) =>
                      currentRows.length >= maxPdfFillTaskCount
                        ? currentRows
                        : [...currentRows, createUploadRow()],
                    );
                  }}
                >
                  添加记录
                </Button>
                <Text c="dimmed" size="xs">
                  最多添加 {maxPdfFillTaskCount} 个回填任务，当前 {rows.length}/
                  {maxPdfFillTaskCount}。
                </Text>
              </Stack>
              <Group>
                <Button
                  color="gray"
                  radius="xl"
                  variant="subtle"
                  onClick={closeModalWithRefresh}
                >
                  取消
                </Button>
                <Button
                  disabled={!canSubmit}
                  loading={
                    createGenerationTaskMutation.isPending || isPreparingFiles
                  }
                  radius="xl"
                  onClick={handleCreateTask}
                >
                  {isPreparingFiles ? '正在准备页面' : '开始页面准备'}
                </Button>
              </Group>
            </Group>
          </>
        ) : (
          <>
            <Paper p="md" radius="xl" withBorder>
              <Stack gap="sm">
                <Group justify="space-between" align="center">
                  <Group gap="sm">
                    <Badge color="teal" radius="sm" variant="light">
                      {taskQuery.data?.task.status === 'completed'
                        ? '已完成'
                        : taskQuery.data?.task.status === 'failed'
                          ? '有失败项'
                          : '执行中'}
                    </Badge>
                    <Text size="sm">
                      已完成 {succeededCount} / {taskItems.length}
                    </Text>
                    {failedCount > 0 ? (
                      <Text c="red" size="sm">
                        失败 {failedCount} 项
                      </Text>
                    ) : null}
                  </Group>
                  <Text c="dimmed" size="sm">
                    任务 ID：{taskId.slice(0, 8)}
                  </Text>
                </Group>
                <Progress radius="xl" value={progressValue} />
              </Stack>
            </Paper>

            <Stack gap="md">
              {taskItems.map((item, index) => {
                const clientStartedAt = itemStartedAtById[item.id] ?? null;
                const elapsedSeconds = formatElapsedSeconds(
                  item,
                  tick,
                  clientStartedAt,
                );
                const isReviewed = false;
                const pageFilterPages = item.pdf_page_filter_pages ?? [];
                const confirmedPageNumbers =
                  confirmedPageNumbersByItemId[item.id] ??
                  pageFilterPages
                    .filter((page) => page.selectedForSlotFill !== false)
                    .map((page) => page.uploadedPageNumber);
                const confirmedPageNumberSet = new Set(confirmedPageNumbers);
                const retainedPageFilterPages = pageFilterPages.filter((page) =>
                  confirmedPageNumberSet.has(page.uploadedPageNumber),
                );
                const filteredPageFilterPages = pageFilterPages.filter(
                  (page) =>
                    !confirmedPageNumberSet.has(page.uploadedPageNumber),
                );
                return (
                  <Paper key={item.id} p="md" radius="xl" withBorder>
                    <Stack gap="sm">
                      <Group justify="space-between" align="flex-start">
                        <div>
                          <Text fw={700}>#{index + 1}</Text>
                          <Text size="sm">{item.source_pdf_name}</Text>
                        </div>
                        <Group gap="sm" align="center">
                          <Badge
                            color={getStatusColor(item.status)}
                            radius="sm"
                            variant="light"
                          >
                            {getStatusLabel(item.status)}
                          </Badge>
                          <Text size="sm">处理中 {elapsedSeconds} 秒</Text>
                        </Group>
                      </Group>

                      {item.error_message ? (
                        <Text c="red" size="sm">
                          {item.error_message}
                        </Text>
                      ) : null}

                      {[
                        'uploaded',
                        'running',
                        'pending',
                        'page_preparing',
                        'ocr_running',
                        'pdf_pages_ready',
                        'slot_filling',
                      ].includes(item.status) && item.slot_total_count > 0 ? (
                        <Text c="dimmed" size="sm">
                          已完成 {item.slot_completed_count} 个槽位，待抽取{' '}
                          {getPendingSlotCount(item)} 个槽位
                        </Text>
                      ) : null}

                      {item.status === 'pdf_pages_ready' ? (
                        <>
                          <Divider />
                          <Box
                            style={{
                              background: 'rgba(255,255,255,0.03)',
                              border: '1px solid rgba(255,255,255,0.08)',
                              borderRadius: 8,
                              padding: 14,
                            }}
                          >
                            <Stack gap="md">
                              <Group justify="space-between" align="flex-start">
                                <div>
                                  <Text fw={700} size="sm">
                                    确认用于回填的页面
                                  </Text>
                                  <Text c="dimmed" size="xs">
                                    系统已过滤掉疑似无关页面。请确认保留页，误删的页面可以恢复。
                                  </Text>
                                </div>
                                <Button
                                  disabled={
                                    confirmedPageNumbers.length === 0 ||
                                    startGenerationTaskItemSlotFillMutation.isPending
                                  }
                                  loading={
                                    startGenerationTaskItemSlotFillMutation.isPending
                                  }
                                  radius="xl"
                                  size="xs"
                                  onClick={() => {
                                    launchSlotFillForItem(
                                      item,
                                      'manual',
                                      confirmedPageNumbers,
                                    );
                                  }}
                                >
                                  确认并开始回填
                                </Button>
                              </Group>

                              <SimpleGrid
                                cols={{ base: 2, sm: 4 }}
                                spacing="xs"
                              >
                                {[
                                  {
                                    label: '已保留',
                                    value: `${retainedPageFilterPages.length} 页`,
                                  },
                                  {
                                    label: '已过滤',
                                    value: `${filteredPageFilterPages.length} 页`,
                                  },
                                  {
                                    label: '共',
                                    value: `${pageFilterPages.length} 页`,
                                  },
                                  {
                                    label: '待回填',
                                    value: `${getPendingSlotCount(item)} 个槽位`,
                                  },
                                ].map((metric) => (
                                  <Box
                                    key={metric.label}
                                    style={{
                                      border:
                                        '1px solid rgba(255,255,255,0.07)',
                                      borderRadius: 8,
                                      padding: '8px 10px',
                                    }}
                                  >
                                    <Text c="dimmed" size="xs">
                                      {metric.label}
                                    </Text>
                                    <Text fw={700} size="sm">
                                      {metric.value}
                                    </Text>
                                  </Box>
                                ))}
                              </SimpleGrid>

                              {pageFilterPages.length > 0 ? (
                                <>
                                  <Stack gap="xs">
                                    <Group
                                      justify="space-between"
                                      align="center"
                                      gap="sm"
                                    >
                                      <Text fw={700} size="sm">
                                        保留页面
                                      </Text>
                                      <Text c="dimmed" size="xs">
                                        当前将使用{' '}
                                        {retainedPageFilterPages.length}{' '}
                                        页进行视觉回填
                                      </Text>
                                    </Group>
                                    {retainedPageFilterPages.length > 0 ? (
                                      <SimpleGrid
                                        cols={{ base: 2, xs: 3, sm: 4, md: 6 }}
                                        spacing="xs"
                                      >
                                        {retainedPageFilterPages.map((page) => (
                                          <PageFilterPageTile
                                            key={`${item.id}-retained-${page.uploadedPageNumber}`}
                                            page={page}
                                            retained
                                            onAction={() =>
                                              removePageFromSlotFill(
                                                item.id,
                                                confirmedPageNumbers,
                                                page.uploadedPageNumber,
                                              )
                                            }
                                          />
                                        ))}
                                      </SimpleGrid>
                                    ) : (
                                      <Text c="red" size="xs">
                                        当前没有保留页面，请从已过滤页面中恢复至少一页。
                                      </Text>
                                    )}
                                  </Stack>

                                  <Stack gap="xs">
                                    <Group gap="xs">
                                      <Text fw={700} size="sm">
                                        已过滤页面
                                      </Text>
                                      <Badge
                                        color="red"
                                        radius="sm"
                                        size="sm"
                                        variant="light"
                                      >
                                        {filteredPageFilterPages.length}
                                      </Badge>
                                    </Group>

                                    {filteredPageFilterPages.length === 0 ? (
                                      <Text c="dimmed" size="xs">
                                        没有被过滤的页面。
                                      </Text>
                                    ) : (
                                      <SimpleGrid
                                        cols={{ base: 2, xs: 3, sm: 4, md: 6 }}
                                        spacing="xs"
                                      >
                                        {filteredPageFilterPages.map((page) => (
                                          <PageFilterPageTile
                                            key={`${item.id}-filtered-${page.uploadedPageNumber}`}
                                            page={page}
                                            retained={false}
                                            onAction={() =>
                                              restorePageForSlotFill(
                                                item.id,
                                                confirmedPageNumbers,
                                                page.uploadedPageNumber,
                                              )
                                            }
                                          />
                                        ))}
                                      </SimpleGrid>
                                    )}
                                  </Stack>
                                </>
                              ) : (
                                <Text c="dimmed" size="xs">
                                  暂无页面过滤结果。可以刷新状态后重试。
                                </Text>
                              )}
                            </Stack>
                          </Box>
                        </>
                      ) : null}

                      {item.status === 'review_pending' ? (
                        <>
                          <Divider />
                          <Group justify="space-between" align="center">
                            <Text c="dimmed" size="sm">
                              {isReviewed
                                ? '这个文件已经核查完毕，可以继续查看核查页或直接下载结果。'
                                : '槽位结果已返回。请打开新的核查页确认后，再允许下载结果。'}
                            </Text>
                            <Group>
                              <Button
                                radius="xl"
                                variant={isReviewed ? 'default' : 'light'}
                                onClick={() => {
                                  window.open(
                                    `/documents/generation-review/${item.id}`,
                                    '_blank',
                                    'noopener,noreferrer',
                                  );
                                }}
                              >
                                {isReviewed ? '查看核查结果' : '去核查'}
                              </Button>
                              {isReviewed ? (
                                <Button
                                  radius="xl"
                                  variant="default"
                                  onClick={() => {
                                    requestReviewedDocxDownload({
                                      taskItemId: item.id,
                                      defaultFileName: `${innerProps.templateName}-${item.source_pdf_name.replace(/\.pdf$/i, '')}-核查结果.docx`,
                                    });
                                  }}
                                >
                                  下载结果
                                </Button>
                              ) : null}
                            </Group>
                          </Group>
                        </>
                      ) : null}
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>

            <Group justify="space-between">
              <Button
                radius="xl"
                variant="subtle"
                onClick={() => {
                  void refreshTaskLists();
                }}
              >
                刷新状态
              </Button>
              <Button
                disabled={!canCloseTaskModal}
                radius="xl"
                onClick={closeModalWithRefresh}
              >
                关闭
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Box>
  );
}
