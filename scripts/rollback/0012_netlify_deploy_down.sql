-- Reverse migration for 0012 (Phase 11 Netlify deployment + email finalization).
-- Apply with: psql "$DATABASE_URL" -f scripts/rollback/0012_netlify_deploy_down.sql
-- Run BEFORE `git reset --hard phase-10-review-dashboard` so the database matches the code.

BEGIN;

DROP TABLE IF EXISTS email_draft_finalizations;
DROP TABLE IF EXISTS demo_deployment_runs;

COMMIT;
