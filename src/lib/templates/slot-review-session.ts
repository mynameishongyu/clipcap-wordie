import type {
  ExtractionParagraph,
  TemplatePdfEvidenceResult,
  TemplateSlotExtractionResult,
} from '@/src/app/api/types/template-slot-extraction';
import type { ParsedDocument } from '@/src/types/docx-preview';

export const SLOT_REVIEW_SESSION_KEY = 'clipcap:slot-review-session';

export interface SlotReviewPdfEvidencePayload {
  pdfFileName: string;
  pages: Array<{
    pageNumber: number;
    imageDataUrl?: string;
    imageUrl?: string;
    storagePath?: string;
    crop?: {
      left: number;
      top: number;
      width: number;
      height: number;
      originalWidth: number;
      originalHeight: number;
      contentRatio: number;
    };
  }>;
  ocrPages: TemplatePdfEvidenceResult['ocr_pages'];
  matches: TemplatePdfEvidenceResult['matches'];
}

export interface SlotReviewSessionPayload {
  templateId?: string;
  templateName?: string;
  fileName: string;
  uploadDocxName?: string;
  uploadDocxBase64?: string;
  prompt: string;
  uploadText: string;
  uploadHtml: string;
  parsedDocument?: ParsedDocument;
  documentInfo: TemplateSlotExtractionResult['document_info'];
  extractionResult: ExtractionParagraph[];
  pdfEvidence?: SlotReviewPdfEvidencePayload;
}
