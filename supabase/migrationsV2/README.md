# migrationsV2

These SQL files are a hand-run, final-schema version of the existing
incremental migrations in `supabase/migrations`.

They are intended for Supabase SQL Editor execution in order. They are not a
replacement for the existing Supabase CLI migration history.

Recommended order:

1. `00_extensions_and_types.sql`
2. `01_profiles.sql`
3. `02_templates.sql`
4. `03_credit_transactions.sql`
5. `04_invite_codes.sql`
6. `05_generation_tasks.sql`
7. `06_generation_task_items.sql`
8. `07_app_logs.sql`
9. `08_template_extraction_tasks.sql`
10. `09_auth_and_admin_views.sql`
11. `10_storage_generation_pdfs.sql`

Notes:

- Files are grouped by final table/module, not by historical migration step.
- Storage policies assume `public.is_admin(uuid)` already exists, so run
  `01_profiles.sql` before `10_storage_generation_pdfs.sql`.
- The SQL uses `if not exists` / `drop policy if exists` where practical so it
  can be re-run during setup.
