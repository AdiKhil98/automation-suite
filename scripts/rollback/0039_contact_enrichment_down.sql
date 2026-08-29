-- Guarded rollback for 0039_contact_enrichment. Refuses to drop while the table holds data, so an
-- accidental rollback can never silently discard persisted enrichment results. Additive migration →
-- dropping the table restores the prior schema exactly (no other table was touched).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM contact_enrichment_results LIMIT 1) THEN
    RAISE EXCEPTION 'contact_enrichment_results is not empty; refusing to roll back 0039 (drop data manually first if truly intended).';
  END IF;
END $$;--> statement-breakpoint
DROP TABLE IF EXISTS "contact_enrichment_results";
