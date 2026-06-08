create table if not exists public.generation_task_items (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.generation_tasks(id) on delete set null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  template_id text references public.templates(id) on delete set null,
  source_pdf_name text not null,
  source_pdf_path text not null,
  status public.generation_task_item_status not null default 'pending',
  elapsed_seconds int not null default 0,
  slot_total_count int not null default 0,
  slot_completed_count int not null default 0,
  processing_trace text not null default '',
  llm_input jsonb,
  llm_output jsonb,
  page_filter_llm_usage jsonb,
  slot_fill_llm_usage jsonb,
  review_payload jsonb,
  output_docx_path text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  reviewed_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index if not exists generation_task_items_task_created_idx
  on public.generation_task_items(task_id, created_at asc);

create index if not exists generation_task_items_owner_created_idx
  on public.generation_task_items(owner_id, created_at desc);

create index if not exists generation_task_items_owner_visible_created_idx
  on public.generation_task_items(owner_id, created_at desc)
  where deleted_at is null;

create index if not exists generation_task_items_template_created_idx
  on public.generation_task_items(template_id, created_at desc);

create index if not exists generation_task_items_status_created_idx
  on public.generation_task_items(status, created_at desc);

drop trigger if exists trg_generation_task_items_updated_at
on public.generation_task_items;
create trigger trg_generation_task_items_updated_at
before update on public.generation_task_items
for each row execute procedure public.set_updated_at();

create or replace function public.append_generation_task_item_processing_trace(
  p_task_item_id uuid,
  p_entry text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  next_trace text;
begin
  update public.generation_task_items
  set
    processing_trace = case
      when coalesce(processing_trace, '') = '' then p_entry
      else processing_trace || E'\n' || p_entry
    end,
    updated_at = now()
  where id = p_task_item_id
  returning processing_trace into next_trace;

  return coalesce(next_trace, '');
end;
$$;

alter table public.generation_task_items enable row level security;

drop policy if exists generation_task_items_select_own_or_admin
on public.generation_task_items;
create policy generation_task_items_select_own_or_admin
on public.generation_task_items for select
using (owner_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists generation_task_items_insert_own_or_admin
on public.generation_task_items;
create policy generation_task_items_insert_own_or_admin
on public.generation_task_items for insert
with check (owner_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists generation_task_items_update_own_or_admin
on public.generation_task_items;
create policy generation_task_items_update_own_or_admin
on public.generation_task_items for update
using (owner_id = auth.uid() or public.is_admin(auth.uid()))
with check (owner_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists generation_task_items_delete_own_or_admin
on public.generation_task_items;
create policy generation_task_items_delete_own_or_admin
on public.generation_task_items for delete
using (owner_id = auth.uid() or public.is_admin(auth.uid()));
