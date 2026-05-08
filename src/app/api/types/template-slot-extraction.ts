import { z } from 'zod';

export const extractionItemSchema = z.object({
  sequence: z.number().int().positive(),
  paragraph_index: z.number().int().nonnegative().nullable().optional(),
  field_category: z.string(),
  original_value: z.string(),
  meaning_to_applicant: z.string(),
  original_doc_position: z.string(),
});

export const extractionParagraphSchema = z.object({
  paragraph_index: z.number().int().nonnegative().optional(),
  paragraph_title: z.string(),
  items: z.array(extractionItemSchema),
});

export const templateSlotExtractionResultSchema = z.object({
  document_info: z.object({
    document_name: z.string(),
  }),
  extraction_result: z.array(extractionParagraphSchema),
});

export const templatePdfEvidencePageSchema = z.object({
  page_number: z.number().int().positive(),
  text: z.string(),
});

export const templatePdfEvidenceBboxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

export const templatePdfEvidenceMatchSchema = z.object({
  paragraph_result_index: z.number().int().nonnegative(),
  item_index: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
  paragraph_index: z.number().int().nonnegative().nullable().optional(),
  field_category: z.string(),
  original_value: z.string(),
  page_number: z.number().int().positive(),
  bbox: templatePdfEvidenceBboxSchema.nullable().optional(),
  evidence_text: z.string(),
  confidence: z.number().min(0).max(1),
  match_type: z.enum([
    'normalized_exact',
    'raw_contains',
    'vision_bbox',
    'manual_bbox',
  ]),
});

export const templatePdfEvidenceResultSchema = z.object({
  pdf_file_name: z.string(),
  ocr_pages: z.array(templatePdfEvidencePageSchema),
  matches: z.array(templatePdfEvidenceMatchSchema),
});

export type ExtractionItem = z.infer<typeof extractionItemSchema>;
export type ExtractionParagraph = z.infer<typeof extractionParagraphSchema>;
export type TemplateSlotExtractionResult = z.infer<
  typeof templateSlotExtractionResultSchema
>;
export type TemplatePdfEvidenceResult = z.infer<
  typeof templatePdfEvidenceResultSchema
>;
