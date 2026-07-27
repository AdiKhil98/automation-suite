-- Guarded rollback for 0026_outreach_tracking.
--
-- Fails closed if ANY Phase 17A outreach table holds data: outreach history
-- (records, immutable messages, replies, events) must never be silently dropped.
-- Truncate/export deliberately first, then re-run this script on empty tables.

DO $$
DECLARE
  populated_table text;
BEGIN
  SELECT table_name INTO populated_table
  FROM (
    VALUES
      ('outreach_events'),
      ('outreach_replies'),
      ('outreach_followups'),
      ('outreach_messages'),
      ('outreach_records'),
      ('outreach_campaigns')
  ) AS candidates(table_name)
  WHERE CASE table_name
    WHEN 'outreach_events' THEN EXISTS (SELECT 1 FROM outreach_events)
    WHEN 'outreach_replies' THEN EXISTS (SELECT 1 FROM outreach_replies)
    WHEN 'outreach_followups' THEN EXISTS (SELECT 1 FROM outreach_followups)
    WHEN 'outreach_messages' THEN EXISTS (SELECT 1 FROM outreach_messages)
    WHEN 'outreach_records' THEN EXISTS (SELECT 1 FROM outreach_records)
    WHEN 'outreach_campaigns' THEN EXISTS (SELECT 1 FROM outreach_campaigns)
    ELSE false
  END
  LIMIT 1;

  IF populated_table IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to roll back 0026: table % is not empty (outreach history must be preserved)', populated_table;
  END IF;
END $$;

DROP TABLE IF EXISTS "outreach_events";
DROP TABLE IF EXISTS "outreach_replies";
DROP TABLE IF EXISTS "outreach_followups";
DROP TABLE IF EXISTS "outreach_messages";
DROP TABLE IF EXISTS "outreach_records";
DROP TABLE IF EXISTS "outreach_campaigns";
