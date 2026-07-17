-- Reverse migration for 0008 (Phase 8 demo-input fact types).
-- Removes the new fact types from the CHECK constraint. Any existing facts of these
-- types are deleted first so the old constraint can be restored.

BEGIN;

DELETE FROM lead_facts WHERE fact_type IN ('services','opening_hours','booking_url');

ALTER TABLE "lead_facts" DROP CONSTRAINT IF EXISTS "lead_facts_fact_type_ck";
ALTER TABLE "lead_facts" ADD CONSTRAINT "lead_facts_fact_type_ck" CHECK (fact_type IN ('business_name','official_domain','official_website_url','official_location_page_url','domain','phone','contact_email','contact_form_url','formatted_address','latitude','longitude','city','country','category','rating','review_count','business_status','ownership_type'));

COMMIT;
