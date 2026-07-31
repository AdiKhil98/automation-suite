-- Phase 17C: delivery failure reconciliation (read-only detection + terminal bounce state).
-- Additive only. No existing table is altered. Records the correlation between a tracked
-- outbound message and a Gmail Delivery Status Notification (DSN), plus the diagnostic
-- fields required to make the outreach state auditable. Immutable sent-message history is
-- never overwritten: a message stays historically "sent" while its outreach record state
-- may become BOUNCED. No sending, drafting, or Gmail mutation is introduced by this migration.

CREATE TABLE "outreach_delivery_events" (
  "id" text PRIMARY KEY NOT NULL,
  "outreach_record_id" text NOT NULL REFERENCES "outreach_records"("id") ON DELETE CASCADE,
  "outreach_message_id" text REFERENCES "outreach_messages"("id") ON DELETE SET NULL,
  "delivery_status" text NOT NULL,
  "permanence" text NOT NULL,
  "rejection_code" text,
  "diagnostic_text" text,
  "dsn_status" text,
  "dsn_action" text,
  "final_recipient" text,
  "original_recipient" text,
  "bounce_at" timestamp with time zone,
  "original_gmail_message_id" text,
  "original_gmail_thread_id" text,
  "dsn_gmail_message_id" text NOT NULL,
  "dsn_gmail_thread_id" text,
  "preview" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outreach_delivery_status_ck" CHECK ("delivery_status" IN ('DELIVERED','BOUNCED','DELIVERY_UNKNOWN')),
  CONSTRAINT "outreach_delivery_permanence_ck" CHECK ("permanence" IN ('PERMANENT','TEMPORARY','UNKNOWN'))
);
CREATE INDEX "outreach_delivery_events_record_idx" ON "outreach_delivery_events" ("outreach_record_id");
-- A given DSN Gmail message is recorded at most once (idempotent reconciliation).
CREATE UNIQUE INDEX "outreach_delivery_events_dsn_uk" ON "outreach_delivery_events" ("dsn_gmail_message_id");
