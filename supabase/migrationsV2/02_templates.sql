create table if not exists public.templates (
  id text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  template_name text not null,
  upload_docx_name text,
  upload_docx_base64 text,
  upload_text text not null,
  upload_html text,
  prompt text not null,
  result jsonb,
  slot_preview jsonb,
  slot_review_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists templates_owner_updated_idx
  on public.templates(owner_id, updated_at desc);

create index if not exists templates_owner_name_idx
  on public.templates(owner_id, template_name);

alter table public.templates enable row level security;

drop policy if exists templates_select_own_or_admin on public.templates;
create policy templates_select_own_or_admin
on public.templates for select
using (owner_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists templates_insert_own on public.templates;
create policy templates_insert_own
on public.templates for insert
with check (owner_id = auth.uid());

drop policy if exists templates_update_own_or_admin on public.templates;
create policy templates_update_own_or_admin
on public.templates for update
using (owner_id = auth.uid() or public.is_admin(auth.uid()))
with check (owner_id = auth.uid() or public.is_admin(auth.uid()));
