-- Reverse migration for 0006 (Phase 6 audit-attempt validation diagnostics).
-- Apply with: psql "$DATABASE_URL" -f scripts/rollback/0006_audit_debug_down.sql
-- Drops the diagnostics column added to model_calls. Safe: nullable, additive column.

BEGIN;

ALTER TABLE "model_calls" DROP COLUMN IF EXISTS "validation_violations";

COMMIT;
