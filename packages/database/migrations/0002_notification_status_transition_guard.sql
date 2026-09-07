-- The notification lifecycle, enforced by the database.
--
-- The same table is expressed in TypeScript in packages/domain, and a drift
-- test asserts the two agree. Keeping it here as well means no code path can
-- bypass it: not a future admin script, not a data fix typed into psql, not a
-- migration written in a hurry.

INSERT INTO notification_statuses (status)
VALUES
  ('SCHEDULED'),
  ('QUEUED'),
  ('PROCESSING'),
  ('SENT'),
  ('DELIVERED'),
  ('RETRYING'),
  ('FAILED'),
  ('CANCELLED')
ON CONFLICT (status) DO NOTHING;
--> statement-breakpoint

-- Deliberate omissions, each with a reason:
--   FAILED has no outgoing edges. Retrying creates a new notification that
--   points back at this one, so the audit trail is never rewritten.
--   PROCESSING cannot be cancelled. A provider call may already be in flight
--   and a sent WhatsApp message cannot be revoked.
--   DELIVERED is terminal. A read receipt updates read_at without changing
--   status, because read receipts are optional and their absence is not a
--   delivery failure.
INSERT INTO notification_status_transitions (from_status, to_status)
VALUES
  ('SCHEDULED', 'QUEUED'),
  ('SCHEDULED', 'CANCELLED'),
  ('QUEUED', 'PROCESSING'),
  ('QUEUED', 'CANCELLED'),
  ('PROCESSING', 'SENT'),
  ('PROCESSING', 'RETRYING'),
  ('PROCESSING', 'FAILED'),
  ('SENT', 'DELIVERED'),
  ('SENT', 'FAILED'),
  ('RETRYING', 'PROCESSING'),
  ('RETRYING', 'CANCELLED'),
  ('RETRYING', 'FAILED')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_notification_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- An update that does not touch the status is none of this trigger's
  -- business; timestamps and acknowledgements change constantly.
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM notification_status_transitions
    WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION
      'illegal notification status transition % -> % for notification %',
      OLD.status, NEW.status, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER notifications_enforce_status_transition
  BEFORE UPDATE OF status ON notifications
  FOR EACH ROW EXECUTE FUNCTION enforce_notification_status_transition();
--> statement-breakpoint

-- notification_events is an audit trail. Revoking the privileges is what makes
-- "append only" a property of the database rather than a convention.
REVOKE UPDATE, DELETE ON notification_events FROM PUBLIC;
