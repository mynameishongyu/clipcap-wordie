'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  GenerationTaskDetailResponse,
  GenerationTaskItemDetailResponse,
  GenerationTaskItemSummary,
  GenerationTemplateTaskListResponse,
} from '@/src/app/api/types/generation-task';

export function useGenerationTask(taskId: string | null) {
  return useQuery({
    queryKey: ['generation-task', taskId],
    enabled: Boolean(taskId),
    refetchInterval: (query) => {
      const payload = query.state.data as GenerationTaskDetailResponse | undefined;
      const hasRunningItems = payload?.items.some((item) =>
        ['uploaded', 'running', 'pending'].includes(item.status),
      );

      return hasRunningItems ? 1000 : false;
    },
    queryFn: async () => {
      const response = await fetch(`/api/generation-tasks/${taskId}`);
      const payload = (await response.json()) as {
        message?: string;
        data?: GenerationTaskDetailResponse;
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '读取批量生成任务失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}

export function useTemplateGenerationTasks(enabled = true) {
  return useQuery({
    queryKey: ['generation-template-tasks'],
    enabled,
    queryFn: async () => {
      const response = await fetch('/api/generation-tasks');
      const payload = (await response.json()) as {
        message?: string;
        data?: GenerationTemplateTaskListResponse;
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '读取模板任务列表失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}

export function useProcessGenerationTaskItem() {
  return useMutation({
    mutationFn: async (taskItemId: string) => {
      const response = await fetch(`/api/generation-task-items/${taskItemId}/process`, {
        method: 'POST',
      });
      const payload = (await response.json()) as {
        message?: string;
        data?: {
          item: GenerationTaskItemSummary;
        };
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? 'PDF 填充处理失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}

export function useGenerationTaskItem(taskItemId: string | null) {
  return useQuery({
    queryKey: ['generation-task-item', taskItemId],
    enabled: Boolean(taskItemId),
    queryFn: async () => {
      const response = await fetch(`/api/generation-task-items/${taskItemId}`);
      const payload = (await response.json()) as {
        message?: string;
        data?: GenerationTaskItemDetailResponse;
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '读取任务详情失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}

export function useReviewGenerationTaskItem() {
  return useMutation({
    mutationFn: async (input: { taskItemId: string; reviewPayload: unknown }) => {
      const response = await fetch(`/api/generation-task-items/${input.taskItemId}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reviewPayload: input.reviewPayload,
        }),
      });

      const payload = (await response.json()) as {
        message?: string;
        data?: GenerationTaskItemDetailResponse;
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '保存核查结果失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}
