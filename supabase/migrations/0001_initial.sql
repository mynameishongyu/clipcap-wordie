create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.templates (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  upload_text text not null,
  prompt text not null,
  result jsonb,
  created_at timestamptz not null default now()
);
