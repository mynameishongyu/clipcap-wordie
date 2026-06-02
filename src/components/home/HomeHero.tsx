'use client';

import {
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { TemplateExtractionTaskResponse } from '@/src/app/api/types/template-extraction-task';
import { logLlmUsageToBrowserConsole } from '@/src/lib/debug/browser-llm-usage-log';
import { browserProcessLog } from '@/src/lib/debug/browser-process-log';
import { parseDocxInBrowser } from '@/src/lib/docx/parse-browser';
import {
  getPdfPageNumbers,
  getPdfRenderConfig,
  renderPdfPagesForVision,
} from '@/src/lib/pdf/client-pdf';
import {
  uploadPdfVisionPagesToSupabase,
  type StoredPdfVisionPageAsset,
} from '@/src/lib/pdf/client-pdf-storage';
import { SLOT_REVIEW_SESSION_KEY } from '@/src/lib/templates/slot-review-session';
import { openCompleteRegistrationModal } from '@/src/modals/complete-registration';
import { openUsageGuideModal } from '@/src/modals/usage-guide';
import { useRegistrationGateStore } from '@/src/stores/registration-gate-store';

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
        : `Page ${index + 1}`;
    const pageNumber =
      typeof imagePlaceholder.page_number === 'number'
        ? imagePlaceholder.page_number
        : index + 1;
    const imageSize =
      typeof imagePlaceholder.image_size === 'string'
        ? `，大小 ${imagePlaceholder.image_size}`
        : '';

    return [label, `[图片：PDF 第 ${pageNumber} 页${imageSize}]`, ''];
  });

  return lines.length > 0 ? lines.join('\n').trimEnd() : null;
}

function logTemplatePdfLocateLlmTrace(line: string) {
  const promptMarker = '[Template PDF Locate][VisionPrompt]';
  const requestBodyMarker = '[Template PDF Locate][VisionRequestBody]';
  const rawMarker = '[Template PDF Locate][LLM Raw Response]';
  const parsedMarker = '[Template PDF Locate][LLM Parsed Matches]';

  if (
    !line.includes(promptMarker) &&
    !line.includes(requestBodyMarker) &&
    !line.includes(rawMarker) &&
    !line.includes(parsedMarker)
  ) {
    return false;
  }

  const jsonStartIndex = line.indexOf('{');
  const label = line.includes(promptMarker)
    ? '[Template PDF Locate][Vision Prompt]'
    : line.includes(requestBodyMarker)
      ? '[Template PDF Locate][Actual VISION_LLM Request Body]'
      : line.includes(rawMarker)
        ? '[Template PDF Locate][LLM Raw Response]'
        : '[Template PDF Locate][LLM Parsed Matches]';

  if (jsonStartIndex < 0) {
    browserProcessLog.info(line);
    return true;
  }

  try {
    const payload = JSON.parse(line.slice(jsonStartIndex)) as Record<
      string,
      unknown
    >;
    const debugWindow = window as typeof window & {
      clipcapTemplatePdfLocatePrompts?: unknown[];
      clipcapTemplatePdfLocateActualRequestBodies?: unknown[];
      clipcapTemplatePdfLocateRawResponses?: unknown[];
      clipcapTemplatePdfLocateParsedMatches?: unknown[];
    };

    if (line.includes(promptMarker)) {
      debugWindow.clipcapTemplatePdfLocatePrompts = [
        ...(debugWindow.clipcapTemplatePdfLocatePrompts ?? []),
        payload,
      ];
    } else if (line.includes(requestBodyMarker)) {
      debugWindow.clipcapTemplatePdfLocateActualRequestBodies = [
        ...(debugWindow.clipcapTemplatePdfLocateActualRequestBodies ?? []),
        payload,
      ];
      browserProcessLog.info(label, payload);
      logConsoleTextChunks(
        '[Template PDF Locate] Actual VISION_LLM request body JSON',
        JSON.stringify(payload.request_body ?? payload, null, 2),
      );
    } else if (line.includes(rawMarker)) {
      debugWindow.clipcapTemplatePdfLocateRawResponses = [
        ...(debugWindow.clipcapTemplatePdfLocateRawResponses ?? []),
        payload,
      ];
      browserProcessLog.info(label, payload);

      if (typeof payload.raw_response === 'string') {
        logConsoleTextChunks(
          '[Template PDF Locate] VISION_LLM raw response text',
          payload.raw_response,
        );
      } else if (typeof payload.raw_response_chunk === 'string') {
        const chunkIndex =
          typeof payload.chunk_index === 'number'
            ? payload.chunk_index
            : undefined;
        const totalChunks =
          typeof payload.total_chunks === 'number'
            ? payload.total_chunks
            : undefined;
        const chunkLabel =
          chunkIndex && totalChunks
            ? ` chunk ${chunkIndex}/${totalChunks}`
            : '';

        logConsoleTextChunks(
          `[Template PDF Locate] VISION_LLM raw response text${chunkLabel}`,
          payload.raw_response_chunk,
        );
      }
    } else {
      debugWindow.clipcapTemplatePdfLocateParsedMatches = [
        ...(debugWindow.clipcapTemplatePdfLocateParsedMatches ?? []),
        payload,
      ];
      browserProcessLog.info(label, payload);
    }
  } catch {
    browserProcessLog.info(line);
  }

  return true;
}

function formatTextLlmMessageContent(content: unknown) {
  if (typeof content !== 'string') {
    return JSON.stringify(content, null, 2);
  }

  const trimmedContent = content.trim();

  if (
    (trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) ||
    (trimmedContent.startsWith('[') && trimmedContent.endsWith(']'))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmedContent), null, 2);
    } catch {
      return content;
    }
  }

  return content;
}

function formatTextLlmPromptPayload(payload: Record<string, unknown>) {
  const requestBody =
    payload.request_body &&
    typeof payload.request_body === 'object' &&
    !Array.isArray(payload.request_body)
      ? (payload.request_body as { messages?: unknown })
      : null;
  const messages = Array.isArray(requestBody?.messages)
    ? requestBody.messages
    : [];
  const paragraphDisplayNumber =
    typeof payload.paragraph_display_index === 'number'
      ? payload.paragraph_display_index + 1
      : payload.paragraph_display_index;
  const header = [
    `route: ${String(payload.route ?? '/api/template-extraction-tasks/[taskId]/process')}`,
    `config_scope: ${String(payload.config_scope ?? 'TEXT_LLM')}`,
    `provider: ${String(payload.provider ?? 'unknown')}`,
    `model: ${String(payload.model ?? 'unknown')}`,
    `file_name: ${String(payload.file_name ?? 'unknown')}`,
    `paragraph: ${String(paragraphDisplayNumber ?? '?')}/${String(
      payload.total_paragraphs ?? '?',
    )}`,
  ].join('\n');
  const messageText = messages
    .map((message, index) => {
      const record =
        message && typeof message === 'object'
          ? (message as { role?: unknown; content?: unknown })
          : {};
      const role = String(record.role ?? `message_${index + 1}`);

      return [
        `--- ${role.toUpperCase()} MESSAGE ---`,
        formatTextLlmMessageContent(record.content),
      ].join('\n');
    })
    .join('\n\n');

  return [header, messageText || JSON.stringify(payload, null, 2)].join('\n\n');
}

function logTemplateExtractionLlmTrace(line: string) {
  const promptMarker = '[Template Extract][TextPrompt]';
  const requestBodyMarker = '[Template Extract][TextRequestBody]';
  const rawMarker = '[Template Extract][LLM Raw Response]';
  const parsedMarker = '[Template Extract][LLM Parsed JSON]';

  if (
    !line.includes(promptMarker) &&
    !line.includes(requestBodyMarker) &&
    !line.includes(rawMarker) &&
    !line.includes(parsedMarker)
  ) {
    return false;
  }

  const jsonStartIndex = line.indexOf('{');
  const label = line.includes(requestBodyMarker)
    ? '[Template Extract][Actual TEXT_LLM Request Body]'
    : line.includes(promptMarker)
      ? '[Template Extract][Text LLM Prompt]'
      : line.includes(rawMarker)
        ? '[Template Extract][LLM Raw Response]'
        : '[Template Extract][LLM Parsed JSON]';

  if (jsonStartIndex < 0) {
    browserProcessLog.info(line);
    return true;
  }

  try {
    const payload = JSON.parse(line.slice(jsonStartIndex));
    const debugWindow = window as typeof window & {
      clipcapTemplateTextLlmPrompts?: unknown[];
      clipcapTemplateTextLlmRequestBodies?: unknown[];
      clipcapTemplateTextLlmRawResponses?: unknown[];
      clipcapTemplateTextLlmParsedResults?: unknown[];
    };

    if (line.includes(requestBodyMarker)) {
      debugWindow.clipcapTemplateTextLlmRequestBodies = [
        ...(debugWindow.clipcapTemplateTextLlmRequestBodies ?? []),
        payload,
      ];
      browserProcessLog.info(label, payload);
      logConsoleTextChunks(
        '[Template Extract] Actual TEXT_LLM request body JSON',
        JSON.stringify(
          (payload as { request_body?: unknown }).request_body ?? payload,
          null,
          2,
        ),
      );
    } else if (line.includes(promptMarker)) {
      debugWindow.clipcapTemplateTextLlmPrompts = [
        ...(debugWindow.clipcapTemplateTextLlmPrompts ?? []),
        payload,
      ];
    } else if (line.includes(rawMarker)) {
      debugWindow.clipcapTemplateTextLlmRawResponses = [
        ...(debugWindow.clipcapTemplateTextLlmRawResponses ?? []),
        payload,
      ];
    } else {
      debugWindow.clipcapTemplateTextLlmParsedResults = [
        ...(debugWindow.clipcapTemplateTextLlmParsedResults ?? []),
        payload,
      ];
    }

    if (line.includes(promptMarker)) {
      return true;
    }

    browserProcessLog.info(label, payload);
  } catch {
    browserProcessLog.info(line);
  }

  return true;
}

function formatDurationMs(durationMs: number) {
  if (durationMs < 1000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }

  return `${(durationMs / 1000).toFixed(2)}s`;
}

function formatBytesAsMegabytes(bytes: number) {
  return `${(Math.max(0, bytes) / 1024 / 1024).toFixed(2)} MB`;
}

function formatMemoryMb(bytes: unknown) {
  const numericBytes = typeof bytes === 'number' ? bytes : Number(bytes);

  if (!Number.isFinite(numericBytes) || numericBytes < 0) {
    return 'unknown';
  }

  return `${(numericBytes / 1024 / 1024).toFixed(2)} MB`;
}

function getTemplateExtractionMemoryStageLabel(stage: string | undefined) {
  switch (stage) {
    case 'route_started':
      return '槽位抽取路由开始';
    case 'text_slot_extraction_start':
      return 'DOCX 槽位抽取开始';
    case 'text_slot_extraction_done':
      return 'DOCX 槽位抽取完成';
    case 'pdf_page_url_prepare_start':
      return 'PDF 页图外链准备开始';
    case 'pdf_page_url_prepare_done':
      return 'PDF 页图外链准备完成';
    case 'slot_pdf_page_mapping_start':
      return '槽位与 PDF 内容关联开始';
    case 'slot_pdf_page_mapping_done':
      return '槽位与 PDF 内容关联完成';
    case 'task_persist_start':
      return '槽位抽取结果保存开始';
    case 'task_persisted':
      return '槽位抽取结果保存完成';
    case 'route_failed':
      return '槽位抽取路由失败';
    default:
      return stage ?? 'unknown';
  }
}

function logTemplateExtractionVercelMemoryTrace(line: string) {
  const marker = '[Vercel Memory][Template Extract]';

  if (!line.includes(marker)) {
    return false;
  }

  const jsonStartIndex = line.indexOf('{');

  if (jsonStartIndex < 0) {
    browserProcessLog.info(line);
    return true;
  }

  try {
    const memory = JSON.parse(line.slice(jsonStartIndex)) as {
      stage?: string;
      rss_bytes?: number;
      heap_total_bytes?: number;
      heap_used_bytes?: number;
      external_bytes?: number;
      array_buffers_bytes?: number;
    } & Record<string, unknown>;
    const stageLabel = getTemplateExtractionMemoryStageLabel(memory.stage);
    const payload = {
      ...memory,
      stage_label: stageLabel,
      rss_mb: formatMemoryMb(memory.rss_bytes),
      heap_total_mb: formatMemoryMb(memory.heap_total_bytes),
      heap_used_mb: formatMemoryMb(memory.heap_used_bytes),
      external_mb: formatMemoryMb(memory.external_bytes),
      array_buffers_mb: formatMemoryMb(memory.array_buffers_bytes),
    };
    const debugWindow = window as typeof window & {
      clipcapTemplateExtractionVercelMemory?: Array<typeof payload>;
    };

    debugWindow.clipcapTemplateExtractionVercelMemory = [
      ...(debugWindow.clipcapTemplateExtractionVercelMemory ?? []),
      payload,
    ];

    browserProcessLog.info(
      `[Vercel Memory][Template Extract] ${stageLabel}: rss ${payload.rss_mb}, heap used ${payload.heap_used_mb}, external ${payload.external_mb}, array buffers ${payload.array_buffers_mb}`,
      payload,
    );
  } catch {
    browserProcessLog.info(line);
  }

  return true;
}

function getTemplateExtractionTimingStageLabel(stage: string | undefined) {
  switch (stage) {
    case 'pdf_page_render':
      return 'PDF 页面图片生成';
    case 'pdf_page_image_upload':
      return 'PDF 页面图片上传 Supabase';
    case 'text_slot_extraction':
      return 'DOCX 槽位抽取';
    case 'slot_pdf_page_mapping':
      return '槽位与 PDF 内容关联';
    default:
      return stage ?? 'unknown';
  }
}

function logTemplateExtractionTimingTrace(line: string) {
  const marker = '[Template Extract][Timing]';

  if (!line.includes(marker)) {
    return false;
  }

  const jsonStartIndex = line.indexOf('{');

  if (jsonStartIndex < 0) {
    browserProcessLog.info(line);
    return true;
  }

  try {
    const timing = JSON.parse(line.slice(jsonStartIndex)) as {
      stage?: string;
      duration_ms?: number;
      duration_text?: string;
    };
    const stageLabel = getTemplateExtractionTimingStageLabel(timing.stage);
    const timingWindow = window as typeof window & {
      clipcapTemplateExtractionTimings?: Array<
        typeof timing & { stage_label: string }
      >;
    };
    const payload = {
      ...timing,
      stage_label: stageLabel,
    };

    timingWindow.clipcapTemplateExtractionTimings = [
      ...(timingWindow.clipcapTemplateExtractionTimings ?? []),
      payload,
    ];

    const durationText =
      timing.duration_text ??
      (typeof timing.duration_ms === 'number'
        ? formatDurationMs(timing.duration_ms)
        : null);

    browserProcessLog.info(
      durationText
        ? `[Template Extract][Timing] ${stageLabel} completed in ${durationText}`
        : `[Template Extract][Timing] ${stageLabel} started`,
      payload,
    );
  } catch {
    browserProcessLog.info(line);
  }

  return true;
}

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = reader.result;

      if (typeof result !== 'string') {
        reject(new Error('DOCX 文件读取失败，请重新上传后再试。'));
        return;
      }

      const [, base64Content = ''] = result.split(',');
      resolve(base64Content);
    };

    reader.onerror = () => {
      reject(new Error('DOCX 文件读取失败，请重新上传后再试。'));
    };

    reader.readAsDataURL(file);
  });
}

interface TemplateExtractionTaskSummary extends TemplateExtractionTaskResponse {}

interface CreateTemplateExtractionTaskInput {
  extractionTaskId?: string;
  file: File;
  prompt: string;
  pdfName?: string;
  pdfVisionPageAssets?: StoredPdfVisionPageAsset[];
}

async function parseTemplateExtractionTaskResponse(response: Response) {
  const rawText = await response.text();

  if (!rawText) {
    return {
      payload: null as {
        message?: string;
        data?: TemplateExtractionTaskSummary;
      } | null,
      message: null as string | null,
    };
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    try {
      const payload = JSON.parse(rawText) as {
        message?: string;
        data?: TemplateExtractionTaskSummary;
      };

      return {
        payload,
        message: typeof payload.message === 'string' ? payload.message : null,
      };
    } catch {
      return {
        payload: null,
        message: rawText,
      };
    }
  }

  return {
    payload: null,
    message: rawText,
  };
}

async function createTemplateExtractionTask(
  input: CreateTemplateExtractionTaskInput,
) {
  const formData = new FormData();
  if (input.extractionTaskId) {
    formData.append('extractionTaskId', input.extractionTaskId);
  }
  formData.append('file', input.file);
  formData.append('prompt', input.prompt);

  if (input.pdfName && input.pdfVisionPageAssets?.length) {
    formData.append('pdfName', input.pdfName);
    formData.append(
      'pdfVisionPageAssets',
      JSON.stringify(
        input.pdfVisionPageAssets.map((page) => ({
          uploaded_page_number: page.pageNumber,
          original_page_number: page.originalPageNumber,
          storage_path: page.storagePath,
          content_type: page.contentType,
          size: page.size,
          rotation_applied: page.rotationApplied ?? 0,
        })),
      ),
    );
  }

  const response = await fetch('/api/template-extraction-tasks', {
    method: 'POST',
    body: formData,
  });

  const { payload, message } =
    await parseTemplateExtractionTaskResponse(response);

  if (!response.ok || !payload?.data) {
    throw new Error(message ?? '创建槽位抽取任务失败，请稍后重试。');
  }

  return payload.data;
}

async function fetchTemplateExtractionTask(taskId: string) {
  const response = await fetch(`/api/template-extraction-tasks/${taskId}`, {
    cache: 'no-store',
  });

  const payload = (await response.json()) as {
    message?: string;
    data?: TemplateExtractionTaskSummary;
  };

  if (!response.ok || !payload.data) {
    throw new Error(payload.message ?? '读取槽位抽取任务失败，请稍后重试。');
  }

  return payload.data;
}

async function startTemplateExtractionTask(taskId: string) {
  browserProcessLog.log(
    `[Template Extract] Starting process route via /api/template-extraction-tasks/${taskId}/process`,
  );
  const response = await fetch(
    `/api/template-extraction-tasks/${taskId}/process`,
    {
      method: 'POST',
    },
  );

  if (!response.ok) {
    const { payload, message } =
      await parseTemplateExtractionTaskResponse(response);

    browserProcessLog.error('[Template Extract][ProcessRoute] Failed', {
      taskId,
      status: response.status,
      statusText: response.statusText,
      payload,
      message,
    });

    throw new Error(message ?? '启动槽位抽取任务失败，请稍后重试。');
  }
}

async function preparePdfVisionPageAssets(
  file: File,
  extractionTaskId: string,
) {
  const pdfRenderConfig = getPdfRenderConfig();

  browserProcessLog.info(
    `[Template Extract][PDF Evidence] Preparing scanned PDF pages for ${file.name}.`,
    { pdfRenderConfig },
  );

  const pageNumbers = await getPdfPageNumbers(file);

  browserProcessLog.info(
    `[Template Extract][PDF Evidence] Rendering ${pageNumbers.length} page(s) for visual location evidence.`,
    {
      pdfFileName: file.name,
      pageNumbers,
      pdfRenderConfig,
    },
  );

  const renderStartedAt = performance.now();
  browserProcessLog.info(
    `[Template Extract][Timing] ${JSON.stringify({
      stage: 'pdf_page_render',
      pdf_file_name: file.name,
      started_at: new Date().toISOString(),
      page_count: pageNumbers.length,
      pdf_render_config: pdfRenderConfig,
    })}`,
  );

  const visionPages = await renderPdfPagesForVision(file, pageNumbers);
  const renderDurationMs = performance.now() - renderStartedAt;
  const renderedTotalBytes = visionPages.reduce(
    (sum, page) => sum + (page.imageBlob?.size ?? 0),
    0,
  );

  browserProcessLog.info(
    `[Template Extract][PDF Evidence] Rendered ${visionPages.length} PDF page image(s) for ${file.name}.`,
    {
      pages: visionPages.map((page) => ({
        pageNumber: page.pageNumber,
        blobSize: page.imageBlob?.size ?? null,
        blobType: page.imageBlob?.type ?? null,
        dataUrlLength: page.imageDataUrl?.length ?? null,
        dataUrlPrefix: page.imageDataUrl?.slice(0, 30) ?? null,
        crop: page.crop,
        rotationApplied: page.rotationApplied ?? 0,
      })),
    },
  );

  browserProcessLog.info(
    `[Template Extract][Timing] ${JSON.stringify({
      stage: 'pdf_page_render',
      pdf_file_name: file.name,
      started_at: new Date(
        Date.now() - Math.round(renderDurationMs),
      ).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Math.round(renderDurationMs),
      duration_text: formatDurationMs(renderDurationMs),
      page_count: visionPages.length,
      total_mb: formatBytesAsMegabytes(renderedTotalBytes),
      pdf_render_config: pdfRenderConfig,
    })}`,
  );

  const uploadStartedAt = performance.now();
  browserProcessLog.info(
    `[Template Extract][Timing] ${JSON.stringify({
      stage: 'pdf_page_image_upload',
      pdf_file_name: file.name,
      started_at: new Date().toISOString(),
      page_count: visionPages.length,
      total_mb: formatBytesAsMegabytes(renderedTotalBytes),
    })}`,
  );

  const uploadedAssets = await uploadPdfVisionPagesToSupabase({
    pdfFileName: file.name,
    extractionTaskId,
    visionPages,
    onLog: (message, details) => {
      browserProcessLog.info(message, details);
    },
  });
  const uploadDurationMs = performance.now() - uploadStartedAt;
  const uploadedTotalBytes = uploadedAssets.reduce(
    (sum, asset) => sum + asset.size,
    0,
  );

  browserProcessLog.info(
    `[Template Extract][Timing] ${JSON.stringify({
      stage: 'pdf_page_image_upload',
      pdf_file_name: file.name,
      started_at: new Date(
        Date.now() - Math.round(uploadDurationMs),
      ).toISOString(),
      finished_at: new Date().toISOString(),
      page_count: uploadedAssets.length,
      total_mb: formatBytesAsMegabytes(uploadedTotalBytes),
      duration_ms: Math.round(uploadDurationMs),
      duration_text: formatDurationMs(uploadDurationMs),
    })}`,
  );

  if (typeof window !== 'undefined') {
    (
      window as typeof window & {
        clipcapTemplatePdfEvidencePages?: StoredPdfVisionPageAsset[];
      }
    ).clipcapTemplatePdfEvidencePages = uploadedAssets;
  }

  browserProcessLog.info(
    `[Template Extract][PDF Evidence] Supabase Storage assets ready for ${file.name}.`,
    {
      assets: uploadedAssets.map((asset) => ({
        pageNumber: asset.pageNumber,
        originalPageNumber: asset.originalPageNumber,
        storagePath: asset.storagePath,
        previewUrl: asset.previewUrl,
        contentType: asset.contentType,
        size: asset.size,
        rotationApplied: asset.rotationApplied ?? 0,
      })),
      consolePreviewVariable: 'window.clipcapTemplatePdfEvidencePages',
      extractionTaskId,
    },
  );

  return uploadedAssets;
}

export function HomeHero() {
  const [prompt, setPrompt] = useState('');
  const [selectedDocxName, setSelectedDocxName] = useState('');
  const [selectedDocxFile, setSelectedDocxFile] = useState<File | null>(null);
  const [selectedPdfName, setSelectedPdfName] = useState('');
  const [selectedPdfFile, setSelectedPdfFile] = useState<File | null>(null);
  const [authErrorMessage, setAuthErrorMessage] = useState('');
  const [processingSeconds, setProcessingSeconds] = useState(0);
  const [isSubmissionLocked, setIsSubmissionLocked] = useState(false);
  const [activeExtractionTask, setActiveExtractionTask] =
    useState<TemplateExtractionTaskSummary | null>(null);

  const parsedDocumentPromiseRef = useRef<ReturnType<
    typeof parseDocxInBrowser
  > | null>(null);
  const uploadDocxBase64PromiseRef = useRef<Promise<string> | null>(null);
  const pdfVisionPageAssetsPromiseRef = useRef<Promise<
    StoredPdfVisionPageAsset[]
  > | null>(null);
  const pdfVisionPageAssetsRef = useRef<StoredPdfVisionPageAsset[]>([]);
  const processKickoffInFlightRef = useRef(false);
  const hasHandledTaskCompletionRef = useRef(false);
  const lastExtractionTraceRef = useRef('');

  const router = useRouter();
  const { isAuthenticated, registrationStatus, signOut } =
    useRegistrationGateStore();

  const canUseProtectedActions = isAuthenticated;
  const isProcessingTemplate =
    isSubmissionLocked ||
    (activeExtractionTask !== null &&
      (activeExtractionTask.status === 'pending' ||
        activeExtractionTask.status === 'running'));
  const canEditPrompt = canUseProtectedActions && !isProcessingTemplate;
  const hasUploadedDocx = Boolean(selectedDocxFile);
  const canStartSlotDetection = hasUploadedDocx;

  // 读取登录回调写在 URL hash 里的错误信息，例如 magic link 过期。
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const hash = window.location.hash;

    if (!hash.startsWith('#')) {
      return;
    }

    const params = new URLSearchParams(hash.slice(1));
    const errorCode = params.get('error_code');
    const errorDescription = params.get('error_description');
    const nextErrorMessage =
      errorCode === 'otp_expired'
        ? '登录链接已失效或已经被使用，请重新点击“登录”发送最新的邮箱链接。'
        : errorDescription
          ? decodeURIComponent(errorDescription.replace(/\+/g, ' '))
          : '';

    if (!nextErrorMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setAuthErrorMessage(nextErrorMessage);
    }, 0);

    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    );

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  // 模板处理中启动计时器，每秒更新一次处理耗时。
  useEffect(() => {
    if (!isProcessingTemplate) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setProcessingSeconds((currentSeconds) => currentSeconds + 1);
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isProcessingTemplate]);

  // 根据当前处理阶段和耗时，持续刷新模板抽取的 loading 通知。
  useEffect(() => {
    if (!isProcessingTemplate) {
      return;
    }

    const isCreatingExtractionTask = !activeExtractionTask;

    notifications.update({
      id: 'template-slot-extraction',
      loading: true,
      autoClose: false,
      withCloseButton: false,
      color: 'teal',
      title: isCreatingExtractionTask ? '正在创建抽取任务' : '正在处理模板',
      message: isCreatingExtractionTask
        ? selectedPdfFile
          ? `模板与扫描 PDF 已上传，正在准备视觉定位页图并创建槽位抽取任务，请稍候。已处理 ${processingSeconds} 秒。`
          : `模板已上传，正在创建槽位抽取任务，请稍候。已处理 ${processingSeconds} 秒。`
        : `正在调用 LLM/视觉模型处理槽位，请稍候。已处理 ${processingSeconds} 秒。`,
    });
  }, [
    activeExtractionTask,
    isProcessingTemplate,
    processingSeconds,
    selectedPdfFile,
  ]);

  const requireRegistration = (sourceAction: string, onReady?: () => void) => {
    if (canUseProtectedActions && registrationStatus === 'authenticated') {
      onReady?.();
      return;
    }

    openCompleteRegistrationModal({ sourceAction });
  };

  const resetExtractionTaskState = useCallback(() => {
    setActiveExtractionTask(null);
    setIsSubmissionLocked(false);
    setProcessingSeconds(0);
    processKickoffInFlightRef.current = false;
    lastExtractionTraceRef.current = '';
  }, []);

  const ensureTaskProcessing = async (taskId: string) => {
    if (processKickoffInFlightRef.current) {
      return;
    }

    processKickoffInFlightRef.current = true;

    try {
      await startTemplateExtractionTask(taskId);
    } catch (error) {
      browserProcessLog.error(
        '[Template Extract][ProcessRoute] Start failed; polling will continue.',
        {
          taskId,
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : error,
        },
      );
      // Keep polling; the next poll can retry kicking off the task if it is still pending.
    } finally {
      processKickoffInFlightRef.current = false;
    }
  };

  const handleCompletedTask = useCallback(
    async (task: TemplateExtractionTaskSummary) => {
      if (hasHandledTaskCompletionRef.current) {
        return;
      }

      hasHandledTaskCompletionRef.current = true;

      try {
        const [parsedDocument, uploadDocxBase64] = await Promise.all([
          parsedDocumentPromiseRef.current ??
            Promise.reject(
              new Error('当前会话缺少 DOCX 预览数据，请重新上传后再试。'),
            ),
          uploadDocxBase64PromiseRef.current ??
            Promise.reject(
              new Error('当前会话缺少原始 DOCX 文件，请重新上传后再试。'),
            ),
        ]);

        if (!task.result) {
          throw new Error('槽位抽取任务已完成，但缺少抽取结果。');
        }

        logLlmUsageToBrowserConsole(
          'Template Extract / DOCX Slot Extraction',
          task.docx_slot_extraction_llm_usage,
          {
            taskId: task.id,
            documentName: task.source_docx_name,
          },
        );
        logLlmUsageToBrowserConsole(
          'Template Extract / PDF Evidence Location',
          task.pdf_evidence_location_llm_usage,
          {
            taskId: task.id,
            documentName: task.source_docx_name,
            pdfName: task.source_pdf_name ?? null,
          },
        );

        window.sessionStorage.setItem(
          SLOT_REVIEW_SESSION_KEY,
          JSON.stringify({
            templateId: undefined,
            templateName: undefined,
            fileName: task.source_docx_name,
            uploadDocxName: task.source_docx_name,
            uploadDocxBase64,
            prompt: task.prompt,
            uploadText: task.upload_text ?? '',
            uploadHtml: task.upload_html ?? '',
            parsedDocument,
            documentInfo: task.result.document_info,
            extractionResult: task.result.extraction_result,
            pdfEvidence:
              task.pdf_evidence && pdfVisionPageAssetsRef.current.length > 0
                ? {
                    pdfFileName: task.pdf_evidence.pdf_file_name,
                    extractionTaskId: task.id,
                    pages: pdfVisionPageAssetsRef.current.map((asset) => ({
                      pageNumber: asset.pageNumber,
                      imageUrl: asset.localPreviewUrl ?? asset.previewUrl,
                      ...(asset.localPreviewUrl
                        ? { fallbackImageUrl: asset.previewUrl }
                        : {}),
                      storagePath: asset.storagePath,
                      crop: asset.crop,
                      rotationApplied: asset.rotationApplied ?? 0,
                    })),
                    pdfPages: task.pdf_evidence.pdf_pages,
                    matches: task.pdf_evidence.matches,
                  }
                : undefined,
          }),
        );

        notifications.update({
          id: 'template-slot-extraction',
          autoClose: 1800,
          color: 'teal',
          loading: false,
          title: '处理完成',
          message: task.error_message ?? '槽位识别完成，正在打开编辑页面。',
          withCloseButton: true,
        });

        notifications.hide('template-slot-extraction');
        resetExtractionTaskState();

        startTransition(() => {
          router.push('/documents/slot-review');
        });
      } catch (error) {
        browserProcessLog.error(error);
        notifications.update({
          id: 'template-slot-extraction',
          autoClose: 3000,
          color: 'red',
          loading: false,
          title: '处理失败',
          message:
            error instanceof Error
              ? error.message
              : '槽位识别失败，请稍后重试。',
          withCloseButton: true,
        });

        hasHandledTaskCompletionRef.current = false;
        resetExtractionTaskState();
      }
    },
    [resetExtractionTaskState, router],
  );

  // 监听任务处理日志，只把新增的 trace 行分类打印到浏览器日志。
  useEffect(() => {
    const nextTrace = activeExtractionTask?.processing_trace ?? '';
    const previousTrace = lastExtractionTraceRef.current;

    if (!nextTrace || nextTrace === previousTrace) {
      return;
    }

    const appendedTrace = nextTrace.startsWith(previousTrace)
      ? nextTrace.slice(previousTrace.length)
      : nextTrace;
    const traceLines = appendedTrace
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of traceLines) {
      if (logTemplateExtractionLlmTrace(line)) {
        continue;
      }

      if (logTemplatePdfLocateLlmTrace(line)) {
        continue;
      }

      if (logTemplateExtractionTimingTrace(line)) {
        continue;
      }

      if (logTemplateExtractionVercelMemoryTrace(line)) {
        continue;
      }

      if (
        line.includes('[Template Extract][LLM][ErrorDetails]') ||
        line.includes('[RouteErrorDetails][TemplateExtraction]')
      ) {
        browserProcessLog.error(line);
        continue;
      }

      if (
        line.includes('[Template Extract][LLM] Failed') ||
        line.includes('槽位抽取失败') ||
        (line.includes('[Template PDF Locate]') &&
          (line.includes('failed') ||
            line.includes('failure') ||
            line.includes('skipped')))
      ) {
        browserProcessLog.error(line);
        continue;
      }

      if (
        line.includes('[Template PDF Locate]') &&
        line.includes('Rejected visual match')
      ) {
        browserProcessLog.warn(line);
        continue;
      }

      if (line.includes('[Template PDF Locate]')) {
        browserProcessLog.info(line);
        continue;
      }

      browserProcessLog.log(line);
    }

    lastExtractionTraceRef.current = nextTrace;
  }, [activeExtractionTask?.processing_trace]);

  // 轮询当前抽取任务状态，并在完成或失败时更新通知和页面状态。
  useEffect(() => {
    if (!activeExtractionTask) {
      return;
    }

    if (activeExtractionTask.status === 'completed') {
      const timeoutId = window.setTimeout(() => {
        void handleCompletedTask(activeExtractionTask);
      }, 0);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    if (activeExtractionTask.status === 'failed') {
      notifications.update({
        id: 'template-slot-extraction',
        autoClose: 3000,
        color: 'red',
        loading: false,
        title: '处理失败',
        message:
          activeExtractionTask.error_message ?? '槽位识别失败，请稍后重试。',
        withCloseButton: true,
      });

      const timeoutId = window.setTimeout(() => {
        resetExtractionTaskState();
      }, 0);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    let isDisposed = false;

    const pollTask = async () => {
      try {
        if (activeExtractionTask.status === 'pending') {
          void ensureTaskProcessing(activeExtractionTask.id);
        }

        const nextTask = await fetchTemplateExtractionTask(
          activeExtractionTask.id,
        );

        if (!isDisposed) {
          setActiveExtractionTask(nextTask);
        }
      } catch {
        if (!isDisposed && activeExtractionTask.status === 'pending') {
          void ensureTaskProcessing(activeExtractionTask.id);
        }
      }
    };

    void pollTask();
    const intervalId = window.setInterval(() => {
      void pollTask();
    }, 2000);

    return () => {
      isDisposed = true;
      window.clearInterval(intervalId);
    };
  }, [
    activeExtractionTask,
    handleCompletedTask,
    resetExtractionTaskState,
    router,
  ]);

  const handleStartSlotDetection = () => {
    if (isProcessingTemplate) {
      return;
    }

    requireRegistration('开始识别槽位', async () => {
      if (!selectedDocxFile) {
        notifications.show({
          color: 'yellow',
          title: '请先上传 DOCX 模板',
          message: '开始识别槽位前，需要先上传一个 DOCX 模板来定义槽位结构。',
        });
        return;
      }

      const notificationId = 'template-slot-extraction';
      const sourcePdfFile = selectedPdfFile;
      const extractionTaskId = crypto.randomUUID();
      setProcessingSeconds(0);
      setIsSubmissionLocked(true);
      hasHandledTaskCompletionRef.current = false;
      parsedDocumentPromiseRef.current = parseDocxInBrowser(selectedDocxFile);
      uploadDocxBase64PromiseRef.current = readFileAsBase64(selectedDocxFile);
      pdfVisionPageAssetsRef.current = [];
      pdfVisionPageAssetsPromiseRef.current = sourcePdfFile
        ? preparePdfVisionPageAssets(sourcePdfFile, extractionTaskId).then(
            (assets) => {
              pdfVisionPageAssetsRef.current = assets;
              return assets;
            },
          )
        : Promise.resolve([]);

      notifications.show({
        id: notificationId,
        loading: true,
        autoClose: false,
        withCloseButton: false,
        color: 'teal',
        title: '正在创建抽取任务',
        message: sourcePdfFile
          ? '模板与扫描 PDF 已上传，正在准备视觉定位页图并创建槽位抽取任务，请稍候。'
          : '模板已上传，正在创建槽位抽取任务，请稍候。',
      });

      try {
        const pdfVisionPageAssets =
          await (pdfVisionPageAssetsPromiseRef.current ?? Promise.resolve([]));
        const task = await createTemplateExtractionTask({
          extractionTaskId,
          file: selectedDocxFile,
          prompt,
          pdfName: sourcePdfFile?.name,
          pdfVisionPageAssets,
        });
        setActiveExtractionTask(task);
        setIsSubmissionLocked(false);
        void ensureTaskProcessing(task.id);
      } catch (error) {
        browserProcessLog.error(error);
        notifications.update({
          id: notificationId,
          autoClose: 3000,
          color: 'red',
          loading: false,
          title: '处理失败',
          message:
            error instanceof Error
              ? error.message
              : '槽位识别失败，请稍后重试。',
          withCloseButton: true,
        });

        resetExtractionTaskState();
      }
    });
  };

  return (
    <Stack gap={36}>
      <Group justify="space-between" align="center">
        <Group gap={10}>
          <Box
            style={{
              width: 0,
              height: 0,
              borderTop: '6px solid transparent',
              borderBottom: '6px solid transparent',
              borderLeft: '10px solid #38d39f',
            }}
          />
          <Text fw={800}>ClipCap</Text>
          <Badge color="gray" radius="sm" variant="outline">
            BETA
          </Badge>
        </Group>

        {isAuthenticated ? (
          <Button
            disabled={isProcessingTemplate}
            radius="xl"
            variant="white"
            onClick={async () => {
              await signOut();
            }}
          >
            退出
          </Button>
        ) : (
          <Button
            radius="xl"
            variant="white"
            onClick={() => openCompleteRegistrationModal()}
          >
            登录后使用
          </Button>
        )}
      </Group>

      <Stack align="center" gap={24} pt={48}>
        <Stack align="center" gap={10}>
          <Title
            order={1}
            ta="center"
            style={{
              fontSize: 'clamp(2.2rem, 5.8vw, 4.2rem)',
              lineHeight: 1.08,
              letterSpacing: '-0.04em',
              maxWidth: '18ch',
            }}
          >
            批量从 PDF 中提取数据，自动填充你的文档模板
          </Title>
          <Text c="#d4cdc1" size="lg" ta="center" style={{ display: 'none' }}>
            上传 DOCX 模板定义槽位，并上传扫描 PDF 作为页面定位证据。
          </Text>
          <Text c="#d4cdc1" size="lg" ta="center">
            上传 DOCX 模板即可识别槽位；可选上传扫描
            PDF，用来定位槽位在页面中的证据位置。
          </Text>
          <Button
            radius="xl"
            size="sm"
            variant="light"
            onClick={() => openUsageGuideModal()}
          >
            使用说明
          </Button>
        </Stack>

        {authErrorMessage ? (
          <Paper
            maw={960}
            p="md"
            radius="xl"
            style={{
              background: 'rgba(255, 120, 120, 0.08)',
              border: '1px solid rgba(255, 120, 120, 0.28)',
            }}
          >
            <Text c="#ffb4b4" size="sm">
              {authErrorMessage}
            </Text>
          </Paper>
        ) : null}

        <Paper
          maw={980}
          p="xl"
          radius={28}
          style={{
            width: '100%',
            background: '#f7f4ed',
            color: '#191919',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 24px 80px rgba(0, 0, 0, 0.24)',
          }}
        >
          <Stack gap="lg">
            <Textarea
              autosize
              disabled={isProcessingTemplate}
              minRows={6}
              placeholder={
                isProcessingTemplate
                  ? 'LLM 正在识别模板槽位，暂时无法编辑任务描述。'
                  : canEditPrompt
                    ? '描述你的任务，例如：请从一批 PDF 中提取企业名称、汽车品牌，并自动填充到对应文档模板。'
                    : '登录后即可输入任务描述'
              }
              readOnly={!canEditPrompt}
              value={prompt}
              variant="unstyled"
              styles={{
                wrapper: {
                  paddingTop: '0.35rem',
                },
                input: {
                  color: '#1f1a14',
                  fontSize: '1.15rem',
                  lineHeight: 1.8,
                  fontWeight: 500,
                  minHeight: '11rem',
                  paddingTop: '0.9rem',
                  paddingBottom: '0.6rem',
                  boxSizing: 'border-box',
                },
              }}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              onClick={() => {
                if (!canEditPrompt && !isProcessingTemplate) {
                  openCompleteRegistrationModal({
                    sourceAction: '输入任务描述',
                  });
                }
              }}
              onFocus={() => {
                if (!canEditPrompt && !isProcessingTemplate) {
                  openCompleteRegistrationModal({
                    sourceAction: '输入任务描述',
                  });
                }
              }}
            />

            <input
              hidden
              id="home-docx-upload-input"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              disabled={isProcessingTemplate}
              type="file"
              onChange={(event) => {
                setSelectedDocxName(event.currentTarget.files?.[0]?.name ?? '');
                setSelectedDocxFile(event.currentTarget.files?.[0] ?? null);
              }}
            />
            <input
              hidden
              id="home-pdf-evidence-upload-input"
              accept=".pdf,application/pdf"
              disabled={isProcessingTemplate}
              type="file"
              onChange={(event) => {
                const nextFile = event.currentTarget.files?.[0] ?? null;
                setSelectedPdfName(nextFile?.name ?? '');
                setSelectedPdfFile(nextFile);
              }}
            />

            <Group justify="space-between" align="flex-end" wrap="wrap">
              <Stack gap={8}>
                <Group align="center" gap="sm" wrap="wrap">
                  <Button
                    component="label"
                    htmlFor="home-docx-upload-input"
                    disabled={isProcessingTemplate}
                    radius="xl"
                    variant="default"
                  >
                    上传 DOCX 模板
                  </Button>
                  <Button
                    component="label"
                    htmlFor="home-pdf-evidence-upload-input"
                    disabled={isProcessingTemplate}
                    radius="xl"
                    variant="light"
                  >
                    上传扫描 PDF 证据
                  </Button>
                </Group>

                <Text c="#7a7365" size="sm">
                  只上传 DOCX 时，系统会抽取模板槽位并生成槽位含义；同时上传扫描
                  PDF 时，会额外把槽位值关联到 PDF 页面位置。
                </Text>
                {selectedDocxName ? (
                  <Text size="sm">已选择 DOCX：{selectedDocxName}</Text>
                ) : null}
                {selectedPdfName ? (
                  <Text size="sm">已选择 PDF：{selectedPdfName}</Text>
                ) : null}
              </Stack>

              <Button
                color="teal"
                disabled={!canStartSlotDetection || isProcessingTemplate}
                loading={isProcessingTemplate}
                radius="xl"
                size="lg"
                onClick={handleStartSlotDetection}
              >
                开始识别槽位
              </Button>
            </Group>
          </Stack>
        </Paper>
      </Stack>
    </Stack>
  );
}
