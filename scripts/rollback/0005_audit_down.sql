-- Reverse migration for 0005 (Phase 6 AI website audit).
-- Apply with: psql "$DATABASE_URL" -f scripts/rollback/0005_audit_down.sql
-- Drops the audit tables. Run BEFORE `git reset --hard phase-5-website-capture` so
-- the database matches the code. Lead statuses are enum-in-code only (no DB CHECK),
-- so no status revert is required; leads already moved to AUDITED/OPPORTUNITY_READY
-- can be re-audited later (audit history for them is dropped here).

BEGIN;

DROP TABLE IF EXISTS prompt_versions;
DROP TABLE IF EXISTS model_calls;
DROP TABLE IF EXISTS opportunity_assessments;
DROP TABLE IF EXISTS audit_review_findings;
DROP TABLE IF EXISTS audit_reviews;
DROP TABLE IF EXISTS audit_finding_evidence;
DROP TABLE IF EXISTS audit_findings;
DROP TABLE IF EXISTS audit_runs;

COMMIT;
