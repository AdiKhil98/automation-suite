-- Guarded rollback for 0032_email_competitor_enrichment.
--
-- Fails closed if EITHER Phase 7A3B companion table holds data: enrichment provenance and the
-- per-claim traceability ledger are immutable history and must never be silently dropped.
-- Truncate/export deliberately first, then re-run this script on empty tables. Because both tables
-- are additive, dropping them restores the exact pre-7A3B email schema (email_drafts is untouched).

DO $$
DECLARE
  populated_table text;
BEGIN
  SELECT table_name INTO populated_table
  FROM (
    VALUES
      ('email_claim_ledger'),
      ('email_competitor_enrichment')
  ) AS candidates(table_name)
  WHERE CASE table_name
    WHEN 'email_claim_ledger' THEN EXISTS (SELECT 1 FROM email_claim_ledger)
    WHEN 'email_competitor_enrichment' THEN EXISTS (SELECT 1 FROM email_competitor_enrichment)
    ELSE false
  END
  LIMIT 1;

  IF populated_table IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to roll back 0032: table % still holds enrichment/ledger history. Export or truncate deliberately first.', populated_table;
  END IF;
END $$;

DROP TABLE IF EXISTS "email_claim_ledger";
DROP TABLE IF EXISTS "email_competitor_enrichment";
