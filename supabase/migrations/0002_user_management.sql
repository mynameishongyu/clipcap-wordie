-- 0002_user_management.sql
-- Adapted user management schema for clipcap-word-production.

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
  create type public.credit_tx_kind as enum ('grant', 'charge', 'refund', 'admin_adjust');
exception
  when duplicate_object then null;
end;
$$;

alter table public.profiles
  add column if not exists role public.user_role,
  add column if not exists avatar_url text,
  add column if not exists updated_at timestamptz,
  add column if not exists locale text,
  add column if not exists invited_at timestamptz,
  add column if not exists invite_code text;

update public.profiles
set
  role = coalesce(role, 'user'::public.user_role),
  updated_at = coalesce(updated_at, created_at, now()),
  locale = coalesce(locale, 'zh-CN')
where role is null
   or updated_at is null
   or locale is null;

alter table public.profiles
  alter column role set default 'user',
  alter column role set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null,
  alter column locale set default 'zh-CN',
  alter column locale set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_id_fkey'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_id_fkey
      foreign key (id) references auth.users(id) on delete cascade;
  end if;
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_locale_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_locale_check
      check (locale in ('zh-CN', 'en'));
  end if;
exception
  when duplicate_object then null;
end;
$$;

create index if not exists profiles_role_idx on public.profiles(role);
create index if not exists profiles_email_idx on public.profiles(email);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();

create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind public.credit_tx_kind not null,
  amount int not null,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists credit_tx_user_created_idx
  on public.credit_transactions(user_id, created_at desc);

create index if not exists credit_tx_kind_idx
  on public.credit_transactions(kind);

create or replace view public.credit_balance as
select
  user_id,
  coalesce(sum(amount), 0)::int as balance
from public.credit_transactions
group by user_id;

create table if not exists public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  batch_label text,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  redeemed_by uuid unique references public.profiles(id) on delete set null,
  redeemed_at timestamptz,
  disabled_at timestamptz
);

create index if not exists invite_codes_created_idx
  on public.invite_codes(created_at desc);

create index if not exists invite_codes_redeemed_idx
  on public.invite_codes(redeemed_at desc);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.profiles (id, role, display_name, email, avatar_url, invited_at, invite_code)
  values (
    new.id,
    'user',
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email,
    new.raw_user_meta_data->>'avatar_url',
    null,
    null
  )
  on conflict (id) do update
  set email = excluded.email,
      display_name = coalesce(public.profiles.display_name, excluded.display_name),
      avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url);

  insert into public.credit_transactions(user_id, kind, amount, reason)
  values (new.id, 'grant', 0, 'signup_grant');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.redeem_invite_code(p_user uuid, p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invite_codes%rowtype;
  v_existing_profile public.profiles%rowtype;
  v_normalized_code text;
begin
  v_normalized_code := upper(trim(p_code));

  if v_normalized_code is null or char_length(v_normalized_code) = 0 then
    raise exception 'Invite code is required';
  end if;

  select *
  into v_existing_profile
  from public.profiles
  where id = p_user;

  if not found then
    raise exception 'Profile not found';
  end if;

  if v_existing_profile.invited_at is not null then
    raise exception 'Invite code has already been redeemed for this account';
  end if;

  select *
  into v_invite
  from public.invite_codes
  where upper(code) = v_normalized_code
  for update;

  if not found then
    raise exception 'Invite code is invalid';
  end if;

  if v_invite.disabled_at is not null then
    raise exception 'Invite code is disabled';
  end if;

  if v_invite.redeemed_at is not null or v_invite.redeemed_by is not null then
    raise exception 'Invite code has already been used';
  end if;

  update public.invite_codes
  set redeemed_by = p_user,
      redeemed_at = now()
  where id = v_invite.id;

  update public.profiles
  set invited_at = now(),
      invite_code = v_invite.code
  where id = p_user;

  insert into public.credit_transactions(user_id, kind, amount, reason)
  values (p_user, 'grant', 100, 'invite_redeem');

  return v_invite.code;
end;
$$;

create or replace function public.is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = uid
      and p.role = 'admin'
  );
$$;

alter table public.profiles enable row level security;
alter table public.templates enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.invite_codes enable row level security;

drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own_or_admin
on public.profiles for select
using (id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists profiles_update_own_or_admin on public.profiles;
create policy profiles_update_own_or_admin
on public.profiles for update
using (id = auth.uid() or public.is_admin(auth.uid()))
with check (id = auth.uid() or public.is_admin(auth.uid()));

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

drop policy if exists credit_tx_select_own_or_admin on public.credit_transactions;
create policy credit_tx_select_own_or_admin
on public.credit_transactions for select
using (user_id = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists invite_codes_select_admin_only on public.invite_codes;
create policy invite_codes_select_admin_only
on public.invite_codes for select
using (public.is_admin(auth.uid()));

drop policy if exists invite_codes_insert_admin_only on public.invite_codes;
create policy invite_codes_insert_admin_only
on public.invite_codes for insert
with check (public.is_admin(auth.uid()));

drop policy if exists invite_codes_update_admin_only on public.invite_codes;
create policy invite_codes_update_admin_only
on public.invite_codes for update
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

create or replace view public.admin_user_overview as
select
  p.id as user_id,
  p.email,
  p.display_name,
  p.role,
  p.locale,
  p.invited_at,
  p.invite_code,
  p.created_at,
  p.updated_at,
  coalesce(cb.balance, 0) as credit_balance,
  coalesce(tp.template_count, 0) as template_count
from public.profiles p
left join public.credit_balance cb on cb.user_id = p.id
left join (
  select owner_id, count(*)::int as template_count
  from public.templates
  group by owner_id
) tp on tp.owner_id = p.id;
