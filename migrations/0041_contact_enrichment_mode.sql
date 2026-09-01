-- Idempotency-mode fix. A previous ENRICH result must never be replayed as a hit for a later PREVIEW,
-- and a previous PREVIEW must never suppress a later paid ENRICH. `mode` becomes part of the
-- idempotency identity, replacing the (lead_id, provider, input_hash) unique index with
-- (lead_id, provider, mode, input_hash). Additive/loosening only — no column or table removed.
--
-- Backfill for existing rows (mode was not previously tracked):
--   VERIFIED / NOT_FOUND / CAPPED  -> ENRICH (only reachable once the paid loop ran)
--   PREVIEW_MATCHED                -> PREVIEW (only reachable when paid enrichment was not requested)
--   PREVIEW_NO_MATCH / ERROR       -> ENRICH (ambiguous: no spend occurred either way, so mislabeling
--                                     these is harmless — a fresh call under either mode reaches the
--                                     same deterministic pre-spend result).

ALTER TABLE "contact_enrichment_results" ADD COLUMN "mode" text;--> statement-breakpoint
UPDATE "contact_enrichment_results" SET "mode" = CASE
  WHEN "outcome" IN ('VERIFIED','NOT_FOUND','CAPPED') THEN 'ENRICH'
  WHEN "outcome" = 'PREVIEW_MATCHED' THEN 'PREVIEW'
  ELSE 'ENRICH'
END;--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" ALTER COLUMN "mode" SET NOT NULL;--> statement-breakpoint
DROP INDEX "contact_enrichment_results_idempotency_uk";--> statement-breakpoint
CREATE UNIQUE INDEX "contact_enrichment_results_idempotency_uk" ON "contact_enrichment_results" ("lead_id","provider","mode","input_hash");--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" ADD CONSTRAINT "contact_enrichment_mode_ck" CHECK (mode IN ('PREVIEW','ENRICH'));--> statement-breakpoint
ALTER TABLE "contact_enrichment_results" ADD CONSTRAINT "contact_enrichment_mode_outcome_ck" CHECK (
  (mode = 'PREVIEW' AND outcome IN ('PREVIEW_MATCHED','PREVIEW_NO_MATCH','ERROR'))
  OR (mode = 'ENRICH' AND outcome IN ('VERIFIED','NOT_FOUND','CAPPED','ERROR','PREVIEW_NO_MATCH'))
);
