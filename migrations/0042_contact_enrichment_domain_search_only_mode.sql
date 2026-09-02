-- Add DOMAIN_SEARCH_ONLY as a third enrichment mode: a guarded, Hunter-only operator path that skips
-- the per-candidate Finder tier entirely and tries exactly one Domain Search call against the given
-- candidates, going through the same decideAcceptance trust boundary as every other path. Mode is
-- already part of the idempotency identity (see 0041), so this new mode gets its own idempotent
-- cache slot for free — it never suppresses or is suppressed by an existing PREVIEW/ENRICH row for the
-- same lead/domain/candidates. Additive only — no existing row/column changed; PREVIEW and ENRICH
-- behavior is untouched.

ALTER TABLE "contact_enrichment_results" DROP CONSTRAINT "contact_enrichment_mode_ck";--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" ADD CONSTRAINT "contact_enrichment_mode_ck" CHECK (mode IN ('PREVIEW','ENRICH','DOMAIN_SEARCH_ONLY'));--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" DROP CONSTRAINT "contact_enrichment_mode_outcome_ck";--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" ADD CONSTRAINT "contact_enrichment_mode_outcome_ck" CHECK (
  (mode = 'PREVIEW' AND outcome IN ('PREVIEW_MATCHED','PREVIEW_NO_MATCH','ERROR'))
  OR (mode = 'ENRICH' AND outcome IN ('VERIFIED','NOT_FOUND','CAPPED','ERROR','PREVIEW_NO_MATCH'))
  OR (mode = 'DOMAIN_SEARCH_ONLY' AND outcome IN ('VERIFIED','NOT_FOUND','CAPPED','ERROR'))
);
