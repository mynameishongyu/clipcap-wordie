'use client';

import {
  Badge,
  Button,
  Card,
  Group,
  Paper,
  ScrollArea,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type {
  GenerationTemplateTaskEntry,
  GenerationTemplateTaskListResponse,
} from '@/src/app/api/types/generation-task';
import { requestGenerationTaskBatchDocxDownload } from '@/src/lib/generation/download-reviewed-docx';
import { SLOT_REVIEW_SESSION_KEY } from '@/src/lib/templates/slot-review-session';
import { openBatchGenerateModal } from '@/src/modals/batch-generate';
import { useTemplateGenerationTasks } from '@/src/querys/use-generation-task-runtime';
import { useDeleteGenerationTaskItem } from '@/src/querys/use-generation-tasks';
import {
  useDeleteTemplate,
  useLoadTemplateForReview,
  useUserTemplates,
} from '@/src/querys/use-template-library';
import { useRegistrationGateStore } from '@/src/stores/registration-gate-store';

type TemplateTaskBatch = {
  taskId: string;
  taskStatus: string;
  taskCreatedAt: string;
  items: GenerationTemplateTaskEntry[];
};

function formatTemplateDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function resolveDisplayStatus(
  taskStatus: string | null | undefined,
  itemStatus: string,
  errorMessage: string | null | undefined,
) {
  if (errorMessage?.trim()) {
    return 'failed';
  }

  if (taskStatus === 'failed' || itemStatus === 'failed') {
    return 'failed';
  }

  return itemStatus;
}

function getTaskStatusColor(status: string) {
  switch (status) {
    case 'reviewed':
      return 'green';
    case 'review_pending':
      return 'teal';
    case 'failed':
      return 'red';
    case 'running':
    case 'page_preparing':
    case 'ocr_running':
    case 'slot_filling':
      return 'orange';
    case 'uploaded':
    case 'pdf_pages_ready':
      return 'blue';
    default:
      return 'gray';
  }
}

function getTaskStatusLabel(status: string) {
  switch (status) {
    case 'reviewed':
      return '核查完毕';
    case 'review_pending':
      return '待核查';
    case 'failed':
      return '处理失败';
    case 'running':
    case 'page_preparing':
    case 'ocr_running':
    case 'pdf_pages_ready':
    case 'slot_filling':
    case 'uploaded':
      return '处理中';
    default:
      return status;
  }
}

function getBatchStatusColor(status: string) {
  switch (status) {
    case 'completed':
      return 'teal';
    case 'failed':
      return 'red';
    case 'pending':
    case 'running':
      return 'orange';
    default:
      return 'gray';
  }
}

function getBatchStatusLabel(status: string) {
  switch (status) {
    case 'completed':
      return '已完成';
    case 'failed':
      return '有失败项';
    case 'pending':
    case 'running':
      return '执行中';
    default:
      return status;
  }
}

function groupTaskEntriesByBatch(entries: GenerationTemplateTaskEntry[]) {
  const batchMap = new Map<string, TemplateTaskBatch>();

  for (const entry of entries) {
    const existingBatch = batchMap.get(entry.task_id);

    if (existingBatch) {
      existingBatch.items.push(entry);
      continue;
    }

    batchMap.set(entry.task_id, {
      taskId: entry.task_id,
      taskStatus: entry.task_status,
      taskCreatedAt: entry.task_created_at,
      items: [entry],
    });
  }

  return Array.from(batchMap.values())
    .map((batch) => ({
      ...batch,
      items: batch.items.sort(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at),
      ),
    }))
    .sort(
      (left, right) =>
        Date.parse(right.taskCreatedAt) - Date.parse(left.taskCreatedAt),
    );
}

function getDownloadableTaskCount(batch: TemplateTaskBatch) {
  return batch.items.filter((taskEntry) => {
    const displayStatus = resolveDisplayStatus(
      taskEntry.task_status,
      taskEntry.status,
      taskEntry.error_message,
    );

    return ['review_pending', 'reviewed'].includes(displayStatus);
  }).length;
}

export function HomeRecentProjects() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [hiddenTaskItemIds, setHiddenTaskItemIds] = useState<Set<string>>(
    () => new Set(),
  );
  const { isAuthenticated, isLoading: isAuthLoading } =
    useRegistrationGateStore();
  const templatesQuery = useUserTemplates(isAuthenticated);
  const templateTasksQuery = useTemplateGenerationTasks(isAuthenticated);
  const loadTemplateMutation = useLoadTemplateForReview();
  const deleteGenerationTaskItemMutation = useDeleteGenerationTaskItem();
  const deleteTemplateMutation = useDeleteTemplate();

  const templateTaskEntries = useMemo(
    () =>
      (templateTasksQuery.data ?? []).filter(
        (entry) => !hiddenTaskItemIds.has(entry.item_id),
      ),
    [hiddenTaskItemIds, templateTasksQuery.data],
  );

  if (isAuthLoading || !isAuthenticated) {
    return null;
  }

  if (templatesQuery.isLoading) {
    return (
      <Stack gap="lg">
        <Group justify="space-between">
          <Title order={2}>已保存模板</Title>
          <Text c="dimmed" size="sm">
            正在加载你的模板库
          </Text>
        </Group>
        <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="lg">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} height={280} radius="xl" />
          ))}
        </SimpleGrid>
      </Stack>
    );
  }

  if (templatesQuery.isError) {
    return (
      <Card padding="xl" radius="xl" withBorder>
        <Stack gap="sm">
          <Title order={3}>已保存模板</Title>
          <Text c="dimmed">
            {templatesQuery.error instanceof Error
              ? templatesQuery.error.message
              : '模板列表加载失败，请稍后刷新重试。'}
          </Text>
          <Button
            radius="xl"
            variant="light"
            onClick={() => {
              void queryClient.invalidateQueries({
                queryKey: ['saved-templates'],
              });
            }}
          >
            重新加载
          </Button>
        </Stack>
      </Card>
    );
  }

  const templates = templatesQuery.data ?? [];

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>已保存模板</Title>
          <Text c="dimmed" mt={6} size="sm">
            这里会展示当前账号保存过的模板。你可以继续编辑模板，也可以从模板下方直接查看最近创建的批量任务。
          </Text>
        </div>
        <Badge color="teal" radius="sm" variant="outline">
          {templates.length} 个模板
        </Badge>
      </Group>

      {templates.length === 0 ? (
        <Card padding="xl" radius="xl" withBorder>
          <Stack gap="sm" align="center">
            <Title order={4}>还没有创建模板</Title>
            <Text c="dimmed" ta="center">
              先上传 DOCX、调整槽位并保存模板，之后这里会自动展示你的模板列表。
            </Text>
          </Stack>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="lg">
          {templates.map((template) => {
            const isLoadingCurrentTemplate =
              loadTemplateMutation.isPending &&
              loadTemplateMutation.variables === template.id;
            const relatedTasks = templateTaskEntries.filter(
              (entry) => entry.template_id === template.id,
            );
            const relatedTaskBatches = groupTaskEntriesByBatch(
              relatedTasks,
            ).slice(0, 5);

            return (
              <Card key={template.id} padding="lg" radius="xl" withBorder>
                <Stack gap="lg" h="100%">
                  <Stack gap="xs">
                    <Group justify="space-between" align="flex-start">
                      <Title order={4} lineClamp={2}>
                        {template.template_name}
                      </Title>
                      <Badge color="gray" radius="sm" variant="light">
                        模板
                      </Badge>
                    </Group>
                    <Text c="dimmed" lineClamp={2} size="sm">
                      DOCX 文件：{template.upload_docx_name || '未命名文档'}
                    </Text>
                    <Text c="dimmed" size="sm">
                      最近保存：{formatTemplateDate(template.updated_at)}
                    </Text>
                  </Stack>

                  <Group grow>
                    <Button
                      loading={isLoadingCurrentTemplate}
                      radius="xl"
                      variant="light"
                      onClick={async () => {
                        try {
                          const detail = await loadTemplateMutation.mutateAsync(
                            template.id,
                          );

                          window.sessionStorage.setItem(
                            SLOT_REVIEW_SESSION_KEY,
                            JSON.stringify(detail.slot_review_payload),
                          );

                          router.push('/documents/slot-review');
                        } catch (error) {
                          notifications.show({
                            color: 'red',
                            title: '模板加载失败',
                            message:
                              error instanceof Error
                                ? error.message
                                : '模板详情加载失败，请稍后重试。',
                          });
                        }
                      }}
                    >
                      编辑模板
                    </Button>
                    <Button
                      radius="xl"
                      variant="default"
                      onClick={() => {
                        openBatchGenerateModal({
                          templateId: template.id,
                          templateName: template.template_name,
                        });
                      }}
                    >
                      批量生成
                    </Button>
                  </Group>

                  <Button
                    color="red"
                    loading={
                      deleteTemplateMutation.isPending &&
                      deleteTemplateMutation.variables === template.id
                    }
                    radius="xl"
                    variant="subtle"
                    onClick={async () => {
                      const shouldDelete = window.confirm(
                        `确认删除模板“${template.template_name}”吗？此操作会同时删除模板、关联任务、任务子项以及已上传文件。`,
                      );

                      if (!shouldDelete) {
                        return;
                      }

                      try {
                        await deleteTemplateMutation.mutateAsync(template.id);

                        await Promise.all([
                          queryClient.invalidateQueries({
                            queryKey: ['saved-templates'],
                          }),
                          queryClient.invalidateQueries({
                            queryKey: ['generation-template-tasks'],
                          }),
                          templatesQuery.refetch(),
                          templateTasksQuery.refetch(),
                        ]);

                        router.refresh();

                        notifications.show({
                          color: 'teal',
                          title: '模板已删除',
                          message: '模板和关联任务、文件已一并删除。',
                        });
                      } catch (error) {
                        notifications.show({
                          color: 'red',
                          title: '删除失败',
                          message:
                            error instanceof Error
                              ? error.message
                              : '删除模板失败，请稍后重试。',
                        });
                      }
                    }}
                  >
                    删除模板
                  </Button>

                  <Stack gap="sm">
                    <Group justify="space-between" align="center">
                      <Text fw={700}>最近批次</Text>
                      <Badge color="gray" radius="sm" variant="light">
                        {relatedTaskBatches.length}
                      </Badge>
                    </Group>

                    {templateTasksQuery.isLoading ? (
                      <Skeleton height={140} radius="lg" />
                    ) : relatedTaskBatches.length === 0 ? (
                      <Text c="dimmed" size="sm">
                        这个模板还没有创建过批量任务。
                      </Text>
                    ) : (
                      <ScrollArea h={280} offsetScrollbars>
                        <Stack gap="sm" pr="xs">
                          {relatedTaskBatches.map((taskBatch) => (
                            <TemplateTaskBatchCard
                              key={taskBatch.taskId}
                              batch={taskBatch}
                              deleteGenerationTaskItemMutation={
                                deleteGenerationTaskItemMutation
                              }
                              onDeletedTaskItem={(taskEntry, deletedTaskId) => {
                                setHiddenTaskItemIds((current) => {
                                  const next = new Set(current);
                                  next.add(taskEntry.item_id);
                                  return next;
                                });

                                queryClient.setQueryData<
                                  GenerationTemplateTaskListResponse | undefined
                                >(
                                  ['generation-template-tasks'],
                                  (current) =>
                                    current?.filter(
                                      (entry) =>
                                        entry.item_id !== taskEntry.item_id,
                                    ) ?? [],
                                );

                                queryClient.removeQueries({
                                  queryKey: [
                                    'generation-task-item',
                                    taskEntry.item_id,
                                  ],
                                });

                                void Promise.all([
                                  queryClient.invalidateQueries({
                                    queryKey: ['generation-template-tasks'],
                                  }),
                                  queryClient.invalidateQueries({
                                    queryKey: ['saved-templates'],
                                  }),
                                  deletedTaskId
                                    ? queryClient.invalidateQueries({
                                        queryKey: [
                                          'generation-task',
                                          deletedTaskId,
                                        ],
                                      })
                                    : Promise.resolve(),
                                  templatesQuery.refetch(),
                                  templateTasksQuery.refetch(),
                                ]).then(() => {
                                  router.refresh();
                                });
                              }}
                              templateName={template.template_name}
                            />
                          ))}
                        </Stack>
                      </ScrollArea>
                    )}
                  </Stack>
                </Stack>
              </Card>
            );
          })}
        </SimpleGrid>
      )}
    </Stack>
  );
}

function TemplateTaskBatchCard(input: {
  batch: TemplateTaskBatch;
  deleteGenerationTaskItemMutation: ReturnType<
    typeof useDeleteGenerationTaskItem
  >;
  onDeletedTaskItem: (
    taskEntry: GenerationTemplateTaskEntry,
    deletedTaskId: string | null,
  ) => void;
  templateName: string;
}) {
  const { batch, deleteGenerationTaskItemMutation, onDeletedTaskItem } = input;
  const downloadableCount = getDownloadableTaskCount(batch);

  return (
    <Paper key={batch.taskId} p="sm" radius="lg" withBorder>
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={600} lineClamp={1} size="sm">
              批次 {batch.taskId.slice(0, 8)}
            </Text>
            <Text c="dimmed" size="xs">
              {formatTemplateDate(batch.taskCreatedAt)}
            </Text>
          </div>
          <Badge
            color={getBatchStatusColor(batch.taskStatus)}
            radius="sm"
            variant="light"
          >
            {getBatchStatusLabel(batch.taskStatus)}
          </Badge>
        </Group>

        <Group justify="space-between" align="center">
          <Text c="dimmed" size="xs">
            可下载 {downloadableCount} / {batch.items.length} 个结果
          </Text>
          <Button
            disabled={downloadableCount === 0}
            radius="xl"
            size="xs"
            variant="default"
            onClick={() => {
              requestGenerationTaskBatchDocxDownload({
                taskId: batch.taskId,
                defaultFileName: `${input.templateName}-本批成功结果.zip`,
              });
            }}
          >
            下载本批成功结果
          </Button>
        </Group>

        <Stack gap={6}>
          {batch.items.map((taskEntry) => (
            <TemplateTaskItemRow
              key={taskEntry.item_id}
              deleteGenerationTaskItemMutation={
                deleteGenerationTaskItemMutation
              }
              onDeletedTaskItem={onDeletedTaskItem}
              taskEntry={taskEntry}
            />
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
}

function TemplateTaskItemRow(input: {
  deleteGenerationTaskItemMutation: ReturnType<
    typeof useDeleteGenerationTaskItem
  >;
  onDeletedTaskItem: (
    taskEntry: GenerationTemplateTaskEntry,
    deletedTaskId: string | null,
  ) => void;
  taskEntry: GenerationTemplateTaskEntry;
}) {
  const { deleteGenerationTaskItemMutation, onDeletedTaskItem, taskEntry } =
    input;
  const displayStatus = resolveDisplayStatus(
    taskEntry.task_status,
    taskEntry.status,
    taskEntry.error_message,
  );

  return (
    <Paper p="xs" radius="md" withBorder>
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={600} lineClamp={1} size="xs">
              {taskEntry.source_pdf_name}
            </Text>
            <Text c="dimmed" size="xs">
              {formatTemplateDate(taskEntry.created_at)}
            </Text>
          </div>
          <Badge
            color={getTaskStatusColor(displayStatus)}
            radius="sm"
            size="xs"
            variant="light"
          >
            {getTaskStatusLabel(displayStatus)}
          </Badge>
        </Group>

        {taskEntry.error_message ? (
          <Text c="red" lineClamp={2} size="xs">
            {taskEntry.error_message}
          </Text>
        ) : null}

        {['review_pending', 'reviewed'].includes(displayStatus) ? (
          <Button
            radius="xl"
            size="xs"
            variant="light"
            onClick={() => {
              window.open(
                `/documents/generation-review/${taskEntry.item_id}`,
                '_blank',
                'noopener,noreferrer',
              );
            }}
          >
            {displayStatus === 'reviewed' ? '查看核查' : '进入核查'}
          </Button>
        ) : null}

        <Button
          color="red"
          loading={
            deleteGenerationTaskItemMutation.isPending &&
            deleteGenerationTaskItemMutation.variables === taskEntry.item_id
          }
          radius="xl"
          size="xs"
          variant="subtle"
          onClick={async () => {
            const shouldDelete = window.confirm(
              `确认删除任务“${taskEntry.source_pdf_name}”吗？这会删除当前这条任务和对应上传文件。`,
            );

            if (!shouldDelete) {
              return;
            }

            try {
              const deleted =
                await deleteGenerationTaskItemMutation.mutateAsync(
                  taskEntry.item_id,
                );

              onDeletedTaskItem(taskEntry, deleted.task_id);

              notifications.show({
                color: 'teal',
                title: '任务已删除',
                message: '当前这条任务和对应上传文件已删除。',
              });
            } catch (error) {
              notifications.show({
                color: 'red',
                title: '删除失败',
                message:
                  error instanceof Error
                    ? error.message
                    : '删除任务项失败，请稍后重试。',
              });
            }
          }}
        >
          删除任务
        </Button>
      </Stack>
    </Paper>
  );
}
