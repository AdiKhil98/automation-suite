-- Operator-authored email provenance. Additive only: one column on email_drafts that distinguishes an
-- AI-generated draft from an operator-authored (human-written) one, so a human-approved email can be
-- stored in the existing email_drafts workflow WITHOUT falsely representing it as AI-generated.
--
-- Existing rows default to 'AI' (unchanged, no backfill). Operator rows explicitly set 'OPERATOR'. A
-- CHECK pins the two permitted values. Reversal: remove the constraint + column once unused.

ALTER TABLE "email_drafts" ADD COLUMN "authorship" text DEFAULT 'AI' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_draft_authorship_ck" CHECK ("authorship" IN ('AI','OPERATOR'));
