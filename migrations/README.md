# Migrations

SQL migration files applied by `src/core/history/migrations.ts`.

Naming convention: `NNNN_short_description.sql` (zero-padded sequential).

The runner reads `PRAGMA user_version` and applies any migration whose
prefix exceeds the current version. Migrations are forward-only.

P3 fills this directory with `0001_init.sql` (captures, threads, turns,
FTS5 virtual tables, capture_vec via sqlite-vss).
