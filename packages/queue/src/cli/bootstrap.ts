import { applyMigrations, createDatabaseConnection, migrationsFolder } from '@platform/database';

import { grantSendPrivileges, readRoleFromConnectionUrl } from '../grant-send-privileges';
import { provisionQueues } from '../queue-client';

/**
 * The one-shot bootstrap the API and the worker depend on.
 *
 * Doing both steps here, in order, is what removes the startup race: by the
 * time any process that sends or works a job begins, the schema exists and
 * every queue is declared. Running it again is harmless.
 */
async function main(): Promise<void> {
  const connectionUrl = process.env.DATABASE_SYSTEM_URL;

  if (connectionUrl === undefined || connectionUrl.length === 0) {
    process.stderr.write('DATABASE_SYSTEM_URL must be set to bootstrap the database.\n');
    process.exit(1);
  }

  const queueSchema = process.env.QUEUE_SCHEMA ?? 'pgboss';
  const connection = createDatabaseConnection({
    connectionUrl,
    maximumPoolSize: 2,
    applicationName: 'platform-bootstrap',
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

  await provisionQueues(connectionUrl, queueSchema);
  process.stdout.write(`Queues provisioned in schema "${queueSchema}".\n`);

  await grantApplicationSendPrivileges(connectionUrl, queueSchema);
}

/**
 * Runs after the queues exist, because the grant has to cover the tables and
 * per-queue partitions pg-boss has just created.
 */
async function grantApplicationSendPrivileges(
  systemConnectionUrl: string,
  queueSchema: string,
): Promise<void> {
  const applicationUrl = process.env.DATABASE_APPLICATION_URL;

  if (applicationUrl === undefined || applicationUrl.length === 0) {
    // A single-role setup, which is what the test harness uses. Nothing to
    // grant: the one role already owns the schema.
    return;
  }

  const applicationRole = readRoleFromConnectionUrl(applicationUrl);
  if (applicationRole === undefined) {
    process.stderr.write('DATABASE_APPLICATION_URL carries no role name.\n');
    process.exit(1);
  }
  if (applicationRole === readRoleFromConnectionUrl(systemConnectionUrl)) {
    return;
  }

  await grantSendPrivileges(systemConnectionUrl, queueSchema, applicationRole);
  process.stdout.write(`Granted "${applicationRole}" permission to enqueue jobs.\n`);
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    process.stderr.write(`Bootstrap failed: ${String(error)}\n`);
    process.exit(1);
  }
}

void run();
