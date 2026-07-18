-- Reverse migration for 0010 (Phase 9 cold email writer + reviewer).
-- Apply with: psql "$DATABASE_URL" -f scripts/rollback/0010_email_down.sql
-- Run BEFORE `git reset --hard phase-8b-ai-composer` so the database matches the code.

BEGIN;

DROP TABLE IF EXISTS email_finding_inputs;
DROP TABLE IF EXISTS email_fact_inputs;
DROP TABLE IF EXISTS email_drafts;

COMMIT;
