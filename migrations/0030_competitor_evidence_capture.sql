-- Phase 7A2: competitor website evidence capture. Additive only. No existing table is altered
-- destructively; the single ALTER below widens an existing CHECK to add one enum value.

-- Additively widen the shared capture-purpose vocabulary with COMPETITOR_CAPTURE. The lead-bound
-- website_capture_runs never emits it; competitor evidence uses the dedicated tables below. The value
-- is centralized here so the purpose vocabulary stays single-sourced.
ALTER TABLE "website_capture_runs" DROP CONSTRAINT "capture_purpose_ck";--> statement-breakpoint
ALTER TABLE "website_capture_runs" ADD CONSTRAINT "capture_purpose_ck" CHECK (purpose IN ('AUDIT_CAPTURE','VERIFICATION_CAPTURE','COMPETITOR_CAPTURE'));--> statement-breakpoint

CREATE TABLE "competitor_capture_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL,
  "research_run_id" text NOT NULL,
  "provider" text NOT NULL,
  "method" text NOT NULL,
  "purpose" text DEFAULT 'COMPETITOR_CAPTURE' NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "outcome" text NOT NULL,
  "rules_version" text NOT NULL,
  "version" integer NOT NULL,
  "input_hash" text NOT NULL,
  "config_hash" text NOT NULL,
  "content_hash" text NOT NULL,
  "competitor_count" integer NOT NULL,
  "page_count" integer NOT NULL,
  "evidence_count" integer NOT NULL,
  "active_evidence_count" integer NOT NULL,
  "withheld_evidence_count" integer NOT NULL,
  "max_pages" integer NOT NULL,
  "max_depth" integer NOT NULL,
  "superseded_by" text,
  "started_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "competitor_capture_runs_provider_ck" CHECK (provider IN ('fixture','playwright')),
  CONSTRAINT "competitor_capture_runs_method_ck" CHECK (method IN ('FIXTURE','LIVE_BROWSER')),
  CONSTRAINT "competitor_capture_runs_purpose_ck" CHECK (purpose = 'COMPETITOR_CAPTURE'),
  CONSTRAINT "competitor_capture_runs_status_ck" CHECK (status IN ('DRAFT','SUPERSEDED')),
  CONSTRAINT "competitor_capture_runs_outcome_ck" CHECK (outcome IN ('CAPTURED','PARTIAL','NO_ELIGIBLE_COMPETITORS','ALL_INACCESSIBLE','GUARD_FAILED'))
);--> statement-breakpoint
CREATE TABLE "competitor_captured_pages" (
  "id" text PRIMARY KEY NOT NULL,
  "capture_run_id" text NOT NULL,
  "competitor_candidate_id" text NOT NULL,
  "requested_url" text NOT NULL,
  "final_url" text NOT NULL,
  "normalized_origin" text NOT NULL,
  "role" text NOT NULL,
  "profile" text NOT NULL,
  "ok" boolean NOT NULL,
  "http_status" integer,
  "error_kinds" jsonb NOT NULL,
  "raw_dom_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "competitor_captured_pages_profile_ck" CHECK (profile IN ('desktop','mobile'))
);--> statement-breakpoint
CREATE TABLE "competitor_evidence_items" (
  "id" text PRIMARY KEY NOT NULL,
  "capture_run_id" text NOT NULL,
  "competitor_candidate_id" text NOT NULL,
  "evidence_category" text NOT NULL,
  "observation_kind" text NOT NULL,
  "observation" text NOT NULL,
  "source_page_url" text NOT NULL,
  "normalized_origin" text NOT NULL,
  "selector" text,
  "source_excerpt" text,
  "profile" text NOT NULL,
  "numeric_value" integer,
  "confidence" text NOT NULL,
  "freshness_status" text NOT NULL,
  "withholding_reason" text,
  "safe_for_outreach" boolean NOT NULL,
  "active" boolean NOT NULL,
  "capture_method" text NOT NULL,
  "provider" text NOT NULL,
  "rules_version" text NOT NULL,
  "captured_at" timestamp with time zone NOT NULL,
  "evidence_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "competitor_evidence_items_category_ck" CHECK (evidence_category IN ('BOOKING_CTA_VISIBLE','PHONE_VISIBLE','WHATSAPP_OR_DIRECT_MESSAGE_VISIBLE','MOBILE_STICKY_CONTACT_CONTROL','SERVICE_INFORMATION_VISIBLE','LOCATION_VISIBLE','OPENING_HOURS_VISIBLE','TEAM_OR_PRACTITIONER_INFORMATION','ON_SITE_TESTIMONIAL_OR_REVIEW_SECTION','PRICING_OR_FINANCING_INFORMATION','EMERGENCY_OR_URGENT_SERVICE_MESSAGE','LANGUAGE_SUPPORT_VISIBLE','FAQ_CONTENT_VISIBLE','MOBILE_NAVIGATION_DEPTH','CONTACT_PATH_DEPTH')),
  CONSTRAINT "competitor_evidence_items_kind_ck" CHECK (observation_kind IN ('DIRECT_OBSERVATION','DETERMINISTIC_INTERPRETATION','UNSUPPORTED_INFERENCE')),
  CONSTRAINT "competitor_evidence_items_confidence_ck" CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  CONSTRAINT "competitor_evidence_items_freshness_ck" CHECK (freshness_status IN ('FRESH','STALE','UNREPRODUCIBLE')),
  CONSTRAINT "competitor_evidence_items_profile_ck" CHECK (profile IN ('desktop','mobile'))
);--> statement-breakpoint
ALTER TABLE "competitor_capture_runs" ADD CONSTRAINT "competitor_capture_runs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_capture_runs" ADD CONSTRAINT "competitor_capture_runs_research_run_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."competitor_research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_captured_pages" ADD CONSTRAINT "competitor_captured_pages_capture_run_id_fk" FOREIGN KEY ("capture_run_id") REFERENCES "public"."competitor_capture_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_captured_pages" ADD CONSTRAINT "competitor_captured_pages_competitor_candidate_id_fk" FOREIGN KEY ("competitor_candidate_id") REFERENCES "public"."competitor_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_evidence_items" ADD CONSTRAINT "competitor_evidence_items_capture_run_id_fk" FOREIGN KEY ("capture_run_id") REFERENCES "public"."competitor_capture_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_evidence_items" ADD CONSTRAINT "competitor_evidence_items_competitor_candidate_id_fk" FOREIGN KEY ("competitor_candidate_id") REFERENCES "public"."competitor_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_capture_runs_lead_idx" ON "competitor_capture_runs" ("lead_id");--> statement-breakpoint
CREATE INDEX "competitor_capture_runs_research_idx" ON "competitor_capture_runs" ("research_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_capture_runs_idempotency_uk" ON "competitor_capture_runs" ("research_run_id","input_hash","config_hash","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_capture_runs_version_uk" ON "competitor_capture_runs" ("research_run_id","version");--> statement-breakpoint
CREATE INDEX "competitor_captured_pages_run_idx" ON "competitor_captured_pages" ("capture_run_id");--> statement-breakpoint
CREATE INDEX "competitor_captured_pages_competitor_idx" ON "competitor_captured_pages" ("competitor_candidate_id");--> statement-breakpoint
CREATE INDEX "competitor_evidence_items_run_idx" ON "competitor_evidence_items" ("capture_run_id");--> statement-breakpoint
CREATE INDEX "competitor_evidence_items_competitor_idx" ON "competitor_evidence_items" ("capture_run_id","competitor_candidate_id");--> statement-breakpoint
CREATE INDEX "competitor_evidence_items_active_idx" ON "competitor_evidence_items" ("capture_run_id","active");
