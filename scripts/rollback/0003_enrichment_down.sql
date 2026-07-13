-- Reverse migration for 0003_moaning_fixer (Phase 4 enrichment).
-- Apply with: psql "$DATABASE_URL" -f scripts/rollback/0003_enrichment_down.sql
-- Drops the enrichment tables and restores the pre-Phase-4 lead_facts fact_type CHECK.
-- Run BEFORE `git reset --hard phase-3-qualification` so the database matches the code.

BEGIN;

DROP TABLE IF EXISTS enrichment_signals;
DROP TABLE IF EXISTS enrichment_candidates;
DROP TABLE IF EXISTS enrichment_attempts;

ALTER TABLE lead_facts DROP CONSTRAINT IF EXISTS lead_facts_fact_type_ck;
ALTER TABLE lead_facts ADD CONSTRAINT lead_facts_fact_type_ck CHECK (
  fact_type IN (
    'business_name', 'official_domain', 'domain', 'phone', 'contact_email',
    'contact_form_url', 'formatted_address', 'latitude', 'longitude', 'city',
    'country', 'category', 'rating', 'review_count', 'business_status', 'ownership_type'
  )
);

COMMIT;
