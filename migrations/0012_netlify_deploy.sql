CREATE TABLE IF NOT EXISTS "demo_deployment_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"demo_id" text NOT NULL,
	"original_email_draft_id" text,
	"provider" text NOT NULL,
	"site_id" text NOT NULL,
	"deploy_id" text,
	"artifact_hash" text NOT NULL,
	"attempt_fingerprint" text NOT NULL,
	"outcome" text NOT NULL,
	"draft_url" text,
	"permalink_url" text,
	"verified_url" text,
	"verification_result" jsonb,
	"error_class" text,
	"calls_made" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_draft_finalizations" (
	"id" text PRIMARY KEY NOT NULL,
	"original_draft_id" text NOT NULL,
	"deployment_run_id" text NOT NULL,
	"verified_deployment_url" text NOT NULL,
	"original_body_hash" text NOT NULL,
	"resolved_body" text NOT NULL,
	"resolved_body_hash" text NOT NULL,
	"finalized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"final_human_decision" text,
	"final_human_notes" text,
	"final_reviewed_at" timestamp with time zone,
	"final_reviewed_by" text,
	"final_reviewed_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_finalization_decision_ck" CHECK (final_human_decision IS NULL OR final_human_decision IN ('APPROVED','REJECTED'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demo_deployment_runs" ADD CONSTRAINT "demo_deployment_runs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demo_deployment_runs" ADD CONSTRAINT "demo_deployment_runs_demo_id_demos_id_fk" FOREIGN KEY ("demo_id") REFERENCES "demos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "demo_deployment_runs" ADD CONSTRAINT "demo_deployment_runs_original_email_draft_id_email_drafts_id_fk" FOREIGN KEY ("original_email_draft_id") REFERENCES "email_drafts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_draft_finalizations" ADD CONSTRAINT "email_draft_finalizations_original_draft_id_email_drafts_id_fk" FOREIGN KEY ("original_draft_id") REFERENCES "email_drafts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_draft_finalizations" ADD CONSTRAINT "email_draft_finalizations_deployment_run_id_demo_deployment_runs_id_fk" FOREIGN KEY ("deployment_run_id") REFERENCES "demo_deployment_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_deployment_runs_lead_idx" ON "demo_deployment_runs" ("lead_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "demo_deployment_runs_deploy_uk" ON "demo_deployment_runs" ("provider","deploy_id") WHERE "deploy_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "demo_deployment_runs_verified_artifact_uk" ON "demo_deployment_runs" ("site_id","artifact_hash") WHERE "outcome" = 'DEPLOYED_AND_VERIFIED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_draft_finalizations_draft_idx" ON "email_draft_finalizations" ("original_draft_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_draft_finalizations_draft_deploy_uk" ON "email_draft_finalizations" ("original_draft_id","deployment_run_id");
