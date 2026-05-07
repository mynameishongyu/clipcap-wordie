alter table public.template_extraction_tasks
  add column if not exists source_pdf_name text,
  add column if not exists source_pdf_vision_pages jsonb,
  add column if not exists pdf_evidence jsonb;
