-- Outreach sequence: the FOURTH email (internal follow-up step 3) + durable sequence provenance.
--
-- The lesson sequence is FOUR EMAILS TOTAL, not four follow-ups:
--
--   lesson name    day   internal sequenceStep   internal statuses
--   Outreach #1     0    0 (INITIAL)             INITIAL_SENT
--   Follow-up #2    2    1                       FOLLOW_UP_1_DUE / FOLLOW_UP_1_SENT
--   Follow-up #3    4    2                       FOLLOW_UP_2_DUE / FOLLOW_UP_2_SENT
--   Follow-up #4    7    3                       FOLLOW_UP_3_DUE / FOLLOW_UP_3_SENT
--
-- The existing internal statuses are NOT renamed: FOLLOW_UP_1_* stays the lesson's Follow-up #2 and
-- so on. There is deliberately NO step 4 and no FOLLOW_UP_4_*: after FOLLOW_UP_3_SENT the automated
-- sequence is finished and nothing further is ever scheduled.
--
-- Additive and backward-compatible. Every existing row keeps its exact meaning:
--   * no status is removed, so no outreach_records row can become invalid;
--   * no follow-up step is removed, so no outreach_followups row can become invalid;
--   * email_drafts.sequence_step defaults to 0 = INITIAL, which is precisely what every pre-existing
--     draft was, so the enrollment bridge routes historical sends exactly as it did before;
--   * email_drafts.outreach_record_id is nullable and stays NULL for every pre-existing draft.
--
-- Why sequence provenance lives on email_drafts rather than in a new table: the send pipeline already
-- binds send_attempts -> gmail_drafts -> email_draft_finalizations -> email_drafts. Recording the
-- sequence position on the draft makes that existing chain self-describing, so a recovery run after a
-- crash can determine EXACTLY what a confirmed send represented without inferring it from subject
-- text, timestamps, or "the latest email". outreach_record_id is a plain text column (not a foreign
-- key) so that deleting an outreach record can never cascade into immutable email history.
--
-- Rollback (safe only while no row uses the new values):
--   ALTER TABLE "outreach_records"   DROP CONSTRAINT "outreach_record_status_ck";
--   ALTER TABLE "outreach_records"   ADD  CONSTRAINT "outreach_record_status_ck" CHECK ("status" IN (
--     'DRAFT_READY','AWAITING_APPROVAL','APPROVED_TO_SEND','INITIAL_SENT',
--     'FOLLOW_UP_1_DUE','FOLLOW_UP_1_SENT','FOLLOW_UP_2_DUE','FOLLOW_UP_2_SENT',
--     'REPLIED_POSITIVE','REPLIED_NEUTRAL','REPLIED_NEGATIVE','BOUNCED','UNSUBSCRIBED',
--     'DO_NOT_CONTACT','MEETING_BOOKED','CLOSED_WON','CLOSED_LOST'));
--   ALTER TABLE "outreach_followups" DROP CONSTRAINT "outreach_followup_step_ck";
--   ALTER TABLE "outreach_followups" ADD  CONSTRAINT "outreach_followup_step_ck" CHECK ("step" IN (1,2));
--   DROP INDEX "email_drafts_outreach_sequence_uk";
--   ALTER TABLE "email_drafts" DROP CONSTRAINT "email_draft_sequence_step_ck";
--   ALTER TABLE "email_drafts" DROP COLUMN "outreach_record_id";
--   ALTER TABLE "email_drafts" DROP COLUMN "sequence_step";

-- 1. The record lifecycle gains the final follow-up's two statuses.
ALTER TABLE "outreach_records" DROP CONSTRAINT "outreach_record_status_ck";
--> statement-breakpoint
ALTER TABLE "outreach_records" ADD CONSTRAINT "outreach_record_status_ck" CHECK ("outreach_records"."status" IN (
	'DRAFT_READY','AWAITING_APPROVAL','APPROVED_TO_SEND','INITIAL_SENT',
	'FOLLOW_UP_1_DUE','FOLLOW_UP_1_SENT','FOLLOW_UP_2_DUE','FOLLOW_UP_2_SENT',
	'FOLLOW_UP_3_DUE','FOLLOW_UP_3_SENT',
	'REPLIED_POSITIVE','REPLIED_NEUTRAL','REPLIED_NEGATIVE','BOUNCED','UNSUBSCRIBED',
	'DO_NOT_CONTACT','MEETING_BOOKED','CLOSED_WON','CLOSED_LOST'));
--> statement-breakpoint

-- 2. The follow-up queue accepts internal step 3 (lesson Follow-up #4). Never a step 4.
ALTER TABLE "outreach_followups" DROP CONSTRAINT "outreach_followup_step_ck";
--> statement-breakpoint
ALTER TABLE "outreach_followups" ADD CONSTRAINT "outreach_followup_step_ck" CHECK ("outreach_followups"."step" IN (1,2,3));
--> statement-breakpoint

-- 3. Durable sequence provenance on the composed copy.
ALTER TABLE "email_drafts" ADD COLUMN "sequence_step" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_drafts" ADD COLUMN "outreach_record_id" text;
--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_draft_sequence_step_ck" CHECK ("email_drafts"."sequence_step" BETWEEN 0 AND 3);
--> statement-breakpoint

-- 4. Hard idempotency for unattended follow-up preparation: at most ONE live draft per
--    (outreach record, sequence step). Two concurrent timer runs therefore cannot both compose the
--    same follow-up — the second insert fails instead of producing a duplicate competing for the
--    same send slot. Partial, so it constrains only sequence-bound drafts:
--      * rows with a NULL outreach_record_id (every pre-existing draft) are unconstrained;
--      * a draft the operator REJECTED is excluded, so an operator who later re-schedules that step
--        can have fresh copy composed for it without dropping the index.
CREATE UNIQUE INDEX "email_drafts_outreach_sequence_uk" ON "email_drafts" USING btree ("outreach_record_id","sequence_step")
	WHERE "outreach_record_id" IS NOT NULL AND "human_decision" IS DISTINCT FROM 'REJECTED';
