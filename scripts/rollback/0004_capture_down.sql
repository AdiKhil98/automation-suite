-- Reverse migration for 0004 (Phase 5 website capture).
-- Apply with: psql "$DATABASE_URL" -f scripts/rollback/0004_capture_down.sql
-- Drops the capture tables. Run BEFORE `git reset --hard phase-4-enrichment` so the
-- database matches the code. The new lead states (READY_FOR_CAPTURE, CAPTURED) are
-- enum-in-code only (no DB CHECK on leads.status), so no status revert is required.

BEGIN;

DROP TABLE IF EXISTS capture_errors;
DROP TABLE IF EXISTS capture_evidence;
DROP TABLE IF EXISTS capture_artifacts;
DROP TABLE IF EXISTS captured_pages;
DROP TABLE IF EXISTS website_capture_runs;

COMMIT;
