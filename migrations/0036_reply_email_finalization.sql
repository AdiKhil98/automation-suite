-- Reply-email finalization: a SECOND producer for the existing email_draft_finalizations table so an
-- already HUMAN_APPROVED reply email (no demo, no Netlify, no {{DEMO_URL}}) can carry the finalization
-- record the Gmail eligibility gate requires. This is not a parallel system — it reuses the same table
-- and the same downstream (GmailInputRepository / checkGmailEligibility) semantics.
--
-- Constraint-loosening + additive only; existing demo finalizations are semantically unchanged:
--  - deployment_run_id / verified_deployment_url become nullable (a reply row has no demo deployment).
--  - a `kind` discriminator (DEFAULT 'DEMO_URL_RESOLVED') keeps every existing row a demo finalization;
--    reply rows are 'REPLY_DIRECT'.
--  - a partial unique index gives at most one REPLY_DIRECT finalization per original draft.
-- No column or table is removed; the Gmail eligibility logic is untouched.

ALTER TABLE "email_draft_finalizations" ALTER COLUMN "deployment_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_draft_finalizations" ALTER COLUMN "verified_deployment_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_draft_finalizations" ADD COLUMN "kind" text DEFAULT 'DEMO_URL_RESOLVED' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_draft_finalizations" ADD CONSTRAINT "email_finalization_kind_ck" CHECK ("kind" IN ('DEMO_URL_RESOLVED','REPLY_DIRECT'));--> statement-breakpoint
CREATE UNIQUE INDEX "email_draft_finalizations_reply_uk" ON "email_draft_finalizations" ("original_draft_id") WHERE "kind" = 'REPLY_DIRECT';
