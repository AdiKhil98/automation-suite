CREATE TABLE IF NOT EXISTS "email_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"demo_id" text,
	"run_id" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"cta_kind" text NOT NULL,
	"has_demo_url_placeholder" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"writer_prompt_version" text NOT NULL,
	"reviewer_prompt_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"rules_version" text NOT NULL,
	"provider" text NOT NULL,
	"requested_writer_model" text NOT NULL,
	"requested_reviewer_model" text NOT NULL,
	"writer_response_id" text,
	"reviewer_response_id" text,
	"reviewer_decision" text,
	"fabrication_risk" boolean,
	"personalization_supported" boolean,
	"claim_honest" boolean,
	"reviewer_problems" jsonb,
	"total_cost_usd" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_draft_status_ck" CHECK (status IN ('DRAFTED','APPROVED','REVIEW_FAILED'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_fact_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"email_id" text NOT NULL,
	"lead_fact_id" text NOT NULL,
	"field" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_finding_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"email_id" text NOT NULL,
	"audit_finding_id" text NOT NULL,
	"directive" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_demo_id_demos_id_fk" FOREIGN KEY ("demo_id") REFERENCES "demos"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "pipeline_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_fact_inputs" ADD CONSTRAINT "email_fact_inputs_email_id_email_drafts_id_fk" FOREIGN KEY ("email_id") REFERENCES "email_drafts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_fact_inputs" ADD CONSTRAINT "email_fact_inputs_lead_fact_id_lead_facts_id_fk" FOREIGN KEY ("lead_fact_id") REFERENCES "lead_facts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_finding_inputs" ADD CONSTRAINT "email_finding_inputs_email_id_email_drafts_id_fk" FOREIGN KEY ("email_id") REFERENCES "email_drafts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_finding_inputs" ADD CONSTRAINT "email_finding_inputs_audit_finding_id_audit_findings_id_fk" FOREIGN KEY ("audit_finding_id") REFERENCES "audit_findings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_drafts_lead_idx" ON "email_drafts" ("lead_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_fact_inputs_email_idx" ON "email_fact_inputs" ("email_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_finding_inputs_email_idx" ON "email_finding_inputs" ("email_id");
