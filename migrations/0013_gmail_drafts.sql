CREATE TABLE IF NOT EXISTS "gmail_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"finalized_email_id" text,
	"recipient_email" text NOT NULL,
	"sender_email" text NOT NULL,
	"gmail_account" text NOT NULL,
	"provider" text NOT NULL,
	"provider_draft_id" text,
	"thread_id" text,
	"message_id" text,
	"idempotency_fingerprint" text NOT NULL,
	"source_email_version" text NOT NULL,
	"outcome" text NOT NULL,
	"error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_drafts" ADD CONSTRAINT "gmail_drafts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gmail_drafts" ADD CONSTRAINT "gmail_drafts_finalized_email_id_email_draft_finalizations_id_fk" FOREIGN KEY ("finalized_email_id") REFERENCES "email_draft_finalizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gmail_drafts_lead_idx" ON "gmail_drafts" ("lead_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gmail_drafts_fingerprint_uk" ON "gmail_drafts" ("gmail_account","idempotency_fingerprint");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gmail_drafts_provider_draft_uk" ON "gmail_drafts" ("provider","provider_draft_id") WHERE "provider_draft_id" IS NOT NULL;
