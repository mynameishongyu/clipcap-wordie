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

create or replace function public.redeem_invite_code(
  p_user uuid,
  p_code text
)
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

alter table public.invite_codes enable row level security;

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
