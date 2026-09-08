import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type TestProject } from 'vitest/node';

/**
 * One container for the whole integration run.
 *
 * Starting a container per test file is what makes these suites unbearable on
 * Docker Desktop; tests isolate themselves with distinct fixture data instead.
 */
let container: StartedPostgreSqlContainer | undefined;

/**
 * Two minutes is the library's default and it is not enough on Docker Desktop,
 * where `initdb` on a cold cache regularly runs past it.
 */
const CONTAINER_STARTUP_TIMEOUT_MILLISECONDS = 300_000;

export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('notifications_test')
    .withUsername('platform_system')
    .withPassword('platform_system_password')
    .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MILLISECONDS)
    .start();

  project.provide('databaseUrl', container.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
  }
}
