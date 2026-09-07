import path from 'node:path';

import { startTestDatabase, type StartedTestDatabase } from '@platform/testing';
import { type TestProject } from 'vitest/node';

import { provisionQueues } from '../src/queue-client';

let database: StartedTestDatabase | undefined;

export async function setup(project: TestProject): Promise<void> {
  const migrationsFolder = path.resolve(process.cwd(), '../database/migrations');

  database = await startTestDatabase(migrationsFolder);
  // Mirrors the one-shot migrate container: schema first, then queues, before
  // anything that sends or works a job exists.
  await provisionQueues(database.connectionUrl, 'pgboss');

  project.provide('databaseUrl', database.connectionUrl);
}

export async function teardown(): Promise<void> {
  await database?.stop();
}

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
  }
}
