CREATE TABLE "enrichment_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"run_id" text NOT NULL,
	"outcome" text NOT NULL,
	"chosen_domain" text,
	"chosen_website_url" text,
	"chosen_location_page_url" text,
	"confidence" double precision,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"context_provider" text,
	"candidate_provider" text,
	"notes" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "enrichment_outcome_ck" CHECK (outcome IN ('VERIFIED','AMBIGUOUS','INSUFFICIENT_CONTEXT','NO_CANDIDATE','NO_VERIFIED_CANDIDATE','BROWSER_REQUIRED','TRANSIENT_ERROR','POLICY_BLOCKED','INVALID_INPUT')),
	CONSTRAINT "enrichment_candidate_count_ck" CHECK ("enrichment_attempts"."candidate_count" >= 0),
	CONSTRAINT "enrichment_attempt_confidence_ck" CHECK ("enrichment_attempts"."confidence" IS NULL OR ("enrichment_attempts"."confidence" >= 0 AND "enrichment_attempts"."confidence" <= 1)),
	CONSTRAINT "enrichment_chosen_only_verified_ck" CHECK ("enrichment_attempts"."outcome" = 'VERIFIED' OR ("enrichment_attempts"."chosen_domain" IS NULL AND "enrichment_attempts"."chosen_website_url" IS NULL AND "enrichment_attempts"."chosen_location_page_url" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "enrichment_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"discovered_url" text NOT NULL,
	"final_url" text,
	"host" text,
	"http_status" integer,
	"discovery_source" text,
	"is_directory" boolean,
	"decision" text NOT NULL,
	"confidence" double precision,
	"rejected_reason" text,
	CONSTRAINT "enrichment_candidate_decision_ck" CHECK ("enrichment_candidates"."decision" IN ('VERIFIED','REJECTED','AMBIGUOUS')),
	CONSTRAINT "enrichment_discovery_source_ck" CHECK (discovery_source IS NULL OR discovery_source IN ('website_hint','directory','search','social','google_hint','manual','mock')),
	CONSTRAINT "enrichment_candidate_confidence_ck" CHECK ("enrichment_candidates"."confidence" IS NULL OR ("enrichment_candidates"."confidence" >= 0 AND "enrichment_candidates"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "enrichment_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"matched_fact_id" text,
	"signal_type" text NOT NULL,
	"page_url" text NOT NULL,
	"extracted_value" text,
	"normalized_value" text,
	"selector" text,
	"confidence" double precision,
	CONSTRAINT "enrichment_signal_type_ck" CHECK (signal_type IN ('exact_phone','name_address','branch_location','structured_data','legal_footer','name_tokens','category_text','city_mention','mailto','plaintext_email','contact_form')),
	CONSTRAINT "enrichment_signal_confidence_ck" CHECK ("enrichment_signals"."confidence" IS NULL OR ("enrichment_signals"."confidence" >= 0 AND "enrichment_signals"."confidence" <= 1))
);
--> statement-breakpoint
ALTER TABLE "lead_facts" DROP CONSTRAINT "lead_facts_fact_type_ck";--> statement-breakpoint
ALTER TABLE "enrichment_attempts" ADD CONSTRAINT "enrichment_attempts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_attempts" ADD CONSTRAINT "enrichment_attempts_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_candidates" ADD CONSTRAINT "enrichment_candidates_attempt_id_enrichment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."enrichment_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_signals" ADD CONSTRAINT "enrichment_signals_candidate_id_enrichment_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."enrichment_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_signals" ADD CONSTRAINT "enrichment_signals_matched_fact_id_lead_facts_id_fk" FOREIGN KEY ("matched_fact_id") REFERENCES "public"."lead_facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrichment_attempts_lead_idx" ON "enrichment_attempts" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "enrichment_candidates_attempt_idx" ON "enrichment_candidates" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "enrichment_signals_candidate_idx" ON "enrichment_signals" USING btree ("candidate_id");--> statement-breakpoint
ALTER TABLE "lead_facts" ADD CONSTRAINT "lead_facts_fact_type_ck" CHECK (fact_type IN ('business_name', 'official_domain', 'official_website_url', 'official_location_page_url', 'domain', 'phone', 'contact_email', 'contact_form_url', 'formatted_address', 'latitude', 'longitude', 'city', 'country', 'category', 'rating', 'review_count', 'business_status', 'ownership_type'));