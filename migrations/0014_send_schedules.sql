ALTER TABLE "lead_facts" DROP CONSTRAINT IF EXISTS "lead_facts_fact_type_ck";--> statement-breakpoint
ALTER TABLE "lead_facts" ADD CONSTRAINT "lead_facts_fact_type_ck" CHECK (fact_type IN ('business_name','official_domain','official_website_url','official_location_page_url','domain','phone','contact_email','contact_form_url','formatted_address','latitude','longitude','city','country','category','rating','review_count','business_status','ownership_type','services','opening_hours','booking_url','contact_timezone'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "send_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"gmail_draft_id" text NOT NULL,
	"provider_draft_id" text NOT NULL,
	"finalized_content_hash" text NOT NULL,
	"recipient_email" text NOT NULL,
	"scheduled_at_utc" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"rules_version" text NOT NULL,
	"computed_from" jsonb NOT NULL,
	"integrity_fingerprint" text NOT NULL,
	"origin" text NOT NULL,
	"status" text NOT NULL,
	"superseded_by_id" text,
	"cancel_reason" text,
	"reschedule_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "send_schedule_status_ck" CHECK (status IN ('SCHEDULED','CANCELLED','SUPERSEDED'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "send_schedules" ADD CONSTRAINT "send_schedules_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "send_schedules" ADD CONSTRAINT "send_schedules_gmail_draft_id_gmail_drafts_id_fk" FOREIGN KEY ("gmail_draft_id") REFERENCES "gmail_drafts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "send_schedules_lead_idx" ON "send_schedules" ("lead_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "send_schedules_active_uk" ON "send_schedules" ("gmail_draft_id") WHERE "status" = 'SCHEDULED';
