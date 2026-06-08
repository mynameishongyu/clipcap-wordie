create table if not exists public.generation_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  template_id text references public.templates(id) on delete set null,
  template_name_snapshot text not null,
  status public.generation_task_status not null default 'pending',
  total_items int not null default 0,
  succeeded_items int not null default 0,
  failed_items int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index if not exists generation_tasks_owner_created_idx
  on public.generation_tasks(owner_id, created_at desc);

create index if not exists generation_tasks_owner_visible_created_idx
  on public.generation_tasks(owner_id, created_at desc)
  where deleted_at is null;

create index if not exists generation_tasks_template_created_idx
  on public.generation_tasks(template_id, created_at desc);

create index if not exists generation_tasks_status_created_idx
  on public.generation_tasks(status, created_at desc);

drop trigger if exists trg_generation_tasks_updated_at
on public.generation_tasks;
create trigger trg_generation_tasks_updated_at
before update on public.generation_tasks
for each row execute procedure public.set_updated_at();

alter table public.generation_tasks enable row level security;

drop policy if exists generation_tasks_select_own_or_admin
on public.generation_tasks;
create policy generation_tasks_select_own_or_admin
on public.generation_tasks for select
using (owner_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists generation_tasks_insert_own_or_admin
on public.generation_tasks;
create policy generation_tasks_insert_own_or_admin
on public.generation_tasks for insert
with check (owner_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists generation_tasks_update_own_or_admin
on public.generation_tasks;
create policy generation_tasks_update_own_or_admin
on public.generation_tasks for update
using (owner_id = auth.uid() or public.is_admin(auth.uid()))
with check (owner_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists generation_tasks_delete_own_or_admin
on public.generation_tasks;
create policy generation_tasks_delete_own_or_admin
on public.generation_tasks for delete
using (owner_id = auth.uid() or public.is_admin(auth.uid()));
