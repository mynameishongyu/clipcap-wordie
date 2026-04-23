alter table public.profiles
  add column if not exists registration_status text,
  add column if not exists organization_name text,
  add column if not exists use_case text,
  add column if not exists onboarded_at timestamptz;

update public.profiles
set registration_status = 'pending'
where registration_status is null;

alter table public.profiles
  alter column registration_status set default 'pending',
  alter column registration_status set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_registration_status_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_registration_status_check
      check (registration_status in ('pending', 'completed'));
  end if;
exception
  when duplicate_object then null;
end;
$$;
