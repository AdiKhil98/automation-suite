-- Contact enrichment (decision-maker work-email discovery). Additive only — NO existing table is
-- altered and this feature never writes lead_facts (so no manual contact fact can be overwritten).
-- One row per enrichment RUN over a lead's ordered candidate list. Idempotent re-runs are guaranteed
-- by the partial unique index on (lead_id, provider, input_hash). Enables no outbound behavior.

CREATE TABLE "contact_enrichment_results" (
  "id" text PRIMARY KEY NOT NULL,
  "lead_id" text NOT NULL,
  "provider" text NOT NULL,
  "input_hash" text NOT NULL,
  "requested_domain" text NOT NULL,
  "candidates" jsonb NOT NULL,
  "outcome" text NOT NULL,
  "accepted_name" text,
  "accepted_title" text,
  "accepted_email" text,
  "verification_status" text,
  "data_quality" text,
  "confidence" double precision,
  "credits_used" integer DEFAULT 0 NOT NULL,
  "provider_resource_id" text,
  "endpoint" text,
  "provenance" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "contact_enrichment_outcome_ck" CHECK (outcome IN ('VERIFIED','NOT_FOUND','CAPPED','ERROR')),
  CONSTRAINT "contact_enrichment_credits_ck" CHECK (credits_used >= 0),
  CONSTRAINT "contact_enrichment_accepted_ck" CHECK (
    (outcome = 'VERIFIED' AND accepted_email IS NOT NULL AND verification_status = 'VERIFIED')
    OR (outcome <> 'VERIFIED' AND accepted_email IS NULL)
  )
);--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" ADD CONSTRAINT "contact_enrichment_results_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_enrichment_results_lead_idx" ON "contact_enrichment_results" ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_enrichment_results_idempotency_uk" ON "contact_enrichment_results" ("lead_id","provider","input_hash");
