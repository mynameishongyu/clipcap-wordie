'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  SavedTemplateDetail,
  SavedTemplateSummary,
} from '@/src/app/api/types/template-library';
import type { SlotReviewSessionPayload } from '@/src/lib/templates/slot-review-session';

interface SaveTemplateInput {
  templateId?: string;
  templateName: string;
  slotReviewPayload: SlotReviewSessionPayload;
  slotPreview: unknown;
}

export function useUserTemplates(enabled = true) {
  return useQuery({
    queryKey: ['saved-templates'],
    enabled,
    queryFn: async () => {
      const response = await fetch('/api/templates');
      const payload = (await response.json()) as {
        message?: string;
        data?: SavedTemplateSummary[];
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '读取模板列表失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}

export function useSaveTemplate() {
  return useMutation({
    mutationFn: async (input: SaveTemplateInput) => {
      const response = await fetch('/api/templates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });

      const payload = (await response.json()) as {
        message?: string;
        data?: SavedTemplateSummary;
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '模板保存失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}

export function useLoadTemplateForReview() {
  return useMutation({
    mutationFn: async (templateId: string) => {
      const response = await fetch(`/api/templates/${templateId}`);
      const payload = (await response.json()) as {
        message?: string;
        data?: SavedTemplateDetail;
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '读取模板详情失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}

export function useDeleteTemplate() {
  return useMutation({
    mutationFn: async (templateId: string) => {
      const response = await fetch(`/api/templates/${templateId}`, {
        method: 'DELETE',
      });

      const payload = (await response.json()) as {
        message?: string;
        data?: { id: string };
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '删除模板失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}
