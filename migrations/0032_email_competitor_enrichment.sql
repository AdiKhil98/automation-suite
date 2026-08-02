-- Phase 7A3B: competitor email enrichment traceability. Additive only — NO existing table (including
-- email_drafts and every prospect-only email row) is altered. Two immutable companion tables persist,
-- for an ENRICHED composed email, the package provenance + the per-claim traceability ledger + the exact
-- composed-message hash. Prospect-only emails have NO row in either table. No Gmail/Sheets/sending path
-- exists here; this migration enables no outbound behavior.

CREATE TABLE "email_competitor_enrichment" (
  "id" text PRIMARY KEY NOT NULL,
  "email_id" text NOT NULL,
  "lead_id" text NOT NULL,
  "competitor_evidence_used" text NOT NULL,
  "schema_version" text NOT NULL,
  "rules_version" text NOT NULL,
  "package_id" text NOT NULL,
  "package_version" integer NOT NULL,
  "package_hash" text NOT NULL,
  "selected_pattern_id" text NOT NULL,
  "selected_contrast_id" text,
  "primary_issue_evidence_id" text NOT NULL,
  "primary_issue_finding_ref" text NOT NULL,
  "alignment_audit_category" text NOT NULL,
  "alignment_evidence_category" text NOT NULL,
  "revalidated_at" timestamp with time zone NOT NULL,
  "recomputed_hash_matched" boolean NOT NULL,
  "composed_message_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_competitor_enrichment_mode_ck" CHECK (competitor_evidence_used IN ('NONE','APPROVED_COMPETITOR_PATTERN_PACKAGE'))
);--> statement-breakpoint
ALTER TABLE "email_competitor_enrichment" ADD CONSTRAINT "email_competitor_enrichment_email_id_email_drafts_id_fk" FOREIGN KEY ("email_id") REFERENCES "email_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_competitor_enrichment" ADD CONSTRAINT "email_competitor_enrichment_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_competitor_enrichment_email_uk" ON "email_competitor_enrichment" ("email_id");--> statement-breakpoint
CREATE INDEX "email_competitor_enrichment_lead_idx" ON "email_competitor_enrichment" ("lead_id");--> statement-breakpoint

CREATE TABLE "email_claim_ledger" (
  "id" text PRIMARY KEY NOT NULL,
  "email_id" text NOT NULL,
  "enrichment_id" text,
  "ordinal" integer NOT NULL,
  "claim_type" text NOT NULL,
  "text" text NOT NULL,
  "prospect_evidence_ids" jsonb NOT NULL,
  "pattern_id" text,
  "contrast_id" text,
  "competitor_evidence_ids" jsonb NOT NULL,
  "package_id" text,
  "package_version" integer,
  "package_hash" text,
  "rules_version" text NOT NULL,
  "validated_at" timestamp with time zone NOT NULL,
  "externally_safe" boolean NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_claim_ledger_claim_type_ck" CHECK (claim_type IN ('PROSPECT_OBSERVATION','COMPETITOR_PATTERN','PROSPECT_CONTRAST','CAUTIOUS_CONSEQUENCE','RECOMMENDATION','CTA'))
);--> statement-breakpoint
ALTER TABLE "email_claim_ledger" ADD CONSTRAINT "email_claim_ledger_email_id_email_drafts_id_fk" FOREIGN KEY ("email_id") REFERENCES "email_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_claim_ledger" ADD CONSTRAINT "email_claim_ledger_enrichment_id_email_competitor_enrichment_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "email_competitor_enrichment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_claim_ledger_email_idx" ON "email_claim_ledger" ("email_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_claim_ledger_email_ordinal_uk" ON "email_claim_ledger" ("email_id","ordinal");
