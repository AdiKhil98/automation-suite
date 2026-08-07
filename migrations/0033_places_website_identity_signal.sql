-- Option B: allow the new deterministic verification signal `places_website_identity_match`.
-- Additive only: widens the enrichment_signals.signal_type CHECK constraint. No column is altered
-- or dropped, and no existing row is affected (the new value is simply now permitted).
-- Rollback: re-narrow the constraint to the previous 11-value list (only possible once no row uses
-- the new value).

ALTER TABLE "enrichment_signals" DROP CONSTRAINT IF EXISTS "enrichment_signal_type_ck";
ALTER TABLE "enrichment_signals" ADD CONSTRAINT "enrichment_signal_type_ck" CHECK (signal_type IN ('exact_phone','name_address','branch_location','structured_data','legal_footer','name_tokens','category_text','city_mention','mailto','plaintext_email','contact_form','places_website_identity_match'));
