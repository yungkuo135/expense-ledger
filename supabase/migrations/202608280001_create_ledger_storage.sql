create table if not exists public.ledger_storage (
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_key text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, storage_key),
  constraint ledger_storage_key_format check (
    storage_key ~ '^(expense-entries(-[0-9]{4}-[0-9]{2})?|vendor-aliases|import-batches-v1|ledger-meta|ledger-migration-entries-v1)$'
  )
);

alter table public.ledger_storage enable row level security;

revoke all on table public.ledger_storage from anon;
grant select, insert, update, delete on table public.ledger_storage to authenticated;

drop policy if exists "ledger_storage_select_own" on public.ledger_storage;
create policy "ledger_storage_select_own"
on public.ledger_storage for select
to authenticated
using ((select auth.uid()) = user_id);
drop policy if exists "ledger_storage_insert_own" on public.ledger_storage;
create policy "ledger_storage_insert_own"
on public.ledger_storage for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "ledger_storage_update_own" on public.ledger_storage;
create policy "ledger_storage_update_own"
on public.ledger_storage for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "ledger_storage_delete_own" on public.ledger_storage;
create policy "ledger_storage_delete_own"
on public.ledger_storage for delete
to authenticated
using ((select auth.uid()) = user_id);
