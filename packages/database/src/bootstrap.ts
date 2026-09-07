import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { type Pool } from 'pg';

import { type Database } from './connection';

/**
 * A fixed key so every process contends for the same lock. The value is
 * arbitrary but must never change, or two releases could migrate concurrently.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 8_071_542_390_114_772n;

export interface MigrationOptions {
  readonly database: Database;
  readonly pool: Pool;
  readonly migrationsFolder: string;
}

/**
 * Applies migrations under a session-level advisory lock.
 *
 * Drizzle's migrator is not safe to run concurrently: two processes starting
 * together can both see an empty migrations table and apply the same file.
 * Holding the lock on a dedicated client makes a second caller wait and then
 * observe the completed state, so the API, the worker and a one-shot migrate
 * container can all run this without coordination.
 */
export async function applyMigrations(options: MigrationOptions): Promise<void> {
  const client = await options.pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
    await migrate(options.database, { migrationsFolder: options.migrationsFolder });
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY.toString()]);
    client.release();
  }
}
