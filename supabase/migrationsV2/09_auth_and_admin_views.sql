create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.profiles (
    id,
    role,
    display_name,
    email,
    avatar_url,
    invited_at,
    invite_code
  )
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
