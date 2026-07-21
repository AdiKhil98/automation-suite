ALTER TABLE "suppression_list" ADD COLUMN IF NOT EXISTS "created_by" text;--> statement-breakpoint
UPDATE "suppression_list" SET "created_by" = 'legacy' WHERE "created_by" IS NULL;--> statement-breakpoint
ALTER TABLE "suppression_list" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD COLUMN IF NOT EXISTS "revoked_by" text;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD COLUMN IF NOT EXISTS "revoke_reason" text;--> statement-breakpoint
ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_revocation_ck" CHECK (
  (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
  OR
  (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)
);
