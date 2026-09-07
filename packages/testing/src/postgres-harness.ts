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

  return {
    truncateAllTables: async () => {
      const result = await connection.database.execute<{ tablename: string }>(
        sql`select tablename from pg_tables
            where schemaname = 'public' and tablename not like '__drizzle%'`,
      );
      const tableNames = result.rows.map((row) => `"${row.tablename}"`);

      if (tableNames.length === 0) {
        return;
      }
      await connection.database.execute(
        sql.raw(`truncate table ${tableNames.join(', ')} restart identity cascade`),
      );
    },
    close: async () => {
      await connection.close();
    },
  };
}
