import { DatabaseHealthService, type DependencyCheckResult } from '@platform/composition';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { HealthController } from './health.controller';

class StubDatabaseHealthService {
  private result: DependencyCheckResult = { status: 'up', durationMilliseconds: 1 };
  public checkCallCount = 0;

  public setResult(result: DependencyCheckResult): void {
    this.result = result;
  }

  public check(): Promise<DependencyCheckResult> {
    this.checkCallCount += 1;
    return Promise.resolve(this.result);
  }
}

interface Harness {
  readonly application: NestFastifyApplication;
  readonly databaseHealth: StubDatabaseHealthService;
}

async function createHarness(): Promise<Harness> {
  const databaseHealth = new StubDatabaseHealthService();

  const moduleReference = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [{ provide: DatabaseHealthService, useValue: databaseHealth }],
  }).compile();

  const application = moduleReference.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await application.init();
  await application.getHttpAdapter().getInstance().ready();

  return { application, databaseHealth };
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.application.close();
  harness = undefined;
});

describe('GET /health', () => {
  it('reports the process as alive', async () => {
    harness = await createHarness();

    const response = await harness.application.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'api' });
  });

  it('never touches a dependency, so a database blip cannot trigger a restart storm', async () => {
    harness = await createHarness();

    await harness.application.inject({ method: 'GET', url: '/health' });

    expect(harness.databaseHealth.checkCallCount).toBe(0);
  });

  it('stays available while the database is down', async () => {
    harness = await createHarness();
    harness.databaseHealth.setResult({
      status: 'down',
      durationMilliseconds: 2000,
      reason: 'connection refused',
    });

    const response = await harness.application.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
  });
});

describe('GET /ready', () => {
  it('reports ready when the database answers', async () => {
    harness = await createHarness();

    const response = await harness.application.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      checks: { database: { status: 'up' } },
    });
  });

  it('reports 503 and the reason when the database is unreachable', async () => {
    harness = await createHarness();
    harness.databaseHealth.setResult({
      status: 'down',
      durationMilliseconds: 2000,
      reason: 'The database did not respond within the probe timeout.',
    });

    const response = await harness.application.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'not_ready',
      checks: { database: { status: 'down', reason: expect.stringContaining('timeout') } },
    });
  });

  it('actually consults the dependency', async () => {
    harness = await createHarness();

    await harness.application.inject({ method: 'GET', url: '/ready' });

    expect(harness.databaseHealth.checkCallCount).toBe(1);
  });
});
