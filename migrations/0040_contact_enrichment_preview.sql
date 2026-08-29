-- Contact enrichment preview-first + honest credit accounting. Additive/loosening only.
-- credits_reported (nullable) records PROVIDER-REPORTED credits distinctly from the credits_used
-- estimate, so we never persist an assumed "1" as confirmed billing. The outcome CHECK is widened for
-- the non-enriching preview outcomes (PREVIEW_MATCHED / PREVIEW_NO_MATCH). No column/table removed.

ALTER TABLE "contact_enrichment_results" ADD COLUMN "credits_reported" integer;--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" DROP CONSTRAINT "contact_enrichment_outcome_ck";--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" ADD CONSTRAINT "contact_enrichment_outcome_ck" CHECK (outcome IN ('VERIFIED','NOT_FOUND','CAPPED','ERROR','PREVIEW_MATCHED','PREVIEW_NO_MATCH'));--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" DROP CONSTRAINT "contact_enrichment_credits_ck";--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" ADD CONSTRAINT "contact_enrichment_credits_ck" CHECK (credits_used >= 0 AND (credits_reported IS NULL OR credits_reported >= 0));
