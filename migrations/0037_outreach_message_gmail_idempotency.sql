-- Production-send -> outreach tracking bridge: DB-level idempotency for enrollment.
-- A confirmed production send is enrolled into outreach as an INITIAL step-0 message carrying the
-- exact Gmail message id. A duplicate outbound-message row around a real send would be much worse
-- than this tiny additive index, so we make idempotency a hard guarantee (not only a code pre-check).
--
-- Additive only: a partial UNIQUE index on the non-null gmail_message_id. Existing rows are unaffected
-- (each sent message already has a unique Gmail message id; unsent rows keep NULL and are not covered).
CREATE UNIQUE INDEX "outreach_messages_gmail_message_uk" ON "outreach_messages" ("gmail_message_id") WHERE "gmail_message_id" IS NOT NULL;
