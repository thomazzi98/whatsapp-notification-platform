import path from 'node:path';

import { startTestDatabase, type StartedTestDatabase } from '@platform/testing';
import { type TestProject } from 'vitest/node';

let database: StartedTestDatabase | undefined;

export async function setup(project: TestProject): Promise<void> {
  const migrationsFolder = path.resolve(process.cwd(), '../../packages/database/migrations');

  database = await startTestDatabase(migrationsFolder);
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
