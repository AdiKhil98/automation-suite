ALTER TABLE "email_drafts" ADD COLUMN IF NOT EXISTS "human_decision" text;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD COLUMN IF NOT EXISTS "human_notes" text;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD COLUMN IF NOT EXISTS "human_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD COLUMN IF NOT EXISTS "human_reviewed_by" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_drafts" ADD CONSTRAINT "email_draft_human_decision_ck" CHECK (human_decision IS NULL OR human_decision IN ('APPROVED','REJECTED'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
