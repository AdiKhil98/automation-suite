CREATE TABLE "audit_finding_evidence" (
	"audit_finding_id" text NOT NULL,
	"capture_evidence_id" text NOT NULL,
	CONSTRAINT "audit_finding_evidence_audit_finding_id_capture_evidence_id_pk" PRIMARY KEY("audit_finding_id","capture_evidence_id")
);
--> statement-breakpoint
CREATE TABLE "audit_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_run_id" text NOT NULL,
	"finding_ref" text NOT NULL,
	"category" text NOT NULL,
	"observation" text NOT NULL,
	"affected_urls" jsonb NOT NULL,
	"affected_profiles" jsonb NOT NULL,
	"severity" text NOT NULL,
	"confidence" double precision NOT NULL,
	"business_impact" text NOT NULL,
	"recommendation" text NOT NULL,
	"safe_for_outreach" boolean NOT NULL,
	"outreach_angle" text,
	"uncertainty" text,
	"review_decision" text NOT NULL,
	CONSTRAINT "audit_finding_category_ck" CHECK (category IN ('CTA_CLARITY','BOOKING_FRICTION','CONTACT_FRICTION','MOBILE_USABILITY','SERVICE_CLARITY','TRUST_SIGNALS','SOCIAL_PROOF','NAVIGATION','READABILITY','LOCAL_INFORMATION','VISUAL_HIERARCHY','TECHNICAL_RENDERING','ACCESSIBILITY_INDICATOR','DESKTOP_MOBILE_CONSISTENCY','OTHER')),
	CONSTRAINT "audit_finding_severity_ck" CHECK ("audit_findings"."severity" IN ('LOW','MEDIUM','HIGH')),
	CONSTRAINT "audit_finding_confidence_ck" CHECK ("audit_findings"."confidence" >= 0 AND "audit_findings"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "audit_review_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_review_id" text NOT NULL,
	"finding_ref" text NOT NULL,
	"decision" text NOT NULL,
	"evidence_supported" boolean NOT NULL,
	"impact_supported" boolean NOT NULL,
	"safe_for_outreach" boolean NOT NULL,
	"problems" jsonb NOT NULL,
	"revised_observation" text,
	"revised_business_impact" text,
	"revised_recommendation" text,
	"revised_outreach_angle" text
);
--> statement-breakpoint
CREATE TABLE "audit_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_run_id" text NOT NULL,
	"overall_decision" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"run_id" text,
	"capture_run_id" text,
	"outcome" text NOT NULL,
	"rubric_version" text NOT NULL,
	"generator_prompt_version" text NOT NULL,
	"reviewer_prompt_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"opportunity_rules_version" text NOT NULL,
	"opportunity_rules_hash" text NOT NULL,
	"provider" text NOT NULL,
	"requested_audit_model" text NOT NULL,
	"resolved_audit_model" text,
	"reasoning_effort" text NOT NULL,
	"reasoning_mode" text NOT NULL,
	"image_detail" text NOT NULL,
	"response_store" boolean NOT NULL,
	"input_fingerprint" text NOT NULL,
	"generator_response_id" text,
	"reviewer_response_id" text,
	"total_input_tokens" integer DEFAULT 0 NOT NULL,
	"total_output_tokens" integer DEFAULT 0 NOT NULL,
	"total_cost_usd" double precision DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "audit_outcome_ck" CHECK (outcome IN ('AUDITED','AUDITED_NO_ACTIONABLE_FINDINGS','INSUFFICIENT_EVIDENCE','CAPTURE_CONFLICT','MODEL_REFUSAL','SCHEMA_INVALID','VALIDATION_FAILED','INPUT_TOO_LARGE','TRANSIENT_PROVIDER_ERROR','RATE_LIMITED','BUDGET_BLOCKED','MANUAL_REVIEW_REQUIRED'))
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_run_id" text,
	"lead_id" text,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"requested_model" text NOT NULL,
	"resolved_model" text,
	"prompt_version" text,
	"schema_version" text,
	"request_id" text,
	"response_id" text,
	"input_tokens" integer,
	"cached_input_tokens" integer,
	"cache_write_tokens" integer,
	"output_tokens" integer,
	"reasoning_tokens" integer,
	"estimated_cost_usd" double precision,
	"latency_ms" integer,
	"status" text NOT NULL,
	"classification" text,
	"retry_number" integer DEFAULT 0 NOT NULL,
	"image_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_run_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"conversion_score" integer NOT NULL,
	"mobile_score" integer NOT NULL,
	"trust_score" integer NOT NULL,
	"contactability_score" integer NOT NULL,
	"overall_score" integer NOT NULL,
	"rules_version" text NOT NULL,
	"rules_hash" text NOT NULL,
	"breakdown" jsonb NOT NULL,
	"caps_applied" jsonb NOT NULL,
	CONSTRAINT "opportunity_score_ck" CHECK ("opportunity_assessments"."conversion_score" >= 0 AND "opportunity_assessments"."conversion_score" <= 100 AND "opportunity_assessments"."mobile_score" >= 0 AND "opportunity_assessments"."mobile_score" <= 100 AND "opportunity_assessments"."trust_score" >= 0 AND "opportunity_assessments"."trust_score" <= 100 AND "opportunity_assessments"."contactability_score" >= 0 AND "opportunity_assessments"."contactability_score" <= 100 AND "opportunity_assessments"."overall_score" >= 0 AND "opportunity_assessments"."overall_score" <= 100)
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"role" text NOT NULL,
	"rubric_version" text,
	"schema_version" text,
	"model_family" text,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_finding_evidence" ADD CONSTRAINT "audit_finding_evidence_audit_finding_id_audit_findings_id_fk" FOREIGN KEY ("audit_finding_id") REFERENCES "public"."audit_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_finding_evidence" ADD CONSTRAINT "audit_finding_evidence_capture_evidence_id_capture_evidence_id_fk" FOREIGN KEY ("capture_evidence_id") REFERENCES "public"."capture_evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_audit_run_id_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."audit_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_review_findings" ADD CONSTRAINT "audit_review_findings_audit_review_id_audit_reviews_id_fk" FOREIGN KEY ("audit_review_id") REFERENCES "public"."audit_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_reviews" ADD CONSTRAINT "audit_reviews_audit_run_id_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."audit_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_capture_run_id_website_capture_runs_id_fk" FOREIGN KEY ("capture_run_id") REFERENCES "public"."website_capture_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_audit_run_id_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."audit_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_assessments" ADD CONSTRAINT "opportunity_assessments_audit_run_id_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."audit_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_assessments" ADD CONSTRAINT "opportunity_assessments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_findings_run_idx" ON "audit_findings" USING btree ("audit_run_id");--> statement-breakpoint
CREATE INDEX "audit_runs_lead_idx" ON "audit_runs" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "model_calls_run_idx" ON "model_calls" USING btree ("audit_run_id");--> statement-breakpoint
CREATE INDEX "opportunity_assessments_run_idx" ON "opportunity_assessments" USING btree ("audit_run_id");