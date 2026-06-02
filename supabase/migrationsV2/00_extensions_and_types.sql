create extension if not exists pgcrypto;

do $$
begin
  create type public.user_role as enum ('user', 'admin');
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  create type public.credit_tx_kind as enum (
    'grant',
    'charge',
    'refund',
    'admin_adjust'
  );
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  create type public.generation_task_status as enum (
    'pending',
    'running',
    'completed',
    'failed',
    'cancelled'
  );
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  create type public.generation_task_item_status as enum (
    'pending',
    'uploaded',
    'running',
    'succeeded',
    'failed',
    'review_pending',
    'reviewed',
    'ocr_running',
    'ocr_completed',
    'slot_filling',
    'pdf_pages_ready',
    'page_preparing'
  );
exception
  when duplicate_object then null;
end;
$$;

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

do $$
begin
  create type public.template_extraction_task_status as enum (
    'pending',
    'running',
    'completed',
    'failed'
  );
exception
  when duplicate_object then null;
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
