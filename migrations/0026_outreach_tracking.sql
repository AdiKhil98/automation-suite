-- Phase 17A: outreach tracking & follow-up operations (tracking only; NEVER sends).
-- Additive only. No existing table is altered. Postgres is the source of truth.

CREATE TABLE "outreach_campaigns" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "sequence_policy" jsonb NOT NULL,
  "timezone" text NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outreach_campaign_status_ck" CHECK ("status" IN ('ACTIVE','PAUSED','ARCHIVED'))
);
CREATE UNIQUE INDEX "outreach_campaigns_name_uk" ON "outreach_campaigns" ("name");

CREATE TABLE "outreach_records" (
  "id" text PRIMARY KEY NOT NULL,
  "campaign_id" text NOT NULL REFERENCES "outreach_campaigns"("id") ON DELETE CASCADE,
  "lead_id" text NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "contact_email" text NOT NULL,
  "status" text DEFAULT 'DRAFT_READY' NOT NULL,
  "sequence_step" integer DEFAULT 0 NOT NULL,
  "owner" text,
  "timezone" text NOT NULL,
  "last_sent_at" timestamp with time zone,
  "next_followup_at" timestamp with time zone,
  "last_reply_at" timestamp with time zone,
  "reply_category" text,
  "do_not_contact" boolean DEFAULT false NOT NULL,
  "outcome" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outreach_record_status_ck" CHECK ("status" IN (
    'DRAFT_READY','AWAITING_APPROVAL','APPROVED_TO_SEND','INITIAL_SENT',
    'FOLLOW_UP_1_DUE','FOLLOW_UP_1_SENT','FOLLOW_UP_2_DUE','FOLLOW_UP_2_SENT',
    'REPLIED_POSITIVE','REPLIED_NEUTRAL','REPLIED_NEGATIVE','BOUNCED','UNSUBSCRIBED',
    'DO_NOT_CONTACT','MEETING_BOOKED','CLOSED_WON','CLOSED_LOST'))
);
CREATE INDEX "outreach_records_lead_idx" ON "outreach_records" ("lead_id");
CREATE INDEX "outreach_records_campaign_idx" ON "outreach_records" ("campaign_id");
CREATE INDEX "outreach_records_contact_idx" ON "outreach_records" ("contact_email");
-- Prevent duplicate ACTIVE outreach for the same (campaign, lead, contact). Terminal rows retained.
CREATE UNIQUE INDEX "outreach_records_active_uk" ON "outreach_records" ("campaign_id","lead_id","contact_email")
  WHERE "status" NOT IN ('UNSUBSCRIBED','DO_NOT_CONTACT','CLOSED_WON','CLOSED_LOST');

CREATE TABLE "outreach_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "outreach_record_id" text NOT NULL REFERENCES "outreach_records"("id") ON DELETE CASCADE,
  "message_type" text NOT NULL,
  "sequence_step" integer NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "content_hash" text NOT NULL,
  "email_draft_id" text REFERENCES "email_drafts"("id") ON DELETE SET NULL,
  "finalized_email_id" text REFERENCES "email_draft_finalizations"("id") ON DELETE SET NULL,
  "gmail_message_id" text,
  "gmail_thread_id" text,
  "approved_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outreach_message_type_ck" CHECK ("message_type" IN ('INITIAL','FOLLOW_UP'))
);
CREATE INDEX "outreach_messages_record_idx" ON "outreach_messages" ("outreach_record_id");
CREATE INDEX "outreach_messages_thread_idx" ON "outreach_messages" ("gmail_thread_id");

CREATE TABLE "outreach_followups" (
  "id" text PRIMARY KEY NOT NULL,
  "outreach_record_id" text NOT NULL REFERENCES "outreach_records"("id") ON DELETE CASCADE,
  "step" integer NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "timezone" text NOT NULL,
  "status" text DEFAULT 'DUE' NOT NULL,
  "blocked_reason" text,
  "cancelled_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outreach_followup_status_ck" CHECK ("status" IN ('DUE','CANCELLED','POSTPONED','SENT')),
  CONSTRAINT "outreach_followup_step_ck" CHECK ("step" IN (1,2))
);
CREATE INDEX "outreach_followups_record_idx" ON "outreach_followups" ("outreach_record_id");
-- At most one pending (DUE) follow-up per record+step; cancelled/postponed rows retained.
CREATE UNIQUE INDEX "outreach_followups_pending_uk" ON "outreach_followups" ("outreach_record_id","step")
  WHERE "status" = 'DUE';

CREATE TABLE "outreach_replies" (
  "id" text PRIMARY KEY NOT NULL,
  "outreach_record_id" text NOT NULL REFERENCES "outreach_records"("id") ON DELETE CASCADE,
  "gmail_thread_id" text NOT NULL,
  "gmail_message_id" text NOT NULL,
  "from_email" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "classification" text NOT NULL,
  "preview" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outreach_reply_classification_ck" CHECK ("classification" IN ('positive','neutral','negative','unsubscribe','bounce'))
);
CREATE INDEX "outreach_replies_record_idx" ON "outreach_replies" ("outreach_record_id");
-- A given Gmail message is recorded as a reply at most once (idempotent sync).
CREATE UNIQUE INDEX "outreach_replies_message_uk" ON "outreach_replies" ("gmail_message_id");

CREATE TABLE "outreach_events" (
  "id" text PRIMARY KEY NOT NULL,
  "outreach_record_id" text NOT NULL REFERENCES "outreach_records"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "type" text NOT NULL,
  "from_status" text,
  "to_status" text,
  "message" text NOT NULL,
  "data" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- Strictly increasing per-record timeline position.
CREATE UNIQUE INDEX "outreach_events_record_seq_uk" ON "outreach_events" ("outreach_record_id","seq");
