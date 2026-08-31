# Expense Ledger Project

This is a personal expense ledger web application.

## Current architecture

- Single-page vanilla HTML/CSS/JavaScript application.
- Main entry point: index.html.
- No React, Vue, Next.js, or other frontend framework.
- Production persistence uses Supabase Auth and the `ledger_storage` PostgreSQL
  table with Row Level Security.
- The browser may contain only the public Supabase Project URL and publishable
  key. It must never contain a service-role key, database password, or secret.
- Entries are stored as monthly JSON snapshots under `expense-entries-YYYY-MM`;
  vendor aliases and import batches use separate storage keys.
- `?storage=file` is a localhost-only test mode backed by
  `test-fixtures/private/state`. It is not a production fallback.
- Existing business logic includes:
  - cash expense entry
  - government invoice CSV import
  - credit card CSV import
  - duplicate detection
  - invoice/credit-card reconciliation
  - vendor alias matching
  - historical category learning
  - AI-assisted category workflow
  - import batch rollback
  - data quality checks
  - backup and restore

## Development goals

The first cloud migration is complete. The application now supports one user
across laptop and mobile while retaining the vanilla frontend and JSON backup.

Target architecture:

- Keep the existing vanilla JS frontend for now.
- Keep JSON backup/export support.
- Later add PWA/offline support.

## Start-of-task checklist

- Read `README.md`, `docs/PROJECT_STATUS.md`, `docs/DECISIONS.md`, and
  `docs/BACKLOG.md`.
- Inspect `git status` and preserve unrelated user changes.
- Run tests proportionate to risk. Storage, import, reconciliation, backup, and
  authentication changes require the full `deno task test` suite.
- Never use or commit real financial CSV/JSON data from `test-fixtures/private`
  or the user's Downloads folder.

## Important constraints

- Do not rewrite the project into React/Next.js unless explicitly requested.
- Preserve current reconciliation and import behavior.
- Preserve backward compatibility with existing backups where possible.
- Do not remove existing functionality just to simplify the code.
- Make incremental changes.
- Before major refactors, explain the proposed change.
- Keep data integrity as the highest priority.
- Never put Supabase service-role or secret keys in browser code.
- Preserve `originalAmount` when users edit their personal share; reconciliation
  must continue to use the original transaction amount.
- Production is cloud-only. Do not reintroduce localStorage as an automatic
  fallback or silently merge local and cloud ledgers.
- Do not change the monthly storage format without a migration and
  backward-compatibility plan.
