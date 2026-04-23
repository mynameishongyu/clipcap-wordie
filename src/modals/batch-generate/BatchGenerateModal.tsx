'use client';

import {
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { ContextModalProps } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GenerationTaskItemSummary } from '@/src/app/api/types/generation-task';
import { requestReviewedDocxDownload } from '@/src/lib/generation/download-reviewed-docx';
import {
  parsePdf,
  pickVisionPageNumbers,
  renderPdfPagesForVision,
} from '@/src/lib/pdf/client-pdf';
import {
  useGenerationTask,
  useProcessGenerationTaskItem,
} from '@/src/querys/use-generation-task-runtime';
import { useCreateGenerationTask } from '@/src/querys/use-generation-tasks';

interface BatchGenerateModalInnerProps {
  templateId: string;
  templateName: string;
}

interface UploadRow {
  id: string;
  file: File | null;
}

function createUploadRow(): UploadRow {
  return {
    id: crypto.randomUUID(),
    file: null,
  };
}

function getStatusColor(status: string) {
  switch (status) {
    case 'uploaded':
      return 'blue';
    case 'running':
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
      return '已上传';
    case 'running':
      return '识别中';
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

function formatElapsedSeconds(item: GenerationTaskItemSummary, now: number, startedAt: number | null) {
  if (['uploaded', 'running', 'pending'].includes(item.status) && startedAt) {
    return Math.max(item.elapsed_seconds, Math.floor((now - startedAt) / 1000));
  }

  return item.elapsed_seconds;
}

export function BatchGenerateModal({
  context,
  id,
  innerProps,
}: ContextModalProps<BatchGenerateModalInnerProps>) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<UploadRow[]>([createUploadRow()]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [tick, setTick] = useState(Date.now());
  const [isPreparingFiles, setIsPreparingFiles] = useState(false);
  const createGenerationTaskMutation = useCreateGenerationTask();
  const processGenerationTaskItemMutation = useProcessGenerationTaskItem();
  const taskQuery = useGenerationTask(taskId);
  const launchedItemIdsRef = useRef<Set<string>>(new Set());
  const itemStartedAtRef = useRef<Map<string, number>>(new Map());
  const refreshTaskLists = async () => {
    await Promise.all([
      taskId
        ? queryClient.invalidateQueries({ queryKey: ['generation-task', taskId] })
        : Promise.resolve(),
      queryClient.invalidateQueries({ queryKey: ['generation-template-tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['saved-templates'] }),
    ]);
  };
  const closeModalWithRefresh = async () => {
    await refreshTaskLists();
    context.closeModal(id);
  };

  const selectedFiles = rows.map((row) => row.file).filter((file): file is File => Boolean(file));

  const canSubmit =
    selectedFiles.length > 0 &&
    !createGenerationTaskMutation.isPending &&
    !isPreparingFiles &&
    !taskId;
  const isSubmittingTask = !taskId && (createGenerationTaskMutation.isPending || isPreparingFiles);

  const taskItems = taskQuery.data?.items ?? [];
  const hasRunningItems = taskItems.some((item) =>
    ['uploaded', 'running', 'pending'].includes(item.status),
  );
  const succeededCount = taskItems.filter((item) =>
    ['review_pending', 'reviewed'].includes(item.status),
  ).length;
  const failedCount = taskItems.filter((item) => item.status === 'failed').length;
  const progressValue =
    taskItems.length > 0 ? ((succeededCount + failedCount) / taskItems.length) * 100 : 0;

  useEffect(() => {
    if (!hasRunningItems) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setTick(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasRunningItems]);

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

      if (launchedItemIdsRef.current.has(item.id)) {
        return;
      }

      launchedItemIdsRef.current.add(item.id);
      itemStartedAtRef.current.set(item.id, Date.now());

      void processGenerationTaskItemMutation
        .mutateAsync(item.id)
        .then(() => {
          void refreshTaskLists();
        })
        .catch((error) => {
          notifications.show({
            color: 'red',
            title: '批量生成失败',
            message:
              error instanceof Error
                ? `${item.source_pdf_name}：${error.message}`
                : `${item.source_pdf_name} 处理失败，请稍后重试。`,
          });

          void refreshTaskLists();
        });
    });
  }, [processGenerationTaskItemMutation, queryClient, taskId, taskQuery.data]);

  const updateRowFile = (rowId: string, file: File | null) => {
    setRows((currentRows) =>
      currentRows.map((row) => (row.id === rowId ? { ...row, file } : row)),
    );
  };

  const handleCreateTask = async () => {
    if (!canSubmit) {
      return;
    }

    setIsPreparingFiles(true);

    try {
      const preparedFiles = await Promise.all(
        selectedFiles.map(async (file) => {
          const parsedPdf = await parsePdf(file);
          const visionPageNumbers = parsedPdf.likelyScanned ? pickVisionPageNumbers(parsedPdf) : [];
          const visionPages =
            parsedPdf.likelyScanned && visionPageNumbers.length > 0
              ? await renderPdfPagesForVision(file, visionPageNumbers)
              : [];

          return {
            file,
            parsedPdf,
            visionPages,
          };
        }),
      );

      const result = await createGenerationTaskMutation.mutateAsync({
        templateId: innerProps.templateId,
        templateName: innerProps.templateName,
        files: preparedFiles,
      });

      setTaskId(result.task.id);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['generation-template-tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['saved-templates'] }),
      ]);
      notifications.show({
        color: 'teal',
        title: '批量生成已开始',
        message: `已创建 1 个任务，包含 ${result.items.length} 个 PDF 子任务。`,
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: '创建任务失败',
        message:
          error instanceof Error ? error.message : '批量生成任务创建失败，请稍后重试。',
      });
    } finally {
      setIsPreparingFiles(false);
    }
  };

  const modalDescription = useMemo(() => {
    if (!taskId) {
      return '每条记录上传一个 PDF。创建任务前会先在本地解析 PDF，扫描件会自动挑选需要送入视觉模型的页。';
    }

    if (taskQuery.isLoading) {
      return '任务已创建，正在同步最新状态。';
    }

    return '任务已经开始执行。识别完成后，每个文件都会出现“去核查”入口；核查完毕后会显示下载结果按钮。';
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
                系统正在上传并解析 PDF，随后会创建批量任务。
                这个过程可能需要一点时间，请稍候。
              </Text>
            </Stack>
          </Paper>
        </div>
      ) : null}

      <Stack gap="lg">
      <Stack gap="xs">
        <Title order={3}>批量生成任务</Title>
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
                            currentRows.filter((currentRow) => currentRow.id !== row.id),
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
                      updateRowFile(row.id, event.currentTarget.files?.[0] ?? null);
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
                </Stack>
              </Paper>
            ))}
          </Stack>

          <Group justify="space-between">
            <Button
              radius="xl"
              variant="subtle"
              onClick={() => {
                setRows((currentRows) => [...currentRows, createUploadRow()]);
              }}
            >
              添加记录
            </Button>
            <Group>
              <Button color="gray" radius="xl" variant="subtle" onClick={() => void closeModalWithRefresh()}>
                取消
              </Button>
              <Button
                disabled={!canSubmit}
                loading={createGenerationTaskMutation.isPending || isPreparingFiles}
                radius="xl"
                onClick={handleCreateTask}
              >
                {isPreparingFiles ? '正在解析 PDF' : '批量生成'}
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
              const clientStartedAt = itemStartedAtRef.current.get(item.id) ?? null;
              const elapsedSeconds = formatElapsedSeconds(item, tick, clientStartedAt);
              const isReviewed = false;
              return (
                <Paper key={item.id} p="md" radius="xl" withBorder>
                  <Stack gap="sm">
                    <Group justify="space-between" align="flex-start">
                      <div>
                        <Text fw={700}>#{index + 1}</Text>
                        <Text size="sm">{item.source_pdf_name}</Text>
                      </div>
                      <Group gap="sm" align="center">
                        <Badge color={getStatusColor(item.status)} radius="sm" variant="light">
                          {getStatusLabel(item.status)}
                        </Badge>
                        <Text size="sm">{elapsedSeconds} 秒</Text>
                      </Group>
                    </Group>

                    {item.error_message ? (
                      <Text c="red" size="sm">
                        {item.error_message}
                      </Text>
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
            <Button radius="xl" onClick={() => void closeModalWithRefresh()}>
              关闭
            </Button>
          </Group>
        </>
      )}
      </Stack>
    </Box>
  );
}
