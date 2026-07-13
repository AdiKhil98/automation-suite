CREATE TABLE "lead_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"fact_type" text NOT NULL,
	"value" text NOT NULL,
	"normalized_value" text,
	"source_type" text NOT NULL,
	"source_url" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"superseded_by" text,
	"superseded_at" timestamp with time zone,
	"is_current" boolean DEFAULT true NOT NULL,
	CONSTRAINT "lead_facts_confidence_ck" CHECK ("lead_facts"."confidence" >= 0 AND "lead_facts"."confidence" <= 1),
	CONSTRAINT "lead_facts_source_type_ck" CHECK ("lead_facts"."source_type" IN ('mock', 'manual', 'website')),
	CONSTRAINT "lead_facts_fact_type_ck" CHECK (fact_type IN ('business_name', 'official_domain', 'domain', 'phone', 'contact_email', 'contact_form_url', 'formatted_address', 'latitude', 'longitude', 'city', 'country', 'category', 'rating', 'review_count', 'business_status', 'ownership_type'))
);
--> statement-breakpoint
CREATE TABLE "qualification_result_facts" (
	"qualification_result_id" text NOT NULL,
	"lead_fact_id" text NOT NULL,
	CONSTRAINT "qualification_result_facts_qualification_result_id_lead_fact_id_pk" PRIMARY KEY("qualification_result_id","lead_fact_id")
);
--> statement-breakpoint
CREATE TABLE "qualification_results" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"campaign" text NOT NULL,
	"qualification_stage" text NOT NULL,
	"rules_version" text NOT NULL,
	"rules_config_hash" text NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"business_viability_score" double precision,
	"auditability_score" double precision,
	"contactability_score" double precision,
	"opportunity_score" double precision,
	"deterministic_score" double precision,
	"decision" text NOT NULL,
	"priority" text NOT NULL,
	"next_step" text NOT NULL,
	"triggered_rules" jsonb NOT NULL,
	"missing_required_facts" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"input_fingerprint" text NOT NULL,
	CONSTRAINT "qr_stage_ck" CHECK ("qualification_results"."qualification_stage" IN ('PRE_AUDIT')),
	CONSTRAINT "qr_decision_ck" CHECK ("qualification_results"."decision" IN ('ACCEPT', 'REVIEW', 'REJECT')),
	CONSTRAINT "qr_priority_ck" CHECK ("qualification_results"."priority" IN ('HIGH', 'MEDIUM', 'LOW', 'UNASSIGNED')),
	CONSTRAINT "qr_next_step_ck" CHECK ("qualification_results"."next_step" IN ('AUDIT', 'WEBSITE_DISCOVERY', 'NEEDS_ENRICHMENT', 'MANUAL_REVIEW', 'SKIP')),
	CONSTRAINT "qr_score_ck" CHECK (("qualification_results"."business_viability_score" IS NULL OR ("qualification_results"."business_viability_score" >= 0 AND "qualification_results"."business_viability_score" <= 100))
        AND ("qualification_results"."auditability_score" IS NULL OR ("qualification_results"."auditability_score" >= 0 AND "qualification_results"."auditability_score" <= 100))
        AND ("qualification_results"."contactability_score" IS NULL OR ("qualification_results"."contactability_score" >= 0 AND "qualification_results"."contactability_score" <= 100))
        AND ("qualification_results"."opportunity_score" IS NULL OR ("qualification_results"."opportunity_score" >= 0 AND "qualification_results"."opportunity_score" <= 100))
        AND ("qualification_results"."deterministic_score" IS NULL OR ("qualification_results"."deterministic_score" >= 0 AND "qualification_results"."deterministic_score" <= 100)))
);
--> statement-breakpoint
CREATE TABLE "suppression_list" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"value" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppression_scope_ck" CHECK ("suppression_list"."scope" IN ('domain', 'phone', 'place_id'))
);
--> statement-breakpoint
ALTER TABLE "lead_facts" ADD CONSTRAINT "lead_facts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_facts" ADD CONSTRAINT "lead_facts_superseded_by_lead_facts_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."lead_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_result_facts" ADD CONSTRAINT "qualification_result_facts_qualification_result_id_qualification_results_id_fk" FOREIGN KEY ("qualification_result_id") REFERENCES "public"."qualification_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_result_facts" ADD CONSTRAINT "qualification_result_facts_lead_fact_id_lead_facts_id_fk" FOREIGN KEY ("lead_fact_id") REFERENCES "public"."lead_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_results" ADD CONSTRAINT "qualification_results_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_facts_current_uk" ON "lead_facts" USING btree ("lead_id","fact_type") WHERE "lead_facts"."is_current";--> statement-breakpoint
CREATE INDEX "lead_facts_lead_type_idx" ON "lead_facts" USING btree ("lead_id","fact_type");--> statement-breakpoint
CREATE INDEX "qualification_results_lead_idx" ON "qualification_results" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_list_scope_value_uk" ON "suppression_list" USING btree ("scope","value");--> statement-breakpoint
-- Backfill lead_facts from the legacy leads projection (provenance = deprecated facts_source).
-- No-op on a clean database; migrates pre-Phase-3 rows to per-fact provenance.
INSERT INTO lead_facts (id, lead_id, fact_type, value, normalized_value, source_type, source_url, captured_at, confidence, is_current)
SELECT gen_random_uuid(), id, 'business_name', business_name, normalized_name, facts_source, facts_source_url, COALESCE(facts_captured_at, now()), 1, true
FROM leads WHERE business_name IS NOT NULL AND facts_source IN ('mock', 'manual', 'website');--> statement-breakpoint
INSERT INTO lead_facts (id, lead_id, fact_type, value, normalized_value, source_type, source_url, captured_at, confidence, is_current)
SELECT gen_random_uuid(), id, 'domain', domain, normalized_domain, facts_source, facts_source_url, COALESCE(facts_captured_at, now()), 1, true
FROM leads WHERE domain IS NOT NULL AND facts_source IN ('mock', 'manual', 'website');--> statement-breakpoint
INSERT INTO lead_facts (id, lead_id, fact_type, value, normalized_value, source_type, source_url, captured_at, confidence, is_current)
SELECT gen_random_uuid(), id, 'phone', phone, normalized_phone, facts_source, facts_source_url, COALESCE(facts_captured_at, now()), 1, true
FROM leads WHERE phone IS NOT NULL AND facts_source IN ('mock', 'manual', 'website');--> statement-breakpoint
INSERT INTO lead_facts (id, lead_id, fact_type, value, normalized_value, source_type, source_url, captured_at, confidence, is_current)
SELECT gen_random_uuid(), id, 'formatted_address', formatted_address, normalized_address, facts_source, facts_source_url, COALESCE(facts_captured_at, now()), 1, true
FROM leads WHERE formatted_address IS NOT NULL AND facts_source IN ('mock', 'manual', 'website');--> statement-breakpoint
INSERT INTO lead_facts (id, lead_id, fact_type, value, normalized_value, source_type, source_url, captured_at, confidence, is_current)
SELECT gen_random_uuid(), id, 'city', city, NULL, facts_source, facts_source_url, COALESCE(facts_captured_at, now()), 1, true
FROM leads WHERE city IS NOT NULL AND facts_source IN ('mock', 'manual', 'website');--> statement-breakpoint
INSERT INTO lead_facts (id, lead_id, fact_type, value, normalized_value, source_type, source_url, captured_at, confidence, is_current)
SELECT gen_random_uuid(), id, 'country', country, NULL, facts_source, facts_source_url, COALESCE(facts_captured_at, now()), 1, true
FROM leads WHERE country IS NOT NULL AND facts_source IN ('mock', 'manual', 'website');--> statement-breakpoint
INSERT INTO lead_facts (id, lead_id, fact_type, value, normalized_value, source_type, source_url, captured_at, confidence, is_current)
SELECT gen_random_uuid(), id, 'latitude', latitude::text, NULL, facts_source, facts_source_url, COALESCE(facts_captured_at, now()), 1, true
FROM leads WHERE latitude IS NOT NULL AND facts_source IN ('mock', 'manual', 'website');--> statement-breakpoint
INSERT INTO lead_facts (id, lead_id, fact_type, value, normalized_value, source_type, source_url, captured_at, confidence, is_current)
SELECT gen_random_uuid(), id, 'longitude', longitude::text, NULL, facts_source, facts_source_url, COALESCE(facts_captured_at, now()), 1, true
FROM leads WHERE longitude IS NOT NULL AND facts_source IN ('mock', 'manual', 'website');
