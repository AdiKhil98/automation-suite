-- Reverse migration for 0016 (Phase 15 production sending readiness).
-- Reconciliation metadata is intentionally discarded; review before applying.
BEGIN;

DROP INDEX IF EXISTS send_attempts_account_completed_idx;
DROP INDEX IF EXISTS send_attempts_blocking_schedule_uk;
DROP INDEX IF EXISTS send_attempts_confirmed_schedule_uk;
ALTER TABLE send_attempts DROP CONSTRAINT IF EXISTS send_attempt_reconciliation_ck;
ALTER TABLE send_attempts DROP COLUMN IF EXISTS reconciliation_note;
ALTER TABLE send_attempts DROP COLUMN IF EXISTS reconciled_at;
ALTER TABLE send_attempts DROP COLUMN IF EXISTS reconciled_by;
ALTER TABLE send_attempts DROP COLUMN IF EXISTS reconciled_outcome;
CREATE UNIQUE INDEX send_attempts_confirmed_schedule_uk ON send_attempts (schedule_id) WHERE status = 'SENT_CONFIRMED';
CREATE UNIQUE INDEX send_attempts_blocking_schedule_uk ON send_attempts (schedule_id) WHERE status IN ('RESERVED','CALL_STARTED','SENT_CONFIRMED','OUTCOME_UNKNOWN');

DROP INDEX IF EXISTS sending_readiness_active_uk;
ALTER TABLE sending_readiness_approvals DROP CONSTRAINT IF EXISTS sending_readiness_revocation_ck;
ALTER TABLE sending_readiness_approvals DROP COLUMN IF EXISTS revoke_reason;
ALTER TABLE sending_readiness_approvals DROP COLUMN IF EXISTS revoked_by;

COMMIT;
