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

alter table public.credit_transactions enable row level security;

drop policy if exists credit_tx_select_own_or_admin
on public.credit_transactions;
create policy credit_tx_select_own_or_admin
on public.credit_transactions for select
using (user_id = auth.uid() or public.is_admin(auth.uid()));
