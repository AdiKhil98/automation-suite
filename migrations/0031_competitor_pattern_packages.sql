-- Phase 7A3A: deterministic competitor pattern packages. Additive only — no existing table is
-- altered. Immutable/versioned: packages are inserted, prior DRAFT packages for a lead are marked
-- SUPERSEDED (never deleted); identical (lead_id,input_hash,config_hash) reuses the existing package
-- via the idempotency unique index. No AI, no email, no Gmail/Sheets, no sending path exists here.

CREATE TABLE "competitor_pattern_packages" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL,
  "research_run_id" text NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "version" integer NOT NULL,
  "input_hash" text NOT NULL,
  "config_hash" text NOT NULL,
  "package_hash" text NOT NULL,
  "rules_version" text NOT NULL,
  "confidence" text NOT NULL,
  "freshness_evaluated_at" timestamp with time zone NOT NULL,
  "selected_competitor_ids" jsonb NOT NULL,
  "capture_run_ids" jsonb NOT NULL,
  "eligible_evidence_count" integer NOT NULL,
  "excluded_evidence_count" integer NOT NULL,
  "exclusion_reasons" jsonb NOT NULL,
  "prohibited_claims" jsonb NOT NULL,
  -- Approval / rejection / invalidation / supersession metadata (immutable history; append-only).
  "approved_by" text,
  "approved_at" timestamp with time zone,
  "rejected_by" text,
  "rejected_at" timestamp with time zone,
  "invalidated_by" text,
  "invalidated_at" timestamp with time zone,
  "superseded_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "competitor_pattern_packages_status_ck" CHECK (status IN ('DRAFT','REVIEWED','APPROVED','REJECTED','SUPERSEDED','INVALIDATED')),
  CONSTRAINT "competitor_pattern_packages_confidence_ck" CHECK (confidence IN ('HIGH','MEDIUM','LOW'))
);--> statement-breakpoint
ALTER TABLE "competitor_pattern_packages" ADD CONSTRAINT "competitor_pattern_packages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_pattern_packages" ADD CONSTRAINT "competitor_pattern_packages_research_run_id_competitor_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "competitor_research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_pattern_packages_lead_idx" ON "competitor_pattern_packages" ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_pattern_packages_idempotency_uk" ON "competitor_pattern_packages" ("lead_id","input_hash","config_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_pattern_packages_version_uk" ON "competitor_pattern_packages" ("lead_id","version");--> statement-breakpoint

CREATE TABLE "competitor_patterns" (
  "id" text PRIMARY KEY NOT NULL,
  "package_id" text NOT NULL,
  "category" text NOT NULL,
  "result" text NOT NULL,
  "present_count" integer NOT NULL,
  "absent_count" integer NOT NULL,
  "unknown_count" integer NOT NULL,
  "usable_denominator" integer NOT NULL,
  "total_selected" integer NOT NULL,
  "participating_competitor_ids" jsonb NOT NULL,
  "evidence_item_ids" jsonb NOT NULL,
  "confidence" text NOT NULL,
  "wording_form" text NOT NULL,
  "wording_text" text,
  "consequence_label" text,
  "numeric_median" double precision,
  "numeric_values" jsonb NOT NULL,
  "is_depth" boolean NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "competitor_patterns_result_ck" CHECK (result IN ('ALL_OBSERVED','MAJORITY_OBSERVED','NO_PATTERN','INSUFFICIENT_DATA')),
  CONSTRAINT "competitor_patterns_confidence_ck" CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  CONSTRAINT "competitor_patterns_wording_form_ck" CHECK (wording_form IN ('TWO_OF_TWO','TWO_OF_THREE','ALL_OF_THREE','NONE')),
  CONSTRAINT "competitor_patterns_counts_ck" CHECK (present_count >= 0 AND absent_count >= 0 AND unknown_count >= 0 AND usable_denominator >= 0 AND total_selected >= 0)
);--> statement-breakpoint
ALTER TABLE "competitor_patterns" ADD CONSTRAINT "competitor_patterns_package_id_competitor_pattern_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "competitor_pattern_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_patterns_package_idx" ON "competitor_patterns" ("package_id");--> statement-breakpoint

CREATE TABLE "competitor_prospect_contrasts" (
  "id" text PRIMARY KEY NOT NULL,
  "package_id" text NOT NULL,
  "pattern_id" text,
  "category" text NOT NULL,
  "contrast_kind" text NOT NULL,
  "prospect_state" text NOT NULL,
  "prospect_evidence_ref" text NOT NULL,
  "confidence" text NOT NULL,
  "consequence_label" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "competitor_prospect_contrasts_kind_ck" CHECK (contrast_kind IN ('BOOLEAN')),
  CONSTRAINT "competitor_prospect_contrasts_state_ck" CHECK (prospect_state IN ('ABSENT')),
  CONSTRAINT "competitor_prospect_contrasts_confidence_ck" CHECK (confidence IN ('HIGH','MEDIUM','LOW'))
);--> statement-breakpoint
ALTER TABLE "competitor_prospect_contrasts" ADD CONSTRAINT "competitor_prospect_contrasts_package_id_competitor_pattern_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "competitor_pattern_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_prospect_contrasts" ADD CONSTRAINT "competitor_prospect_contrasts_pattern_id_competitor_patterns_id_fk" FOREIGN KEY ("pattern_id") REFERENCES "competitor_patterns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_prospect_contrasts_package_idx" ON "competitor_prospect_contrasts" ("package_id");--> statement-breakpoint

CREATE TABLE "competitor_pattern_evidence_refs" (
  "id" text PRIMARY KEY NOT NULL,
  "package_id" text NOT NULL,
  "kind" text NOT NULL,
  "evidence_item_id" text NOT NULL,
  "capture_run_id" text,
  "competitor_candidate_id" text,
  "category" text,
  "source_url" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "competitor_pattern_evidence_refs_kind_ck" CHECK (kind IN ('COMPETITOR','PROSPECT'))
);--> statement-breakpoint
ALTER TABLE "competitor_pattern_evidence_refs" ADD CONSTRAINT "competitor_pattern_evidence_refs_package_id_competitor_pattern_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "competitor_pattern_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_pattern_evidence_refs_package_idx" ON "competitor_pattern_evidence_refs" ("package_id");
