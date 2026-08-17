-- Scheduled-send automation: the durable authorization that replaces the interactive per-send
-- readiness/TTY for AUTOMATED sends ONLY, plus provenance on sending_readiness_approvals so the
-- manual (INTERACTIVE) and automated (SCHEDULED) readiness lineages stay independent.
--
-- This is NOT strictly additive: it adds a table + two columns + constraints AND performs one SAFE,
-- SCOPED index replacement — it drops `sending_readiness_active_uk` and immediately recreates it in
-- the same migration, widened from (gmail_account, policy_version) to (gmail_account, policy_version,
-- source). No table/column is dropped and no row is deleted.
--
-- Index-replacement safety: every existing readiness row gets source='INTERACTIVE' (the added column's
-- default), and the OLD index already guaranteed at most one active row per (gmail_account,
-- policy_version). So each existing active row is already unique under the WIDENED key, and the
-- recreate cannot raise a uniqueness violation. The new index only RELAXES uniqueness to additionally
-- allow one active SCHEDULED row alongside the INTERACTIVE one. The manual send path is unaffected.

CREATE TABLE "scheduled_send_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"gmail_account" text NOT NULL,
	"policy_version" text NOT NULL,
	"created_by" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_per_day" integer NOT NULL,
	"note" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_send_auth_cap_ck" CHECK ("max_per_day" >= 1),
	CONSTRAINT "scheduled_send_auth_window_ck" CHECK ("expires_at" > "starts_at" AND "expires_at" <= "starts_at" + interval '14 days'),
	CONSTRAINT "scheduled_send_auth_revocation_ck" CHECK (("revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL) OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL AND "revoke_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "scheduled_send_auth_account_idx" ON "scheduled_send_authorizations" ("gmail_account","policy_version");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_send_auth_active_uk" ON "scheduled_send_authorizations" ("gmail_account","policy_version") WHERE "revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "sending_readiness_approvals" ADD COLUMN "source" text DEFAULT 'INTERACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "sending_readiness_approvals" ADD COLUMN "scheduled_authorization_id" text;--> statement-breakpoint
ALTER TABLE "sending_readiness_approvals" ADD CONSTRAINT "sending_readiness_scheduled_auth_fk" FOREIGN KEY ("scheduled_authorization_id") REFERENCES "scheduled_send_authorizations"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "sending_readiness_approvals" ADD CONSTRAINT "sending_readiness_source_ck" CHECK (("source" = 'INTERACTIVE' AND "scheduled_authorization_id" IS NULL) OR ("source" = 'SCHEDULED' AND "scheduled_authorization_id" IS NOT NULL));--> statement-breakpoint
DROP INDEX "sending_readiness_active_uk";--> statement-breakpoint
CREATE UNIQUE INDEX "sending_readiness_active_uk" ON "sending_readiness_approvals" ("gmail_account","policy_version","source") WHERE "revoked_at" IS NULL;
