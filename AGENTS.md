# Expense Ledger Project

This is a personal expense ledger web application.

## Current architecture

- Single-page vanilla HTML/CSS/JavaScript application.
- Main entry point: index.html.
- No React, Vue, Next.js, or other frontend framework.
- Current local persistence uses window.storage.
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

We are migrating this application from local-only storage to a multi-device web
application.

Target architecture:

- Keep the existing vanilla JS frontend for now.
- Supabase Auth for authentication.
- Supabase PostgreSQL for cloud persistence.
- Support one user across laptop and mobile.
- Keep JSON backup/export support.
- Later add PWA/offline support.

## Important constraints

- Do not rewrite the project into React/Next.js unless explicitly requested.
- Preserve current reconciliation and import behavior.
- Preserve backward compatibility with existing backups where possible.
- Do not remove existing functionality just to simplify the code.
- Make incremental changes.
- Before major refactors, explain the proposed change.
- Keep data integrity as the highest priority.
- Never put Supabase service-role or secret keys in browser code.
