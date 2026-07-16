-- Reverse migration for 0007 (Phase 8 demo decision & generation).
-- Apply with: psql "$DATABASE_URL" -f scripts/rollback/0007_demo_down.sql
-- Drops the demo tables. Run BEFORE `git reset --hard phase-6-ai-audit` so the database
-- matches the code. Lead statuses are enum-in-code only (no DB CHECK); DEMO_DECIDED /
-- DEMO_READY need no revert. Generated demo files under ./demos are removed separately.

BEGIN;

DROP TABLE IF EXISTS demo_finding_inputs;
DROP TABLE IF EXISTS demo_fact_inputs;
DROP TABLE IF EXISTS demos;
DROP TABLE IF EXISTS demo_decisions;

COMMIT;
