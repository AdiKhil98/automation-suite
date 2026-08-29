-- Guarded rollback for 0040. Reverts to the 0039 shape: drops credits_reported and narrows the
-- outcome CHECK back to the original four. Refuses if any row uses a preview outcome (that data would
-- violate the narrowed CHECK), so a rollback never silently fails or discards state.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM contact_enrichment_results WHERE outcome IN ('PREVIEW_MATCHED','PREVIEW_NO_MATCH') LIMIT 1) THEN
    RAISE EXCEPTION 'contact_enrichment_results has PREVIEW_* rows; refusing to roll back 0040 (remove/relabel them first if truly intended).';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" DROP CONSTRAINT "contact_enrichment_credits_ck";--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" ADD CONSTRAINT "contact_enrichment_credits_ck" CHECK (credits_used >= 0);--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" DROP CONSTRAINT "contact_enrichment_outcome_ck";--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" ADD CONSTRAINT "contact_enrichment_outcome_ck" CHECK (outcome IN ('VERIFIED','NOT_FOUND','CAPPED','ERROR'));--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" DROP COLUMN IF EXISTS "credits_reported";
