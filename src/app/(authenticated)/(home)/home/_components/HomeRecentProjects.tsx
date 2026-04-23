'use client';

import {
  Badge,
  Button,
  Card,
  Group,
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
import { useState } from 'react';
import type { GenerationTemplateTaskListResponse } from '@/src/app/api/types/generation-task';
import { requestReviewedDocxDownload } from '@/src/lib/generation/download-reviewed-docx';
import { openBatchGenerateModal } from '@/src/modals/batch-generate';
import { SLOT_REVIEW_SESSION_KEY } from '@/src/lib/templates/slot-review-session';
import { useTemplateGenerationTasks } from '@/src/querys/use-generation-task-runtime';
import { useDeleteGenerationTaskItem } from '@/src/querys/use-generation-tasks';
import {
  useDeleteTemplate,
  useLoadTemplateForReview,
  useUserTemplates,
} from '@/src/querys/use-template-library';
import { useRegistrationGateStore } from '@/src/stores/registration-gate-store';

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
      return 'orange';
    case 'uploaded':
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
      return '识别中';
    case 'uploaded':
      return '已上传';
    default:
      return status;
  }
}

export function HomeRecentProjects() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [hiddenTaskItemIds, setHiddenTaskItemIds] = useState<Set<string>>(() => new Set());
  const { isAuthenticated, isLoading: isAuthLoading } = useRegistrationGateStore();
  const templatesQuery = useUserTemplates(isAuthenticated);
  const templateTasksQuery = useTemplateGenerationTasks(isAuthenticated);
  const loadTemplateMutation = useLoadTemplateForReview();
  const deleteGenerationTaskItemMutation = useDeleteGenerationTaskItem();
  const deleteTemplateMutation = useDeleteTemplate();

  if (!isAuthLoading && !isAuthenticated) {
    return (
      <Card padding="xl" radius="xl" withBorder>
        <Stack gap="sm">
          <Title order={3}>已保存模板</Title>
          <Text c="dimmed">请先登录后再继续。</Text>
        </Stack>
      </Card>
    );
  }

  if (isAuthLoading || templatesQuery.isLoading) {
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
              void queryClient.invalidateQueries({ queryKey: ['saved-templates'] });
            }}
          >
            重新加载
          </Button>
        </Stack>
      </Card>
    );
  }

  const templates = templatesQuery.data ?? [];
  const templateTaskEntries = (templateTasksQuery.data ?? []).filter(
    (entry) => !hiddenTaskItemIds.has(entry.item_id),
  );

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
              loadTemplateMutation.isPending && loadTemplateMutation.variables === template.id;
            const relatedTasks = templateTaskEntries
              .filter((entry) => entry.template_id === template.id)
              .slice(0, 5);

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
                          const detail = await loadTemplateMutation.mutateAsync(template.id);

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
                          queryClient.invalidateQueries({ queryKey: ['saved-templates'] }),
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
                      <Text fw={700}>最近任务</Text>
                      <Badge color="gray" radius="sm" variant="light">
                        {relatedTasks.length}
                      </Badge>
                    </Group>

                    {templateTasksQuery.isLoading ? (
                      <Skeleton height={140} radius="lg" />
                    ) : relatedTasks.length === 0 ? (
                      <Text c="dimmed" size="sm">
                        这个模板还没有创建过批量任务。
                      </Text>
                    ) : (
                      <ScrollArea h={210} offsetScrollbars>
                        <Stack gap="sm" pr="xs">
                          {relatedTasks.map((taskEntry) => {
                            const displayStatus = resolveDisplayStatus(
                              taskEntry.task_status,
                              taskEntry.status,
                              taskEntry.error_message,
                            );

                            return (
                              <Card key={taskEntry.item_id} padding="sm" radius="lg" withBorder>
                                <Stack gap="xs">
                                  <Group justify="space-between" align="flex-start">
                                    <div>
                                      <Text fw={600} lineClamp={1} size="sm">
                                        {taskEntry.source_pdf_name}
                                      </Text>
                                      <Text c="dimmed" size="xs">
                                        {formatTemplateDate(taskEntry.created_at)}
                                      </Text>
                                    </div>
                                    <Badge
                                      color={getTaskStatusColor(displayStatus)}
                                      radius="sm"
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
                                    <Group grow>
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
                                      {displayStatus === 'reviewed' ? (
                                        <Button
                                          radius="xl"
                                          size="xs"
                                          variant="default"
                                          onClick={() => {
                                            requestReviewedDocxDownload({
                                              taskItemId: taskEntry.item_id,
                                              defaultFileName: `${template.template_name}-${taskEntry.source_pdf_name.replace(/\.pdf$/i, '')}-核查结果.docx`,
                                            });
                                          }}
                                        >
                                          下载结果
                                        </Button>
                                      ) : null}
                                    </Group>
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
                                        const deleted = await deleteGenerationTaskItemMutation.mutateAsync(
                                          taskEntry.item_id,
                                        );

                                        setHiddenTaskItemIds((current) => {
                                          const next = new Set(current);
                                          next.add(taskEntry.item_id);
                                          return next;
                                        });

                                        queryClient.setQueryData<GenerationTemplateTaskListResponse | undefined>(
                                          ['generation-template-tasks'],
                                          (current) =>
                                            current?.filter((entry) => entry.item_id !== taskEntry.item_id) ??
                                            [],
                                        );

                                        queryClient.removeQueries({
                                          queryKey: ['generation-task-item', taskEntry.item_id],
                                        });

                                        await Promise.all([
                                          queryClient.invalidateQueries({ queryKey: ['generation-template-tasks'] }),
                                          queryClient.invalidateQueries({ queryKey: ['saved-templates'] }),
                                          deleted.task_id
                                            ? queryClient.invalidateQueries({
                                                queryKey: ['generation-task', deleted.task_id],
                                              })
                                            : Promise.resolve(),
                                          templatesQuery.refetch(),
                                          templateTasksQuery.refetch(),
                                        ]);

                                        router.refresh();

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
                              </Card>
                            );
                          })}
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
