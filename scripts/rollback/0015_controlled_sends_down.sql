-- Reverse migration for 0015 (Phase 14 controlled sending).
-- Apply before reverting to phase-13-daily-operations.
BEGIN;

DROP TABLE IF EXISTS send_attempts;
DROP TABLE IF EXISTS sending_readiness_approvals;

UPDATE send_schedules SET status = 'CANCELLED', cancel_reason = 'phase_14_rollback'
WHERE status IN ('FULFILLED', 'INVALIDATED');
ALTER TABLE send_schedules DROP CONSTRAINT IF EXISTS send_schedule_status_ck;
ALTER TABLE send_schedules DROP COLUMN IF EXISTS fulfilled_at;
ALTER TABLE send_schedules DROP COLUMN IF EXISTS invalidated_at;
ALTER TABLE send_schedules DROP COLUMN IF EXISTS invalidation_reason;
ALTER TABLE send_schedules ADD CONSTRAINT send_schedule_status_ck CHECK (status IN ('SCHEDULED','CANCELLED','SUPERSEDED'));

DELETE FROM suppression_list WHERE scope = 'email';
ALTER TABLE suppression_list DROP CONSTRAINT IF EXISTS suppression_scope_ck;
ALTER TABLE suppression_list ADD CONSTRAINT suppression_scope_ck CHECK (scope IN ('domain','phone','place_id'));

COMMIT;
