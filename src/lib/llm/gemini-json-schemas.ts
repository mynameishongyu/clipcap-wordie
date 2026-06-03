const nullableString = { type: ['string', 'null'] } as const;
const nullableNumber = { type: ['number', 'null'] } as const;
const nullableInteger = { type: ['integer', 'null'] } as const;

const bboxArraySchema = {
  type: ['array', 'null'],
  items: { type: 'number' },
  minItems: 4,
  maxItems: 4,
} as const;

const modelMatchSchema = {
  type: 'object',
  properties: {
    value: nullableString,
    snippet: nullableString,
    evidence_text: nullableString,
    source_reason: nullableString,
    matched_reference_label: nullableString,
    new_pdf_bbox: bboxArraySchema,
    layout_match_score: nullableNumber,
    page_number: { type: ['integer', 'string', 'null'] },
    confidence: nullableNumber,
  },
} as const;

const slotExtractionMatchSchema = {
  type: 'object',
  properties: {
    value: nullableString,
    evidence_text: nullableString,
    matched_reference_label: nullableString,
    page_number: { type: ['integer', 'string', 'null'] },
  },
  required: ['value', 'evidence_text', 'matched_reference_label', 'page_number'],
} as const;

export const geminiPdfSlotExtractionResponseSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot_key: { type: 'string' },
          slot_name: { type: 'string' },
          final_value: nullableString,
          matches: {
            type: 'array',
            items: slotExtractionMatchSchema,
          },
        },
        required: ['slot_key', 'slot_name', 'final_value', 'matches'],
      },
    },
  },
  required: ['results'],
} as const;

export const geminiPdfSlotFillResponseSchema = {
  type: 'object',
  properties: {
    document_summary: nullableString,
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot_key: { type: 'string' },
          slot_name: nullableString,
          final_value: nullableString,
          matches: {
            type: 'array',
            items: modelMatchSchema,
          },
        },
        required: ['slot_key'],
      },
    },
    extracted_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot_key: { type: 'string' },
          field_category: { type: 'string' },
          meaning_to_applicant: { type: 'string' },
          original_value: { type: 'string' },
          evidence: nullableString,
          evidence_page_numbers: {
            type: 'array',
            items: { type: 'integer' },
          },
          notes: nullableString,
          confidence: nullableNumber,
          matched_reference_label: nullableString,
          new_pdf_bbox: bboxArraySchema,
          layout_match_score: nullableNumber,
        },
        required: [
          'slot_key',
          'field_category',
          'meaning_to_applicant',
          'original_value',
        ],
      },
    },
  },
} as const;

export const geminiReferencePageAlignmentResponseSchema = {
  type: 'object',
  properties: {
    alignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          reference_page_number: { type: 'integer' },
          matched_uploaded_page_number: nullableInteger,
          confidence: nullableNumber,
          reason: nullableString,
        },
        required: ['reference_page_number'],
      },
    },
  },
  required: ['alignments'],
} as const;

export const geminiTemplatePdfLocateResponseSchema = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot_key: { type: 'string' },
          page_number: { type: 'integer' },
          bbox_target: nullableString,
          bbox: {
            type: ['object', 'null'],
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
          },
          box_2d: bboxArraySchema,
          bbox_2d: bboxArraySchema,
          evidence_text: nullableString,
          confidence: nullableNumber,
        },
        required: ['slot_key', 'page_number'],
      },
    },
  },
  required: ['matches'],
} as const;

export const geminiTemplateSlotExtractionResponseSchema = {
  type: 'object',
  properties: {
    document_info: {
      type: 'object',
      properties: {
        document_name: nullableString,
      },
    },
    extraction_result: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          paragraph_index: { type: 'integer' },
          paragraph_title: nullableString,
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sequence: { type: 'integer' },
                paragraph_index: nullableInteger,
                field_category: { type: 'string' },
                original_value: { type: 'string' },
                meaning_to_applicant: { type: 'string' },
                original_doc_position: { type: 'string' },
              },
              required: [
                'sequence',
                'field_category',
                'original_value',
                'meaning_to_applicant',
                'original_doc_position',
              ],
            },
          },
        },
        required: ['paragraph_index', 'items'],
      },
    },
  },
  required: ['document_info', 'extraction_result'],
} as const;

export const geminiPageFilterResponseSchema = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          page_number: { type: 'integer' },
          decision: { type: 'string', enum: ['keep', 'drop', 'review'] },
          reason: { type: 'string' },
          confidence: nullableNumber,
        },
        required: ['page_number', 'decision', 'reason'],
      },
    },
  },
  required: ['pages'],
} as const;

export const geminiOcrPagesResponseSchema = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          page_number: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['page_number', 'text'],
      },
    },
  },
  required: ['pages'],
} as const;

export function withGeminiOpenAiJsonResponseFormat<
  TBody extends Record<string, unknown>,
>(
  body: TBody,
  input: {
    provider: string;
    name: string;
    schema: unknown;
    strict?: boolean;
  },
) {
  if (input.provider !== 'gemini' && input.provider !== 'doubao') {
    return body;
  }

  return {
    ...body,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: input.name,
        schema: input.schema,
        strict: input.strict ?? false,
      },
    },
  };
}
