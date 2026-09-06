-- Terminal contact resolution per lead: WHO we may write to and HOW we may address them.
--
-- Additive only. No existing table is altered, no lead_facts are written, and no existing behaviour
-- changes: until a row exists for a lead, downstream reads exactly what it read before.
--
-- Why a new table rather than a new fact type or a new contact_enrichment_results outcome:
--   * contact_enrichment_results describes what a PAID PROVIDER CALL did. Overloading its VERIFIED
--     status to also mean "generic business inbox" would let a mailbox belonging to nobody inherit a
--     person-level verification, which is exactly the failure this feature exists to prevent.
--   * lead_facts holds one current value per type and cannot carry the intended-decision-maker list.
--
-- The address is snapshotted in recipient_email; provenance stays authoritative through the FKs.
-- Exactly one FK is set per row, enforced by contact_resolutions_provenance_ck:
--   GENERIC_OFFICIAL  -> source_fact_id (the published website contact_email fact) + source_url
--   PERSONAL_VERIFIED -> enrichment_result_id (the row whose trust boundary accepted the address)
--
-- UNRESOLVED is deliberately NOT a stored value: it is the absence of a current row.
--
-- Rollback: DROP TABLE "contact_resolutions"; (no other object references it).

CREATE TABLE "contact_resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"resolution_type" text NOT NULL,
	"recipient_email" text NOT NULL,
	"source_fact_id" text,
	"enrichment_result_id" text,
	"source_url" text,
	"intended_decision_makers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	CONSTRAINT "contact_resolutions_type_ck" CHECK ("resolution_type" IN ('PERSONAL_VERIFIED','GENERIC_OFFICIAL')),
	CONSTRAINT "contact_resolutions_provenance_ck" CHECK (
		("resolution_type" = 'GENERIC_OFFICIAL' AND "source_fact_id" IS NOT NULL AND "enrichment_result_id" IS NULL AND "source_url" IS NOT NULL)
		OR ("resolution_type" = 'PERSONAL_VERIFIED' AND "enrichment_result_id" IS NOT NULL AND "source_fact_id" IS NULL)
	),
	CONSTRAINT "contact_resolutions_intended_ck" CHECK (
		"resolution_type" = 'GENERIC_OFFICIAL' OR "intended_decision_makers" = '[]'::jsonb
	)
);
--> statement-breakpoint
ALTER TABLE "contact_resolutions" ADD CONSTRAINT "contact_resolutions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_resolutions" ADD CONSTRAINT "contact_resolutions_source_fact_id_lead_facts_id_fk" FOREIGN KEY ("source_fact_id") REFERENCES "public"."lead_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_resolutions" ADD CONSTRAINT "contact_resolutions_enrichment_result_id_contact_enrichment_results_id_fk" FOREIGN KEY ("enrichment_result_id") REFERENCES "public"."contact_enrichment_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_resolutions_lead_idx" ON "contact_resolutions" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_resolutions_current_uk" ON "contact_resolutions" USING btree ("lead_id") WHERE "contact_resolutions"."is_current";
