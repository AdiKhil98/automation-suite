-- Reverse migration for 0014 (Phase 13 scheduling).
-- Apply with: psql "$DATABASE_URL" -f scripts/rollback/0014_send_schedules_down.sql
-- Run BEFORE `git reset --hard phase-12-gmail-drafts` so the database matches the code.
-- Drops the schedules table and removes the contact_timezone fact type (deleting any such facts
-- first so the pre-0014 CHECK constraint can be restored).

BEGIN;

DROP TABLE IF EXISTS send_schedules;

DELETE FROM lead_facts WHERE fact_type = 'contact_timezone';
ALTER TABLE "lead_facts" DROP CONSTRAINT IF EXISTS "lead_facts_fact_type_ck";
ALTER TABLE "lead_facts" ADD CONSTRAINT "lead_facts_fact_type_ck" CHECK (fact_type IN ('business_name','official_domain','official_website_url','official_location_page_url','domain','phone','contact_email','contact_form_url','formatted_address','latitude','longitude','city','country','category','rating','review_count','business_status','ownership_type','services','opening_hours','booking_url'));

COMMIT;
