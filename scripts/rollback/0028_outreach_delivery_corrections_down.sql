-- Reverse for 0028_outreach_delivery_corrections. Drops only the additive correction columns.
-- Correction metadata is annotation on top of immutable delivery history; dropping the columns
-- discards that annotation, so export it first if it must be preserved.

ALTER TABLE "outreach_delivery_events" DROP COLUMN IF EXISTS "superseded_by";
ALTER TABLE "outreach_delivery_events" DROP COLUMN IF EXISTS "superseded_reason";
ALTER TABLE "outreach_delivery_events" DROP COLUMN IF EXISTS "superseded_at";
