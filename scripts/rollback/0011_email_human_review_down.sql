-- Reverse migration for 0011 (Phase 10 email human-review fields).
-- Apply with: psql "$DATABASE_URL" -f scripts/rollback/0011_email_human_review_down.sql
-- Run BEFORE `git reset --hard phase-9-email-generation` so the database matches the code.

BEGIN;

ALTER TABLE "email_drafts" DROP CONSTRAINT IF EXISTS "email_draft_human_decision_ck";
ALTER TABLE "email_drafts" DROP COLUMN IF EXISTS "human_reviewed_by";
ALTER TABLE "email_drafts" DROP COLUMN IF EXISTS "human_reviewed_at";
ALTER TABLE "email_drafts" DROP COLUMN IF EXISTS "human_notes";
ALTER TABLE "email_drafts" DROP COLUMN IF EXISTS "human_decision";

COMMIT;
