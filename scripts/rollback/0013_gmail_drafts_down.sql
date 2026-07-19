-- Reverse migration for 0013 (Phase 12 Gmail draft creation).
-- Apply with: psql "$DATABASE_URL" -f scripts/rollback/0013_gmail_drafts_down.sql
-- Run BEFORE `git reset --hard phase-11-netlify-previews` so the database matches the code.

BEGIN;

DROP TABLE IF EXISTS gmail_drafts;

COMMIT;
