alter table public.template_extraction_tasks
  add column if not exists docx_slot_extraction_llm_usage jsonb,
  add column if not exists pdf_evidence_location_llm_usage jsonb;

alter table public.generation_task_items
  add column if not exists slot_fill_llm_usage jsonb;

comment on column public.template_extraction_tasks.docx_slot_extraction_llm_usage
  is 'Aggregated LLM token usage for DOCX template slot extraction.';

comment on column public.template_extraction_tasks.pdf_evidence_location_llm_usage
  is 'Aggregated LLM token usage for locating extracted slots in PDF evidence images.';

comment on column public.generation_task_items.slot_fill_llm_usage
  is 'Aggregated LLM token usage for filling template slots from a source PDF.';
