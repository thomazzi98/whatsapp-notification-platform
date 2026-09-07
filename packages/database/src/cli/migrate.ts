import path from 'node:path';

import { applyMigrations } from '../bootstrap';
import { createDatabaseConnection } from '../connection';

/**
 * Entry point for the one-shot migrate container.
 *
 * It validates only the database settings rather than the whole application
 * configuration: this process has no HTTP server, no queue worker and no
 * WhatsApp provider, so demanding those variables would make the migration step
 * fail for reasons that have nothing to do with migrating.
 */
async function main(): Promise<void> {
  const connectionUrl = process.env.DATABASE_SYSTEM_URL;

  if (connectionUrl === undefined || connectionUrl.length === 0) {
    process.stderr.write('DATABASE_SYSTEM_URL must be set to run migrations.\n');
    process.exit(1);
  }

  const migrationsFolder =
    process.env.DATABASE_MIGRATIONS_FOLDER ?? path.resolve(process.cwd(), 'migrations');

  const connection = createDatabaseConnection({
    connectionUrl,
    maximumPoolSize: 2,
    applicationName: 'platform-migrate',
  });

  try {
    await applyMigrations({
      database: connection.database,
      pool: connection.pool,
      migrationsFolder,
    });
    process.stdout.write(`Migrations applied from ${migrationsFolder}.\n`);
  } finally {
    await connection.close();
  }
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    process.stderr.write(`Migration failed: ${String(error)}\n`);
    process.exit(1);
  }
}

void run();
