'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  GenerationTaskDetailResponse,
  GenerationTaskItemDetailResponse,
  GenerationTaskItemSummary,
  GenerationTemplateTaskListResponse,
} from '@/src/app/api/types/generation-task';
import { logClientRequestError } from '@/src/lib/network/client-request-error';

async function reportClientError(input: {
  eventType: string;
  message: string;
  route: string;
  taskId?: string | null;
  taskItemId?: string | null;
  payload?: Record<string, unknown>;
}) {
  try {
    await fetch('/api/client-logs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        level: 'error',
        eventType: input.eventType,
        message: input.message,
        route: input.route,
        taskId: input.taskId ?? null,
        taskItemId: input.taskItemId ?? null,
        payload: input.payload ?? {},
      }),
    });
  } catch (error) {
    console.error('[Client Log] Failed to report frontend runtime error', {
      eventType: input.eventType,
      message: input.message,
      error,
    });
  }
}

async function parseApiPayload<T>(
  response: Response,
): Promise<{
  payload: T | null;
  message: string | null;
  rawText: string;
}> {
  const contentType = response.headers.get('content-type') ?? '';
  const rawText = await response.text();

  if (!rawText) {
    return { payload: null, message: null, rawText };
  }

  if (contentType.includes('application/json')) {
    try {
      const payload = JSON.parse(rawText) as T & { message?: string };
      return {
        payload,
        message:
          typeof payload === 'object' &&
          payload !== null &&
          'message' in payload &&
          typeof payload.message === 'string'
            ? payload.message
            : null,
        rawText,
      };
    } catch {
      return { payload: null, message: rawText, rawText };
    }
  }

  return { payload: null, message: rawText, rawText };
}

const runningItemStatuses = [
  'uploaded',
  'running',
  'pending',
  'page_preparing',
  'ocr_running',
  'pdf_pages_ready',
  'slot_filling',
];

export function useGenerationTask(taskId: string | null) {
  return useQuery({
    queryKey: ['generation-task', taskId],
    enabled: Boolean(taskId),
    refetchInterval: (query) => {
      const payload = query.state.data as GenerationTaskDetailResponse | undefined;
      const hasRunningItems = payload?.items.some((item) =>
        runningItemStatuses.includes(item.status),
      );

      return hasRunningItems ? 1000 : false;
    },
    queryFn: async () => {
      try {
        const response = await fetch(`/api/generation-tasks/${taskId}`);
        const { payload, message } = await parseApiPayload<{
          message?: string;
          data?: GenerationTaskDetailResponse;
        }>(response);

        if (!response.ok || !payload?.data) {
          throw new Error(message ?? '读取批量生成任务失败，请稍后重试。');
        }

        return payload.data;
      } catch (error) {
        logClientRequestError({
          label: '[Generation Tasks] Detail request failed',
          route: `/api/generation-tasks/${taskId}`,
          method: 'GET',
          error,
          extra: { taskId },
        });
        throw error;
      }
    },
  });
}

export function useTemplateGenerationTasks(enabled = true) {
  return useQuery({
    queryKey: ['generation-template-tasks'],
    enabled,
    queryFn: async () => {
      try {
        const response = await fetch('/api/generation-tasks');
        const { payload, message } = await parseApiPayload<{
          message?: string;
          data?: GenerationTemplateTaskListResponse;
        }>(response);

        if (!response.ok || !payload?.data) {
          throw new Error(message ?? '读取模板任务列表失败，请稍后重试。');
        }

        return payload.data;
      } catch (error) {
        logClientRequestError({
          label: '[Generation Tasks] List request failed',
          route: '/api/generation-tasks',
          method: 'GET',
          error,
        });
        throw error;
      }
    },
  });
}

export function useProcessGenerationTaskItem() {
  return useMutation({
    mutationFn: async (taskItemId: string) => {
      try {
        console.log('[Generation Task Item] Page preparation request', {
          taskItemId,
          route: `/api/generation-task-items/${taskItemId}/page-preparation`,
          method: 'POST',
        });

        const response = await fetch(
          `/api/generation-task-items/${taskItemId}/page-preparation`,
          {
            method: 'POST',
          },
        );
        const { payload, message, rawText } = await parseApiPayload<{
          message?: string;
          data?: {
            item: GenerationTaskItemSummary;
          };
        }>(response);

        if (!response.ok || !payload?.data) {
          const errorMessage = message ?? 'PDF 页面准备失败，请稍后重试。';
          console.error('[Generation Task Item] Page preparation failed', {
            status: response.status,
            statusText: response.statusText,
            taskItemId,
            message: errorMessage,
            rawResponseText: rawText,
            payload,
          });

          await reportClientError({
            eventType: 'generation_task_item_page_preparation_failed_frontend',
            message: errorMessage,
            route: '/api/generation-task-items/[taskItemId]/page-preparation',
            taskItemId,
            payload: {
              status: response.status,
              statusText: response.statusText,
              rawResponseText: rawText,
              payload,
            },
          });

          throw new Error(errorMessage);
        }

        console.log('[Generation Task Item] Page preparation response', {
          status: response.status,
          statusText: response.statusText,
          taskItemId,
          data: payload.data,
        });

        return payload.data;
      } catch (error) {
        logClientRequestError({
          label:
            '[Generation Task Item] Page preparation request failed at network layer',
          route: `/api/generation-task-items/${taskItemId}/page-preparation`,
          method: 'POST',
          error,
          extra: { taskItemId },
        });
        throw error;
      }
    },
  });
}

export function useStartGenerationTaskItemSlotFill() {
  return useMutation({
    mutationFn: async (
      input:
        | string
        | {
            taskItemId: string;
            confirmedPageNumbers?: number[];
          },
    ) => {
      const taskItemId = typeof input === 'string' ? input : input.taskItemId;
      const confirmedPageNumbers =
        typeof input === 'string' ? undefined : input.confirmedPageNumbers;
      try {
        console.log('[Generation Task Item] Slot fill request', {
          taskItemId,
          confirmedPageNumbers,
          route: `/api/generation-task-items/${taskItemId}/slot-fill`,
          method: 'POST',
        });

        const response = await fetch(`/api/generation-task-items/${taskItemId}/slot-fill`, {
          method: 'POST',
          ...(confirmedPageNumbers
            ? {
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ confirmedPageNumbers }),
              }
            : {}),
        });
        const { payload, message, rawText } = await parseApiPayload<{
          message?: string;
          data?: {
            item: GenerationTaskItemSummary;
          };
        }>(response);

        if (!response.ok || !payload?.data) {
          const errorMessage = message ?? '槽位回填启动失败，请稍后重试。';
          console.error('[Generation Task Item] Slot fill failed', {
            status: response.status,
            statusText: response.statusText,
            taskItemId,
            message: errorMessage,
            rawResponseText: rawText,
            payload,
          });

          await reportClientError({
            eventType: 'generation_task_item_slot_fill_failed_frontend',
            message: errorMessage,
            route: '/api/generation-task-items/[taskItemId]/slot-fill',
            taskItemId,
            payload: {
              status: response.status,
              statusText: response.statusText,
              rawResponseText: rawText,
              payload,
            },
          });

          throw new Error(errorMessage);
        }

        console.log('[Generation Task Item] Slot fill response', {
          status: response.status,
          statusText: response.statusText,
          taskItemId,
          data: payload.data,
        });

        return payload.data;
      } catch (error) {
        logClientRequestError({
          label: '[Generation Task Item] Slot fill request failed at network layer',
          route: `/api/generation-task-items/${taskItemId}/slot-fill`,
          method: 'POST',
          error,
          extra: { taskItemId },
        });
        throw error;
      }
    },
  });
}

export function useGenerationTaskItem(taskItemId: string | null) {
  return useQuery({
    queryKey: ['generation-task-item', taskItemId],
    enabled: Boolean(taskItemId),
    queryFn: async () => {
      try {
        const response = await fetch(`/api/generation-task-items/${taskItemId}`);
        const { payload, message } = await parseApiPayload<{
          message?: string;
          data?: GenerationTaskItemDetailResponse;
        }>(response);

        if (!response.ok || !payload?.data) {
          throw new Error(message ?? '读取任务详情失败，请稍后重试。');
        }

        return payload.data;
      } catch (error) {
        logClientRequestError({
          label: '[Generation Task Item] Detail request failed',
          route: `/api/generation-task-items/${taskItemId}`,
          method: 'GET',
          error,
          extra: { taskItemId },
        });
        throw error;
      }
    },
  });
}

export function useReviewGenerationTaskItem() {
  return useMutation({
    mutationFn: async (input: { taskItemId: string; reviewPayload: unknown }) => {
      try {
        const response = await fetch(`/api/generation-task-items/${input.taskItemId}/review`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            reviewPayload: input.reviewPayload,
          }),
        });

        const { payload, message } = await parseApiPayload<{
          message?: string;
          data?: GenerationTaskItemDetailResponse;
        }>(response);

        if (!response.ok || !payload?.data) {
          throw new Error(message ?? '保存核查结果失败，请稍后重试。');
        }

        return payload.data;
      } catch (error) {
        logClientRequestError({
          label: '[Generation Task Item] Review request failed',
          route: `/api/generation-task-items/${input.taskItemId}/review`,
          method: 'POST',
          error,
          extra: { taskItemId: input.taskItemId },
        });
        throw error;
      }
    },
  });
}
