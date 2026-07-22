CREATE TABLE "controlled_test_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "prospect_run_id" text NOT NULL,
  "pipeline_run_id" text NOT NULL,
  "lead_id" text NOT NULL,
  "recipient_email" text NOT NULL,
  "recipient_fingerprint" text NOT NULL,
  "recipient_env_name" text NOT NULL,
  "actor" text DEFAULT 'SYSTEM_CONTROLLED_TEST' NOT NULL,
  "reason" text NOT NULL,
  "status" text DEFAULT 'RUNNING' NOT NULL,
  "sendable" boolean DEFAULT false NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "controlled_test_runs_status_ck" CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  CONSTRAINT "controlled_test_runs_actor_ck" CHECK (actor = 'SYSTEM_CONTROLLED_TEST'),
  CONSTRAINT "controlled_test_runs_reason_ck" CHECK (reason = 'operator-controlled end-to-end validation'),
  CONSTRAINT "controlled_test_runs_not_sendable_ck" CHECK (sendable = false),
  CONSTRAINT "controlled_test_runs_recipient_env_ck" CHECK (recipient_env_name = 'TEST_RECIPIENT_EMAIL')
);--> statement-breakpoint
ALTER TABLE "controlled_test_runs" ADD CONSTRAINT "controlled_test_runs_prospect_run_id_prospect_runs_id_fk" FOREIGN KEY ("prospect_run_id") REFERENCES "public"."prospect_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_test_runs" ADD CONSTRAINT "controlled_test_runs_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_test_runs" ADD CONSTRAINT "controlled_test_runs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "controlled_test_runs_prospect_run_uk" ON "controlled_test_runs" ("prospect_run_id");--> statement-breakpoint
CREATE INDEX "controlled_test_runs_lead_idx" ON "controlled_test_runs" ("lead_id");--> statement-breakpoint

CREATE TABLE "controlled_test_artifact_approvals" (
  "id" text PRIMARY KEY NOT NULL,
  "controlled_test_run_id" text NOT NULL,
  "lead_id" text NOT NULL,
  "artifact_type" text NOT NULL,
  "artifact_id" text NOT NULL,
  "artifact_hash" text NOT NULL,
  "actor" text DEFAULT 'SYSTEM_CONTROLLED_TEST' NOT NULL,
  "reason" text NOT NULL,
  "recipient_fingerprint" text NOT NULL,
  "approved_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "controlled_test_artifact_approvals_type_ck" CHECK (artifact_type IN ('DEMO','EMAIL_DRAFT','FINALIZED_EMAIL')),
  CONSTRAINT "controlled_test_artifact_approvals_actor_ck" CHECK (actor = 'SYSTEM_CONTROLLED_TEST'),
  CONSTRAINT "controlled_test_artifact_approvals_reason_ck" CHECK (reason = 'operator-controlled end-to-end validation')
);--> statement-breakpoint
ALTER TABLE "controlled_test_artifact_approvals" ADD CONSTRAINT "controlled_test_artifact_approvals_run_id_fk" FOREIGN KEY ("controlled_test_run_id") REFERENCES "public"."controlled_test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_test_artifact_approvals" ADD CONSTRAINT "controlled_test_artifact_approvals_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "controlled_test_artifact_approvals_artifact_uk" ON "controlled_test_artifact_approvals" ("controlled_test_run_id","artifact_type","artifact_id");--> statement-breakpoint
CREATE INDEX "controlled_test_artifact_approvals_run_idx" ON "controlled_test_artifact_approvals" ("controlled_test_run_id");--> statement-breakpoint

CREATE TABLE "controlled_test_evaluations" (
  "id" text PRIMARY KEY NOT NULL,
  "controlled_test_run_id" text NOT NULL,
  "lead_id" text NOT NULL,
  "gmail_draft_id" text,
  "schedule_id" text,
  "evaluation_type" text NOT NULL,
  "outcome" text DEFAULT 'CONTROLLED_TEST_NOT_SENDABLE' NOT NULL,
  "report" jsonb NOT NULL,
  "sendable" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "controlled_test_evaluations_type_ck" CHECK (evaluation_type IN ('READINESS','DRY_RUN')),
  CONSTRAINT "controlled_test_evaluations_outcome_ck" CHECK (outcome = 'CONTROLLED_TEST_NOT_SENDABLE'),
  CONSTRAINT "controlled_test_evaluations_not_sendable_ck" CHECK (sendable = false)
);--> statement-breakpoint
ALTER TABLE "controlled_test_evaluations" ADD CONSTRAINT "controlled_test_evaluations_run_id_fk" FOREIGN KEY ("controlled_test_run_id") REFERENCES "public"."controlled_test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_test_evaluations" ADD CONSTRAINT "controlled_test_evaluations_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_test_evaluations" ADD CONSTRAINT "controlled_test_evaluations_gmail_draft_id_fk" FOREIGN KEY ("gmail_draft_id") REFERENCES "public"."gmail_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlled_test_evaluations" ADD CONSTRAINT "controlled_test_evaluations_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."send_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "controlled_test_evaluations_run_type_uk" ON "controlled_test_evaluations" ("controlled_test_run_id","evaluation_type");
