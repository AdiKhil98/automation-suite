CREATE TABLE "capture_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"captured_page_id" text NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"kind" text NOT NULL,
	"profile" text NOT NULL,
	CONSTRAINT "capture_artifact_kind_ck" CHECK ("capture_artifacts"."kind" IN ('viewport','fullpage')),
	CONSTRAINT "capture_artifact_profile_ck" CHECK ("capture_artifacts"."profile" IN ('desktop','mobile')),
	CONSTRAINT "capture_artifact_size_ck" CHECK ("capture_artifacts"."bytes" >= 0 AND "capture_artifacts"."width" >= 0 AND "capture_artifacts"."height" >= 0)
);
--> statement-breakpoint
CREATE TABLE "capture_errors" (
	"id" text PRIMARY KEY NOT NULL,
	"capture_run_id" text NOT NULL,
	"captured_page_id" text,
	"page_url" text,
	"profile" text,
	"kind" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "capture_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"captured_page_id" text NOT NULL,
	"evidence_type" text NOT NULL,
	"source_url" text,
	"profile" text NOT NULL,
	"selector" text,
	"extracted_value" text,
	"normalized_value" text,
	CONSTRAINT "capture_evidence_type_ck" CHECK (evidence_type IN ('title','meta_description','lang','canonical','heading','nav_label','cta','link','mailto','tel','form','image_alt','structured_data','footer_legal','horizontal_overflow')),
	CONSTRAINT "capture_evidence_profile_ck" CHECK ("capture_evidence"."profile" IN ('desktop','mobile'))
);
--> statement-breakpoint
CREATE TABLE "captured_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"capture_run_id" text NOT NULL,
	"requested_url" text NOT NULL,
	"final_url" text,
	"canonical_url" text,
	"http_status" integer,
	"role" text,
	"profile" text NOT NULL,
	"ok" boolean NOT NULL,
	"load_ms" integer,
	"has_horizontal_overflow" boolean DEFAULT false NOT NULL,
	"raw_dom_hash" text,
	CONSTRAINT "captured_page_profile_ck" CHECK ("captured_pages"."profile" IN ('desktop','mobile'))
);
--> statement-breakpoint
CREATE TABLE "website_capture_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"run_id" text NOT NULL,
	"purpose" text NOT NULL,
	"outcome" text NOT NULL,
	"primary_url" text,
	"source_enrichment_candidate_id" text,
	"desktop_primary_complete" boolean DEFAULT false NOT NULL,
	"mobile_primary_complete" boolean DEFAULT false NOT NULL,
	"secondary_pages_attempted" integer DEFAULT 0 NOT NULL,
	"secondary_pages_completed" integer DEFAULT 0 NOT NULL,
	"partial_reason" text,
	"normalized_evidence_fingerprint" text,
	"playwright_version" text,
	"browser" text,
	"browser_version" text,
	"chromium_revision" text,
	"docker_image_tag" text,
	"emulation_profile_version" text,
	"page_selection_policy_version" text,
	"extractor_version" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "capture_purpose_ck" CHECK (purpose IN ('AUDIT_CAPTURE','VERIFICATION_CAPTURE')),
	CONSTRAINT "capture_outcome_ck" CHECK (outcome IN ('CAPTURED','PARTIAL_CAPTURE','BROWSER_BLOCKED','BOT_CHALLENGE','AUTH_REQUIRED','NO_RENDERABLE_CONTENT','TRANSIENT_ERROR','POLICY_BLOCKED','INVALID_TARGET')),
	CONSTRAINT "capture_sec_attempted_ck" CHECK ("website_capture_runs"."secondary_pages_attempted" >= 0),
	CONSTRAINT "capture_sec_completed_ck" CHECK ("website_capture_runs"."secondary_pages_completed" >= 0)
);
--> statement-breakpoint
ALTER TABLE "capture_artifacts" ADD CONSTRAINT "capture_artifacts_captured_page_id_captured_pages_id_fk" FOREIGN KEY ("captured_page_id") REFERENCES "public"."captured_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_errors" ADD CONSTRAINT "capture_errors_capture_run_id_website_capture_runs_id_fk" FOREIGN KEY ("capture_run_id") REFERENCES "public"."website_capture_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_errors" ADD CONSTRAINT "capture_errors_captured_page_id_captured_pages_id_fk" FOREIGN KEY ("captured_page_id") REFERENCES "public"."captured_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_evidence" ADD CONSTRAINT "capture_evidence_captured_page_id_captured_pages_id_fk" FOREIGN KEY ("captured_page_id") REFERENCES "public"."captured_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captured_pages" ADD CONSTRAINT "captured_pages_capture_run_id_website_capture_runs_id_fk" FOREIGN KEY ("capture_run_id") REFERENCES "public"."website_capture_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_capture_runs" ADD CONSTRAINT "website_capture_runs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_capture_runs" ADD CONSTRAINT "website_capture_runs_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_capture_runs" ADD CONSTRAINT "website_capture_runs_source_enrichment_candidate_id_enrichment_candidates_id_fk" FOREIGN KEY ("source_enrichment_candidate_id") REFERENCES "public"."enrichment_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capture_artifacts_page_idx" ON "capture_artifacts" USING btree ("captured_page_id");--> statement-breakpoint
CREATE INDEX "capture_artifacts_sha_idx" ON "capture_artifacts" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "capture_errors_run_idx" ON "capture_errors" USING btree ("capture_run_id");--> statement-breakpoint
CREATE INDEX "capture_evidence_page_idx" ON "capture_evidence" USING btree ("captured_page_id");--> statement-breakpoint
CREATE INDEX "captured_pages_run_idx" ON "captured_pages" USING btree ("capture_run_id");--> statement-breakpoint
CREATE INDEX "website_capture_runs_lead_idx" ON "website_capture_runs" USING btree ("lead_id");