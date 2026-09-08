import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { applyMigrations } from './bootstrap';
import { createDatabaseConnection, type DatabaseConnection } from './connection';
import { withTenantScope } from './tenant-scope';

let connection: DatabaseConnection;
let firstApplicationId: string;
let secondApplicationId: string;
let firstNotificationId: string;
let secondNotificationId: string;

let notificationCounter = 0;

/**
 * Suites share one database, so identifiers carry a per-suite prefix rather
 * than starting from zero and colliding with another suite's fixtures.
 */
function notificationIdentifier(counter: number): string {
  return `0000150a-0000-7000-8000-${String(counter).padStart(12, '0')}`;
}

interface TenantFixture {
  readonly applicationId: string;
  readonly notificationId: string;
}

async function createTenant(suffix: string): Promise<TenantFixture> {
  const organization = await connection.database.execute<{ id: string }>(sql`
    insert into organizations (name, slug) values (${suffix}, ${suffix}) returning id
  `);
  const application = await connection.database.execute<{ id: string }>(sql`
    insert into applications (organization_id, name, slug)
    values (${organization.rows[0]?.id ?? ''}, ${suffix}, ${suffix}) returning id
  `);
  const applicationId = application.rows[0]?.id ?? '';

  const session = await connection.database.execute<{ id: string }>(sql`
    insert into whatsapp_sessions
      (application_id, provider_session_name, display_name, webhook_signing_key_ciphertext)
    values (${applicationId}, ${suffix}, ${suffix}, decode('00', 'hex'))
    returning id
  `);

  // Notification identifiers are UUIDv7 chosen by the application rather than by
  // the database, so a fixture has to supply one.
  notificationCounter += 1;
  const notificationId = notificationIdentifier(notificationCounter);

  await connection.database.execute(sql`
    insert into notifications
      (id, application_id, whatsapp_session_id, status, recipient_phone_number, rendered_body)
    values (${notificationId}, ${applicationId}, ${session.rows[0]?.id ?? ''}, 'QUEUED',
            '+5511999998888', ${suffix})
  `);

  return { applicationId, notificationId };
}

beforeAll(async () => {
  connection = createDatabaseConnection({
    connectionUrl: inject('databaseUrl'),
    maximumPoolSize: 4,
    applicationName: 'tenant-isolation-test',
  });

  await applyMigrations({
    database: connection.database,
    pool: connection.pool,
    migrationsFolder: './migrations',
  });

  const stamp = Date.now().toString(36);
  const first = await createTenant(`isolation-first-${stamp}`);
  const second = await createTenant(`isolation-second-${stamp}`);

  firstApplicationId = first.applicationId;
  secondApplicationId = second.applicationId;
  firstNotificationId = first.notificationId;
  secondNotificationId = second.notificationId;
}, 180_000);

afterAll(async () => {
  await connection.close();
});

describe('a query that forgets to scope itself', () => {
  it('returns only the tenant in scope, rather than every tenant', async () => {
    // Deliberately unfiltered. This is the bug the policies exist to survive.
    const visible = await withTenantScope(
      connection.database,
      firstApplicationId,
      async (transaction) => transaction.execute<{ id: string }>(sql`select id from notifications`),
    );

    const identifiers = visible.rows.map((row) => row.id);
    expect(identifiers).toContain(firstNotificationId);
    expect(identifiers).not.toContain(secondNotificationId);
  });

  it('shows the tenant only its own application row', async () => {
    const visible = await withTenantScope(
      connection.database,
      firstApplicationId,
      async (transaction) => transaction.execute<{ id: string }>(sql`select id from applications`),
    );

    expect(visible.rows.map((row) => row.id)).toEqual([firstApplicationId]);
  });

  it('leaves the same query unrestricted for the role the worker uses', async () => {
    const visible = await connection.database.execute<{ id: string }>(
      sql`select id from notifications`,
    );

    const identifiers = visible.rows.map((row) => row.id);
    expect(identifiers).toContain(firstNotificationId);
    expect(identifiers).toContain(secondNotificationId);
  });
});

describe('a write aimed at another tenant', () => {
  it('is refused rather than silently accepted', async () => {
    const session = await connection.database.execute<{ id: string }>(sql`
      select id from whatsapp_sessions where application_id = ${secondApplicationId}
    `);
    const sessionId = session.rows[0]?.id ?? '';

    const attemptWrite = async (): Promise<string | undefined> => {
      try {
        await withTenantScope(connection.database, firstApplicationId, async (transaction) => {
          await transaction.execute(sql`
            insert into notifications
              (id, application_id, whatsapp_session_id, status, recipient_phone_number,
               rendered_body)
            values (${notificationIdentifier(900)}, ${secondApplicationId}, ${sessionId}, 'QUEUED',
                    '+5511999997777', 'Written across a tenant boundary')
          `);
        });

        return undefined;
      } catch (error: unknown) {
        // The driver's own message is the failed statement; the reason
        // Postgres gave is on the cause.
        return (error as { cause?: { message?: string } }).cause?.message;
      }
    };

    expect(await attemptWrite()).toMatch(/row-level security/i);
  });

  it('cannot reach the row it does not own through an update either', async () => {
    await withTenantScope(connection.database, firstApplicationId, async (transaction) => {
      await transaction.execute(sql`
        update notifications set rendered_body = 'Rewritten' where id = ${secondNotificationId}
      `);
    });

    const untouched = await connection.database.execute<{ rendered_body: string }>(sql`
      select rendered_body from notifications where id = ${secondNotificationId}
    `);

    expect(untouched.rows[0]?.rendered_body).not.toBe('Rewritten');
  });
});

describe('the scope itself', () => {
  it('does not outlive the transaction that opened it', async () => {
    await withTenantScope(connection.database, firstApplicationId, async (transaction) => {
      await transaction.execute(sql`select 1`);
    });

    const afterwards = await connection.database.execute<{
      role: string;
      application: string | null;
    }>(
      sql`select current_user as role, current_setting('app.current_application_id', true) as application`,
    );

    expect(afterwards.rows[0]?.role).not.toBe('platform_tenant');
    // Postgres reverts a transaction-local setting to what it was before, and a
    // custom setting that was never set reads as the empty string rather than
    // as null. The policies compare through `nullif`, so the empty string means
    // no tenant is in scope and nothing is visible.
    expect(afterwards.rows[0]?.application ?? '').toBe('');
  });

  it('is entered through a role that cannot log in', async () => {
    const role = await connection.database.execute<{ rolcanlogin: boolean }>(sql`
      select rolcanlogin from pg_roles where rolname = 'platform_tenant'
    `);

    expect(role.rows[0]?.rolcanlogin).toBe(false);
  });
});

describe('the policies themselves', () => {
  it('cover every table that carries a tenant key', async () => {
    const unprotected = await connection.database.execute<{ table_name: string }>(sql`
      select columns.table_name
      from information_schema.columns as columns
      join pg_class as tables on tables.relname = columns.table_name
      join pg_namespace as schemas
        on schemas.oid = tables.relnamespace and schemas.nspname = columns.table_schema
      where columns.table_schema = 'public'
        and columns.column_name = 'application_id'
        and (
          tables.relrowsecurity = false
          or not exists (
            select 1 from pg_policies
            where pg_policies.tablename = columns.table_name
              and pg_policies.policyname = 'tenant_isolation'
          )
        )
    `);

    expect(unprotected.rows).toEqual([]);
  });

  it('keep the tenant role away from the tables it has no business reading', async () => {
    const reachable = await connection.database.execute<{ table_name: string }>(sql`
      select table_name from (
        values ('users'), ('organizations'), ('user_sessions'), ('api_keys'),
               ('webhook_deliveries'), ('rate_limit_buckets')
      ) as forbidden(table_name)
      where has_table_privilege('platform_tenant', table_name, 'SELECT')
    `);

    expect(reachable.rows).toEqual([]);
  });
});
