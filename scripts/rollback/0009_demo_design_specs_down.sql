-- Reverse migration for 0009 (Phase 8B AI Demo Composer design-spec persistence).
-- Apply with: psql "$DATABASE_URL" -f scripts/rollback/0009_demo_design_specs_down.sql
-- Drops the demo_design_specs table. Run BEFORE `git reset --hard phase-8-demo-foundation`
-- so the database matches the code. Composed demo files under ./demos are removed separately.

BEGIN;

DROP TABLE IF EXISTS demo_design_specs;

COMMIT;
