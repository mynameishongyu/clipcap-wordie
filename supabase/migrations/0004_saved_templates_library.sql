alter table public.templates
  add column if not exists template_name text,
  add column if not exists upload_docx_name text,
  add column if not exists upload_docx_base64 text,
  add column if not exists upload_html text,
  add column if not exists slot_preview jsonb,
  add column if not exists slot_review_payload jsonb,
  add column if not exists updated_at timestamptz;

update public.templates
set
  template_name = coalesce(template_name, id),
  updated_at = coalesce(updated_at, created_at, now())
where template_name is null
   or updated_at is null;

alter table public.templates
  alter column template_name set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

alter table public.templates
  drop constraint if exists templates_owner_id_fkey;

alter table public.templates
  add constraint templates_owner_id_fkey
  foreign key (owner_id) references public.profiles(id) on delete cascade;

create index if not exists templates_owner_updated_idx
  on public.templates(owner_id, updated_at desc);

create index if not exists templates_owner_name_idx
  on public.templates(owner_id, template_name);
