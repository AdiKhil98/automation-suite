ALTER TABLE "sending_readiness_approvals" ADD COLUMN IF NOT EXISTS "revoked_by" text;--> statement-breakpoint
ALTER TABLE "sending_readiness_approvals" ADD COLUMN IF NOT EXISTS "revoke_reason" text;--> statement-breakpoint
ALTER TABLE "sending_readiness_approvals" ADD CONSTRAINT "sending_readiness_revocation_ck" CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sending_readiness_active_uk" ON "sending_readiness_approvals" ("gmail_account", "policy_version") WHERE "revoked_at" IS NULL;--> statement-breakpoint

ALTER TABLE "send_attempts" ADD COLUMN IF NOT EXISTS "reconciled_outcome" text;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD COLUMN IF NOT EXISTS "reconciled_by" text;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD COLUMN IF NOT EXISTS "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD COLUMN IF NOT EXISTS "reconciliation_note" text;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempt_reconciliation_ck" CHECK (
  (reconciled_outcome IS NULL AND reconciled_by IS NULL AND reconciled_at IS NULL AND reconciliation_note IS NULL)
  OR
  (reconciled_outcome IN ('CONFIRMED_SENT','CONFIRMED_NOT_SENT') AND reconciled_by IS NOT NULL AND reconciled_at IS NOT NULL AND reconciliation_note IS NOT NULL)
);--> statement-breakpoint
DROP INDEX IF EXISTS "send_attempts_confirmed_schedule_uk";--> statement-breakpoint
CREATE UNIQUE INDEX "send_attempts_confirmed_schedule_uk" ON "send_attempts" ("schedule_id") WHERE "status" = 'SENT_CONFIRMED' OR "reconciled_outcome" = 'CONFIRMED_SENT';--> statement-breakpoint
DROP INDEX IF EXISTS "send_attempts_blocking_schedule_uk";--> statement-breakpoint
CREATE UNIQUE INDEX "send_attempts_blocking_schedule_uk" ON "send_attempts" ("schedule_id") WHERE "status" IN ('RESERVED','CALL_STARTED','SENT_CONFIRMED') OR ("status" = 'OUTCOME_UNKNOWN' AND "reconciled_outcome" IS DISTINCT FROM 'CONFIRMED_NOT_SENT');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "send_attempts_account_completed_idx" ON "send_attempts" ("gmail_account", (COALESCE("reconciled_at", "completed_at"))) WHERE "status" = 'SENT_CONFIRMED' OR "reconciled_outcome" = 'CONFIRMED_SENT';
