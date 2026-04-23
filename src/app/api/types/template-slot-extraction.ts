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

export type ExtractionItem = z.infer<typeof extractionItemSchema>;
export type ExtractionParagraph = z.infer<typeof extractionParagraphSchema>;
export type TemplateSlotExtractionResult = z.infer<typeof templateSlotExtractionResultSchema>;
