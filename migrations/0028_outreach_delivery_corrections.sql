-- Phase 17C1: harden DSN correlation. Additive only. No existing column is altered or dropped.
-- Adds operator-correction metadata to outreach_delivery_events so a mis-correlated delivery
-- event can be INVALIDATED (superseded) without ever deleting immutable history. Null while valid.

ALTER TABLE "outreach_delivery_events" ADD COLUMN "superseded_at" timestamp with time zone;
ALTER TABLE "outreach_delivery_events" ADD COLUMN "superseded_reason" text;
ALTER TABLE "outreach_delivery_events" ADD COLUMN "superseded_by" text;
