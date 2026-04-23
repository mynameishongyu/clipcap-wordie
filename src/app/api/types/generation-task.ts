import { z } from 'zod';

export const generationTaskItemSummarySchema = z.object({
  id: z.string().uuid(),
  task_id: z.string().uuid(),
  source_pdf_name: z.string(),
  source_pdf_path: z.string(),
  status: z.string(),
  elapsed_seconds: z.number().int(),
  created_at: z.string(),
  reviewed_at: z.string().nullable().optional(),
  output_docx_path: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
});

export const generationTaskSummarySchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  template_id: z.string().nullable().optional(),
  template_name_snapshot: z.string(),
  status: z.string(),
  total_items: z.number().int(),
  succeeded_items: z.number().int(),
  failed_items: z.number().int(),
  created_at: z.string(),
});

export const generationReviewedItemSchema = z.object({
  slot_key: z.string(),
  field_category: z.string(),
  meaning_to_applicant: z.string(),
  original_value: z.string(),
  evidence: z.string().nullable().optional(),
  evidence_page_numbers: z.array(z.number().int()).optional().default([]),
  notes: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
});

export const createGenerationTaskResponseSchema = z.object({
  task: generationTaskSummarySchema,
  items: z.array(generationTaskItemSummarySchema),
});

export const generationTaskDetailResponseSchema = z.object({
  task: generationTaskSummarySchema,
  items: z.array(generationTaskItemSummarySchema),
});

export const generationTaskItemDetailSchema = generationTaskItemSummarySchema.extend({
  llm_input: z.any().nullable().optional(),
  llm_output: z.any().nullable().optional(),
  review_payload: z.any().nullable().optional(),
  pdf_preview_url: z.string().nullable().optional(),
  template_preview_html: z.string().nullable().optional(),
  template_preview_document: z.any().nullable().optional(),
  template_preview_slots: z.any().nullable().optional(),
  template_preview_upload_text: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
});

export const generationTaskItemDetailResponseSchema = z.object({
  item: generationTaskItemDetailSchema,
  task: generationTaskSummarySchema,
});

export const generationTemplateTaskEntrySchema = z.object({
  item_id: z.string().uuid(),
  task_id: z.string().uuid(),
  template_id: z.string().nullable().optional(),
  template_name_snapshot: z.string(),
  task_status: z.string(),
  task_created_at: z.string(),
  source_pdf_name: z.string(),
  status: z.string(),
  reviewed_at: z.string().nullable().optional(),
  created_at: z.string(),
  error_message: z.string().nullable().optional(),
});

export const generationTemplateTaskListResponseSchema = z.array(generationTemplateTaskEntrySchema);

export type GenerationTaskItemSummary = z.infer<typeof generationTaskItemSummarySchema>;
export type GenerationTaskSummary = z.infer<typeof generationTaskSummarySchema>;
export type GenerationReviewedItem = z.infer<typeof generationReviewedItemSchema>;
export type CreateGenerationTaskResponse = z.infer<typeof createGenerationTaskResponseSchema>;
export type GenerationTaskDetailResponse = z.infer<typeof generationTaskDetailResponseSchema>;
export type GenerationTaskItemDetail = z.infer<typeof generationTaskItemDetailSchema>;
export type GenerationTaskItemDetailResponse = z.infer<typeof generationTaskItemDetailResponseSchema>;
export type GenerationTemplateTaskEntry = z.infer<typeof generationTemplateTaskEntrySchema>;
export type GenerationTemplateTaskListResponse = z.infer<
  typeof generationTemplateTaskListResponseSchema
>;
