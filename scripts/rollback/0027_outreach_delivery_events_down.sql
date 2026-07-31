-- Guarded rollback for 0027_outreach_delivery_events.
--
-- Fails closed if the delivery-events table holds data: reconciliation history
-- (bounces, diagnostics, DSN correlations) must never be silently dropped.
-- Export/clear it deliberately first, then re-run this script on an empty table.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM outreach_delivery_events) THEN
    RAISE EXCEPTION 'Refusing to roll back 0027: outreach_delivery_events is not empty (delivery history must be preserved)';
  END IF;
END $$;

DROP TABLE IF EXISTS "outreach_delivery_events";
