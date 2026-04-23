import { z } from 'zod';

export const savedTemplateSummarySchema = z.object({
  id: z.string(),
  template_name: z.string(),
  upload_docx_name: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const savedTemplateDetailSchema = savedTemplateSummarySchema.extend({
  prompt: z.string().nullable().optional(),
  slot_review_payload: z.any(),
  slot_preview: z.any(),
});

export const saveTemplateRequestSchema = z.object({
  templateId: z.string().trim().optional(),
  templateName: z.string().trim().min(1, '请输入模板名称'),
  slotReviewPayload: z.any(),
  slotPreview: z.any(),
});

export type SavedTemplateSummary = z.infer<typeof savedTemplateSummarySchema>;
export type SavedTemplateDetail = z.infer<typeof savedTemplateDetailSchema>;
export type SaveTemplateRequest = z.infer<typeof saveTemplateRequestSchema>;
