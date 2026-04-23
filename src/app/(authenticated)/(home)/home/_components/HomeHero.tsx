'use client';

import { Badge, Box, Button, Group, Paper, Stack, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { startTransition, useEffect, useRef, useState } from 'react';
import { isLoginGateBypassedForLocal } from '@/src/lib/auth/login-gate';
import { parseDocxInBrowser } from '@/src/lib/docx/parse-browser';
import { SLOT_REVIEW_SESSION_KEY } from '@/src/lib/templates/slot-review-session';
import { openCompleteRegistrationModal } from '@/src/modals/complete-registration';
import { openUsageGuideModal } from '@/src/modals/usage-guide';
import { useExtractTemplateSlots } from '@/src/querys/use-extract-template-slots';
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

export function HomeHero() {
  const [prompt, setPrompt] = useState('');
  const [selectedDocxName, setSelectedDocxName] = useState('');
  const [selectedDocxFile, setSelectedDocxFile] = useState<File | null>(null);
  const [authErrorMessage, setAuthErrorMessage] = useState('');
  const [processingSeconds, setProcessingSeconds] = useState(0);
  const [isSubmissionLocked, setIsSubmissionLocked] = useState(false);

  const docxInputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();
  const { isAuthenticated, registrationStatus, signOut } = useRegistrationGateStore();
  const extractTemplateSlotsMutation = useExtractTemplateSlots();

  const isLoginBypassed = isLoginGateBypassedForLocal();
  const canUseProtectedActions = isLoginBypassed || isAuthenticated;
  const isProcessingTemplate = isSubmissionLocked || extractTemplateSlotsMutation.isPending;
  const canEditPrompt = canUseProtectedActions && !isProcessingTemplate;
  const hasUploadedDocx = Boolean(selectedDocxFile);

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

    window.history.replaceState(null, '', window.location.pathname + window.location.search);

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
    if (!isProcessingTemplate) {
      return;
    }

    notifications.update({
      id: 'template-slot-extraction',
      loading: true,
      autoClose: false,
      withCloseButton: false,
      color: 'teal',
      title: '正在处理模板',
      message: `正在调用 LLM 识别槽位，请稍候。已处理 ${processingSeconds} 秒`,
    });
  }, [isProcessingTemplate, processingSeconds]);

  const requireRegistration = (sourceAction: string, onReady?: () => void) => {
    if (sourceAction.includes('DOCX')) {
      onReady?.();
      return;
    }

    if (
      canUseProtectedActions &&
      (isLoginBypassed ||
        registrationStatus === 'completed' ||
        registrationStatus === 'pending')
    ) {
      onReady?.();
      return;
    }

    openCompleteRegistrationModal({ sourceAction });
  };

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
      setProcessingSeconds(0);
      setIsSubmissionLocked(true);

      notifications.show({
        id: notificationId,
        loading: true,
        autoClose: false,
        withCloseButton: false,
        color: 'teal',
        title: '正在处理模板',
        message: '正在调用 LLM 识别槽位，请稍候。已处理 0 秒',
      });

      try {
        const [parsedDocument, uploadDocxBase64] = await Promise.all([
          parseDocxInBrowser(selectedDocxFile),
          readFileAsBase64(selectedDocxFile),
        ]);

        const result = await extractTemplateSlotsMutation.mutateAsync({
          file: selectedDocxFile,
          prompt,
        });

        window.sessionStorage.setItem(
          SLOT_REVIEW_SESSION_KEY,
          JSON.stringify({
            templateId: undefined,
            templateName: undefined,
            fileName: result.file_name,
            uploadDocxName: selectedDocxFile.name,
            uploadDocxBase64,
            prompt: result.prompt,
            uploadText: result.upload_text,
            uploadHtml: result.upload_html,
            parsedDocument,
            documentInfo: result.document_info,
            extractionResult: result.extraction_result,
          }),
        );

        notifications.update({
          id: notificationId,
          autoClose: 1800,
          color: 'teal',
          loading: false,
          title: '处理完成',
          message: '槽位识别完成，正在打开编辑页面。',
          withCloseButton: true,
        });

        startTransition(() => {
          router.push('/documents/slot-review');
        });
      } catch (error) {
        setProcessingSeconds(0);
        setIsSubmissionLocked(false);

        notifications.update({
          id: notificationId,
          autoClose: 3000,
          color: 'red',
          loading: false,
          title: '处理失败',
          message: error instanceof Error ? error.message : '槽位识别失败，请稍后重试。',
          withCloseButton: true,
        });
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
        ) : isLoginBypassed ? (
          <Button radius="xl" variant="white" disabled>
            开发模式
          </Button>
        ) : (
          <Button radius="xl" variant="white" onClick={() => openCompleteRegistrationModal()}>
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
            上传 DOCX 模板定义槽位，再从 PDF 材料中批量抽取内容并完成自动填充。
          </Text>
          <Button radius="xl" size="sm" variant="light" onClick={() => openUsageGuideModal()}>
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
                    ? '描述你的任务，例如：请从一批 PDF 中提取企业名称、金额、日期，并自动填充到对应文档模板。'
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
                  openCompleteRegistrationModal({ sourceAction: '输入任务描述' });
                }
              }}
              onFocus={() => {
                if (!canEditPrompt && !isProcessingTemplate) {
                  openCompleteRegistrationModal({ sourceAction: '输入任务描述' });
                }
              }}
            />

            <input
              hidden
              id="home-docx-upload-input"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              disabled={isProcessingTemplate}
              ref={docxInputRef}
              type="file"
              onChange={(event) => {
                setSelectedDocxName(event.currentTarget.files?.[0]?.name ?? '');
                setSelectedDocxFile(event.currentTarget.files?.[0] ?? null);
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
                </Group>

                <Text c="#7a7365" size="sm">
                  先上传 DOCX 模板定义槽位结构，后续再进入流程上传 PDF 材料。
                </Text>
                {selectedDocxName ? <Text size="sm">已选择 DOCX：{selectedDocxName}</Text> : null}
              </Stack>

              <Button
                color="teal"
                disabled={!hasUploadedDocx || isProcessingTemplate}
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
