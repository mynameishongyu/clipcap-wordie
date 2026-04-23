do $$
begin
  create type public.app_log_level as enum (
    'info',
    'warning',
    'error'
  );
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.app_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles(id) on delete set null,
  actor_email text,
  level public.app_log_level not null default 'info',
  event_type text not null,
  message text not null,
  route text,
  template_id text references public.templates(id) on delete set null,
  task_id uuid references public.generation_tasks(id) on delete set null,
  task_item_id uuid references public.generation_task_items(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists app_logs_owner_created_idx
  on public.app_logs(owner_id, created_at desc);

create index if not exists app_logs_event_created_idx
  on public.app_logs(event_type, created_at desc);

create index if not exists app_logs_level_created_idx
  on public.app_logs(level, created_at desc);

create index if not exists app_logs_template_created_idx
  on public.app_logs(template_id, created_at desc);

create index if not exists app_logs_task_created_idx
  on public.app_logs(task_id, created_at desc);

create index if not exists app_logs_task_item_created_idx
  on public.app_logs(task_item_id, created_at desc);

alter table public.app_logs enable row level security;

drop policy if exists app_logs_select_own_or_admin on public.app_logs;
create policy app_logs_select_own_or_admin
on public.app_logs for select
using (owner_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists app_logs_insert_admin_only on public.app_logs;
create policy app_logs_insert_admin_only
on public.app_logs for insert
with check (public.is_admin(auth.uid()));

drop policy if exists app_logs_update_admin_only on public.app_logs;
create policy app_logs_update_admin_only
on public.app_logs for update
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

drop policy if exists app_logs_delete_admin_only on public.app_logs;
create policy app_logs_delete_admin_only
on public.app_logs for delete
using (public.is_admin(auth.uid()));
