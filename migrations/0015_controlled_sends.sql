ALTER TABLE "suppression_list" DROP CONSTRAINT IF EXISTS "suppression_scope_ck";--> statement-breakpoint
ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_scope_ck" CHECK (scope IN ('domain','phone','place_id','email'));--> statement-breakpoint
ALTER TABLE "send_schedules" DROP CONSTRAINT IF EXISTS "send_schedule_status_ck";--> statement-breakpoint
ALTER TABLE "send_schedules" ADD COLUMN IF NOT EXISTS "fulfilled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "send_schedules" ADD COLUMN IF NOT EXISTS "invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "send_schedules" ADD COLUMN IF NOT EXISTS "invalidation_reason" text;--> statement-breakpoint
ALTER TABLE "send_schedules" ADD CONSTRAINT "send_schedule_status_ck" CHECK (status IN ('SCHEDULED','CANCELLED','SUPERSEDED','FULFILLED','INVALIDATED'));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sending_readiness_approvals" (
  "id" text PRIMARY KEY NOT NULL,
  "gmail_account" text NOT NULL,
  "policy_version" text NOT NULL,
  "approved_by" text NOT NULL,
  "approved_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sending_readiness_account_idx" ON "sending_readiness_approvals" ("gmail_account", "policy_version");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "send_attempts" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL,
  "schedule_id" text NOT NULL,
  "gmail_draft_id" text NOT NULL,
  "readiness_approval_id" text NOT NULL,
  "gmail_account" text NOT NULL,
  "recipient_hash" text NOT NULL,
  "finalized_content_hash" text NOT NULL,
  "schedule_integrity_fingerprint" text NOT NULL,
  "approved_envelope_hash" text NOT NULL,
  "observed_envelope_hash" text NOT NULL,
  "send_fingerprint" text NOT NULL,
  "confirmation_fingerprint" text NOT NULL,
  "confirmed_by" text NOT NULL,
  "confirmed_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL,
  "provider_message_id" text,
  "provider_thread_id" text,
  "error_class" text,
  "reserved_at" timestamp with time zone NOT NULL,
  "call_started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "send_attempt_status_ck" CHECK (status IN ('RESERVED','CALL_STARTED','SENT_CONFIRMED','DEFINITIVE_FAILURE','OUTCOME_UNKNOWN','DUPLICATE_PREVENTED'))
);--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_schedule_id_send_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "send_schedules"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_gmail_draft_id_gmail_drafts_id_fk" FOREIGN KEY ("gmail_draft_id") REFERENCES "gmail_drafts"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "send_attempts" ADD CONSTRAINT "send_attempts_readiness_id_fk" FOREIGN KEY ("readiness_approval_id") REFERENCES "sending_readiness_approvals"("id") ON DELETE restrict;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "send_attempts_lead_idx" ON "send_attempts" ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "send_attempts_schedule_idx" ON "send_attempts" ("schedule_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "send_attempts_fingerprint_uk" ON "send_attempts" ("send_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "send_attempts_confirmed_schedule_uk" ON "send_attempts" ("schedule_id") WHERE "status" = 'SENT_CONFIRMED';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "send_attempts_blocking_schedule_uk" ON "send_attempts" ("schedule_id") WHERE "status" IN ('RESERVED','CALL_STARTED','SENT_CONFIRMED','OUTCOME_UNKNOWN');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "send_attempts_provider_message_uk" ON "send_attempts" ("provider_message_id") WHERE "provider_message_id" IS NOT NULL;
