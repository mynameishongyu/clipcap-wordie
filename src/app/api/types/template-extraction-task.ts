import { z } from 'zod';
import {
  templatePdfEvidenceResultSchema,
  templateSlotExtractionResultSchema,
} from '@/src/app/api/types/template-slot-extraction';

export const templateExtractionTaskStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
]);

export const templateExtractionTaskResponseSchema = z.object({
  id: z.string().uuid(),
  status: templateExtractionTaskStatusSchema,
  source_docx_name: z.string(),
  source_pdf_name: z.string().nullable().optional(),
  prompt: z.string(),
  total_paragraphs: z.number().int().nonnegative(),
  completed_paragraphs: z.number().int().nonnegative(),
  processing_trace: z.string().default(''),
  upload_text: z.string().nullable().optional(),
  upload_html: z.string().nullable().optional(),
  result: templateSlotExtractionResultSchema.nullable().optional(),
  pdf_evidence: templatePdfEvidenceResultSchema.nullable().optional(),
  docx_slot_extraction_llm_usage: z.any().nullable().optional(),
  pdf_evidence_location_llm_usage: z.any().nullable().optional(),
  error_message: z.string().nullable().optional(),
  created_at: z.string(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
});

export type TemplateExtractionTaskStatus = z.infer<
  typeof templateExtractionTaskStatusSchema
>;
export type TemplateExtractionTaskResponse = z.infer<
  typeof templateExtractionTaskResponseSchema
>;
