ALTER TABLE "suppression_list" DROP CONSTRAINT IF EXISTS "suppression_revocation_ck";
ALTER TABLE "suppression_list" DROP COLUMN IF EXISTS "revoke_reason";
ALTER TABLE "suppression_list" DROP COLUMN IF EXISTS "revoked_by";
ALTER TABLE "suppression_list" DROP COLUMN IF EXISTS "revoked_at";
ALTER TABLE "suppression_list" DROP COLUMN IF EXISTS "created_by";
