-- Tenant isolation enforced by the database rather than only by the queries.
--
-- Every repository already filters by application_id, and the composite foreign
-- keys already make a cross-tenant reference impossible to write. Neither helps
-- against the one mistake that is easy to make and invisible in review: a query
-- that forgets the predicate. Under these policies that mistake returns nothing
-- instead of another tenant's data.
--
-- platform_tenant cannot log in. A request authenticated by an API key enters
-- it with SET LOCAL ROLE for the length of a single transaction, so the switch
-- expires with the transaction that made it and cannot be left behind on a
-- pooled connection. Work that legitimately spans applications — the dashboard,
-- authorised by organisation membership, and the worker, which dispatches for
-- every tenant — keeps running as the login role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_tenant') THEN
    CREATE ROLE platform_tenant NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO platform_tenant;
--> statement-breakpoint

-- The narrowest set that serves the public API: read the application it is
-- authenticated as, resolve a connection, write notifications and their
-- timeline, and claim idempotency keys. No DELETE anywhere, and nothing at all
-- on users, organisations, sessions, API keys or the webhook inbox — a table
-- the role cannot reach needs no policy to protect it.
GRANT SELECT ON applications, whatsapp_sessions TO platform_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON notifications TO platform_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT ON notification_events TO platform_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO platform_tenant;
--> statement-breakpoint

-- The status transition trigger runs with the privileges of whoever performed
-- the write, so the role that updates a notification has to be able to read the
-- table the trigger consults.
GRANT SELECT ON notification_statuses, notification_status_transitions TO platform_tenant;
--> statement-breakpoint

-- One policy, applied identically to every table that carries application_id.
-- Written as a loop on purpose: eight hand-copied predicates are eight chances
-- for one of them to drift, and a drifted predicate is a silent leak. A test
-- asserts that every such table is covered.
--
-- Roles other than platform_tenant are unrestricted, which is what keeps the
-- worker and the dashboard working. The table owner is exempt from its own
-- policies unless they are forced, and that exemption is deliberate: migrations
-- and maintenance run as the owner.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'api_keys',
    'idempotency_keys',
    'notification_events',
    'notification_send_attempts',
    'notifications',
    'templates',
    'webhook_deliveries',
    'whatsapp_sessions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format(
      $policy$
        CREATE POLICY tenant_isolation ON %I FOR ALL TO PUBLIC
          USING (
            current_user <> 'platform_tenant'
            OR application_id = nullif(current_setting('app.current_application_id', true), '')::uuid
          )
          WITH CHECK (
            current_user <> 'platform_tenant'
            OR application_id = nullif(current_setting('app.current_application_id', true), '')::uuid
          )
      $policy$,
      target
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- The applications table is the one exception: it is identified by the tenant
-- key rather than carrying it.
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON applications FOR ALL TO PUBLIC
  USING (
    current_user <> 'platform_tenant'
    OR id = nullif(current_setting('app.current_application_id', true), '')::uuid
  )
  WITH CHECK (
    current_user <> 'platform_tenant'
    OR id = nullif(current_setting('app.current_application_id', true), '')::uuid
  );
