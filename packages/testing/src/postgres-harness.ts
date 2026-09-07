import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';

import {
  applyMigrations,
  createDatabaseConnection,
  type DatabaseConnection,
} from '@platform/database';

export interface StartedTestDatabase {
  readonly connectionUrl: string;
  stop: () => Promise<void>;
}

/**
 * One container per test run, started in a global setup.
 *
 * A container per test file is what makes these suites unbearable on Docker
 * Desktop; isolation comes from truncating between tests instead.
 */
export async function startTestDatabase(migrationsFolder: string): Promise<StartedTestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('notifications_test')
    .withUsername('platform_system')
    .withPassword('platform_system_password')
    .start();

  const connectionUrl = container.getConnectionUri();
  const connection = createDatabaseConnection({
    connectionUrl,
    maximumPoolSize: 2,
    applicationName: 'test-migrations',
  });

  try {
    await applyMigrations({
      database: connection.database,
      pool: connection.pool,
      migrationsFolder,
    });
  } finally {
    await connection.close();
  }

  return {
    connectionUrl,
    stop: async () => {
      await container.stop();
    },
  };
}

export interface TestDatabaseHandle {
  /** Empties every table so each test starts from a known state. */
  truncateAllTables: () => Promise<void>;
  /**
   * Creates the WhatsApp connection a notification needs, without going through
   * the provider. Pairing a real session requires a human with a phone.
   */
  insertWhatsAppSession: (applicationId: string, providerSessionName: string) => Promise<string>;
  /** Dispatch jobs queued for one notification. */
  countDispatchJobs: (notificationId: string) => Promise<number>;
  countAllDispatchJobs: () => Promise<number>;
  close: () => Promise<void>;
}

/**
 * The only database access a test needs.
 *
 * Exposing this here is what keeps application test files from importing the
 * persistence adapter directly, which the layering rules forbid for good
 * reason: a test that can reach the database can also quietly depend on its
 * internals.
 */
export function connectToTestDatabase(connectionUrl: string): TestDatabaseHandle {
  const connection: DatabaseConnection = createDatabaseConnection({
    connectionUrl,
    maximumPoolSize: 2,
    applicationName: 'test-fixtures',
  });

  async function countJobs(condition: ReturnType<typeof sql> | undefined): Promise<number> {
    const result = await connection.database.execute<{ count: string }>(
      condition === undefined
        ? sql`select count(*)::text as count from pgboss.job where name = 'notification.dispatch'`
        : sql`select count(*)::text as count from pgboss.job
              where name = 'notification.dispatch' and ${condition}`,
    );

    return Number(result.rows[0]?.count ?? '0');
  }

  return {
    insertWhatsAppSession: async (applicationId, providerSessionName) => {
      const result = await connection.database.execute<{ id: string }>(sql`
        insert into whatsapp_sessions
          (application_id, provider_session_name, display_name,
           webhook_signing_key_ciphertext, status)
        values (${applicationId}, ${providerSessionName}, 'Test connection',
                decode('00', 'hex'), 'WORKING')
        returning id
      `);
      const identifier = result.rows[0]?.id;

      if (identifier === undefined) {
        throw new Error('Failed to insert the test WhatsApp session.');
      }
      return identifier;
    },
    countDispatchJobs: async (notificationId) =>
      countJobs(sql`data->>'notificationId' = ${notificationId}`),
    countAllDispatchJobs: async () => countJobs(undefined),
    truncateAllTables: async () => {
      // Reference data seeded by a migration must survive: the notification
      // status foreign key points at it, so truncating it makes every insert
      // fail with a confusing constraint error.
      const result = await connection.database.execute<{ tablename: string }>(
        sql`select tablename from pg_tables
            where schemaname = 'public'
              and tablename not like '__drizzle%'
              and tablename not in ('notification_statuses', 'notification_status_transitions')`,
      );
      const tableNames = result.rows.map((row) => `"${row.tablename}"`);

      if (tableNames.length === 0) {
        return;
      }
      await connection.database.execute(
        sql.raw(`truncate table ${tableNames.join(', ')} restart identity cascade`),
      );
      // Jobs left behind would block the next send for the same key under the
      // dispatch queue's exclusive policy.
      await connection.database.execute(sql`delete from pgboss.job`);
    },
    close: async () => {
      await connection.close();
    },
  };
}
