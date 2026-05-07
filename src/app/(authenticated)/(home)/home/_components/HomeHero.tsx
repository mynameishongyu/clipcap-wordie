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
import { browserProcessLog } from '@/src/lib/debug/browser-process-log';
import { parseDocxInBrowser } from '@/src/lib/docx/parse-browser';
import {
  parsePdf,
  pickVisionPageNumbers,
  renderPdfPagesForVision,
  type PdfVisionPageInput as BrowserPdfVisionPageInput,
} from '@/src/lib/pdf/client-pdf';
import { SLOT_REVIEW_SESSION_KEY } from '@/src/lib/templates/slot-review-session';
import { openCompleteRegistrationModal } from '@/src/modals/complete-registration';
import { openUsageGuideModal } from '@/src/modals/usage-guide';
import { useRegistrationGateStore } from '@/src/stores/registration-gate-store';

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
  file: File;
  prompt: string;
  pdfName?: string;
  pdfVisionPages?: BrowserPdfVisionPageInput[];
}

async function createTemplateExtractionTask(
  input: CreateTemplateExtractionTaskInput,
) {
  const formData = new FormData();
  formData.append('file', input.file);
  formData.append('prompt', input.prompt);

  if (input.pdfName && input.pdfVisionPages?.length) {
    formData.append('pdfName', input.pdfName);
    formData.append(
      'pdfVisionPages',
      JSON.stringify(
        input.pdfVisionPages.map((page) => ({
          page_number: page.pageNumber,
          image_data_url: page.imageDataUrl,
        })),
      ),
    );
  }

  const response = await fetch('/api/template-extraction-tasks', {
    method: 'POST',
    body: formData,
  });

  const payload = (await response.json()) as {
    message?: string;
    data?: TemplateExtractionTaskSummary;
  };

  if (!response.ok || !payload.data) {
    throw new Error(payload.message ?? '创建槽位抽取任务失败，请稍后重试。');
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
    const payload = (await response.json()) as { message?: string };
    throw new Error(payload.message ?? '启动槽位抽取任务失败，请稍后重试。');
  }
}

async function preparePdfVisionPages(file: File) {
  browserProcessLog.info(
    `[Template Extract][PDF Evidence] Preparing scanned PDF pages for ${file.name}.`,
  );

  const parsedPdf = await parsePdf(file);
  const pageNumbers = pickVisionPageNumbers(parsedPdf);

  browserProcessLog.info(
    `[Template Extract][PDF Evidence] Rendering ${pageNumbers.length} page(s) for OCR evidence.`,
  );

  const visionPages = await renderPdfPagesForVision(file, pageNumbers);

  browserProcessLog.info(
    `[Template Extract][PDF Evidence] Rendered ${visionPages.length} PDF page image(s) for ${file.name}.`,
  );

  return visionPages;
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
  const pdfVisionPagesPromiseRef = useRef<Promise<
    BrowserPdfVisionPageInput[]
  > | null>(null);
  const pdfVisionPagesRef = useRef<BrowserPdfVisionPageInput[]>([]);
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
  const hasUploadedPdf = Boolean(selectedPdfFile);
  const canStartSlotDetection = hasUploadedDocx && hasUploadedPdf;

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

  useEffect(() => {
    if (!isProcessingTemplate || !activeExtractionTask) {
      return;
    }

    const progressText =
      activeExtractionTask.total_paragraphs > 0
        ? `${activeExtractionTask.completed_paragraphs}/${activeExtractionTask.total_paragraphs} 段`
        : '正在准备段落';

    notifications.update({
      id: 'template-slot-extraction',
      loading: true,
      autoClose: false,
      withCloseButton: false,
      color: 'teal',
      title: '正在处理模板',
      message: `正在调用 LLM 识别槽位，请稍候。已处理 ${processingSeconds} 秒，当前进度 ${progressText}。`,
    });
  }, [activeExtractionTask, isProcessingTemplate, processingSeconds]);

  const requireRegistration = (sourceAction: string, onReady?: () => void) => {
    if (sourceAction.includes('DOCX')) {
      onReady?.();
      return;
    }

    if (
      canUseProtectedActions &&
      (registrationStatus === 'completed' || registrationStatus === 'pending')
    ) {
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
    } catch {
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
              task.pdf_evidence && pdfVisionPagesRef.current.length > 0
                ? {
                    pdfFileName: task.pdf_evidence.pdf_file_name,
                    pages: pdfVisionPagesRef.current,
                    ocrPages: task.pdf_evidence.ocr_pages,
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
      if (
        line.includes('[Template Extract][LLM][ErrorDetails]') ||
        line.includes('[RouteErrorDetails][TemplateExtraction]')
      ) {
        browserProcessLog.error(line);
        continue;
      }

      if (
        line.includes('[Template Extract][LLM] Failed') ||
        line.includes('槽位抽取失败')
      ) {
        browserProcessLog.error(line);
        continue;
      }

      browserProcessLog.log(line);
    }

    lastExtractionTraceRef.current = nextTrace;
  }, [activeExtractionTask?.processing_trace]);

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

      if (!selectedPdfFile) {
        notifications.show({
          color: 'yellow',
          title: '请先上传扫描 PDF 证据',
          message:
            '开始识别槽位前，需要同时上传 PDF 扫描件，用于把 DOCX 槽位关联到 PDF 页面。',
        });
        return;
      }

      const notificationId = 'template-slot-extraction';
      const sourcePdfFile = selectedPdfFile;
      setProcessingSeconds(0);
      setIsSubmissionLocked(true);
      hasHandledTaskCompletionRef.current = false;
      parsedDocumentPromiseRef.current = parseDocxInBrowser(selectedDocxFile);
      uploadDocxBase64PromiseRef.current = readFileAsBase64(selectedDocxFile);
      pdfVisionPagesRef.current = [];
      pdfVisionPagesPromiseRef.current = sourcePdfFile
        ? preparePdfVisionPages(sourcePdfFile).then((visionPages) => {
            pdfVisionPagesRef.current = visionPages;
            return visionPages;
          })
        : Promise.resolve([]);

      notifications.show({
        id: notificationId,
        loading: true,
        autoClose: false,
        withCloseButton: false,
        color: 'teal',
        title: '正在创建抽取任务',
        message: sourcePdfFile
          ? '模板与扫描 PDF 已上传，正在准备 OCR 证据并创建槽位抽取任务，请稍候。'
          : '模板已上传，正在创建槽位抽取任务，请稍候。',
      });

      try {
        const pdfVisionPages = await (pdfVisionPagesPromiseRef.current ??
          Promise.resolve([]));
        const task = await createTemplateExtractionTask({
          file: selectedDocxFile,
          prompt,
          pdfName: sourcePdfFile?.name,
          pdfVisionPages,
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
          <Text c="#d4cdc1" size="lg" ta="center">
            上传 DOCX 模板定义槽位，并上传扫描 PDF 作为页面定位证据。
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
                <Group gap="sm">
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
                  请同时上传 DOCX 模板和扫描 PDF，系统会先抽取 DOCX
                  槽位，再把槽位值关联到 PDF 页面。
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
