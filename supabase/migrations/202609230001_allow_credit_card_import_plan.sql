alter table public.ledger_storage
drop constraint if exists ledger_storage_key_format;

alter table public.ledger_storage
add constraint ledger_storage_key_format check (
  storage_key ~ '^(expense-entries(-[0-9]{4}-[0-9]{2})?|vendor-aliases|import-batches-v1|credit-card-import-plan-v1|ledger-meta|ledger-migration-entries-v1)$'
);
