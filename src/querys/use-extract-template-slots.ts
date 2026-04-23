'use client';

import { useMutation } from '@tanstack/react-query';
import type {
  ExtractionParagraph,
  TemplateSlotExtractionResult,
} from '@/src/app/api/types/template-slot-extraction';

export interface ExtractTemplateSlotsInput {
  file: File;
  prompt: string;
}

export interface ExtractTemplateSlotsResponse {
  file_name: string;
  prompt: string;
  upload_text: string;
  upload_html: string;
  document_info: TemplateSlotExtractionResult['document_info'];
  extraction_result: ExtractionParagraph[];
}

export function useExtractTemplateSlots() {
  return useMutation({
    mutationFn: async (input: ExtractTemplateSlotsInput) => {
      const formData = new FormData();
      formData.append('file', input.file);
      formData.append('prompt', input.prompt);

      const response = await fetch('/api/templates/extract-slots', {
        method: 'POST',
        body: formData,
      });

      const payload = (await response.json()) as {
        message?: string;
        data?: ExtractTemplateSlotsResponse;
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '槽位识别失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}
