import {
  DatabaseHealthService,
  type DependencyCheckResult,
  QueueHealthService,
} from '@platform/composition';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { HealthController } from './health.controller';

class StubHealthService {
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
  readonly databaseHealth: StubHealthService;
  readonly queueHealth: StubHealthService;
}

async function createHarness(): Promise<Harness> {
  const databaseHealth = new StubHealthService();
  const queueHealth = new StubHealthService();

  const moduleReference = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: DatabaseHealthService, useValue: databaseHealth },
      { provide: QueueHealthService, useValue: queueHealth },
    ],
  }).compile();

  const application = moduleReference.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await application.init();
  await application.getHttpAdapter().getInstance().ready();

  return { application, databaseHealth, queueHealth };
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
    expect(harness.queueHealth.checkCallCount).toBe(0);
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
  it('reports ready when both the database and the queue answer', async () => {
    harness = await createHarness();

    const response = await harness.application.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      checks: { database: { status: 'up' }, queue: { status: 'up' } },
    });
  });

  it('is not ready when it can reach the database but cannot hand work to the worker', async () => {
    harness = await createHarness();
    harness.queueHealth.setResult({
      status: 'down',
      durationMilliseconds: 3,
      reason: 'The bootstrap step has not declared: notification.dispatch.',
    });

    const response = await harness.application.inject({ method: 'GET', url: '/ready' });

    // Accepting notifications nothing will ever deliver is worse than
    // refusing them.
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'not_ready',
      checks: {
        database: { status: 'up' },
        queue: { status: 'down', reason: expect.stringContaining('has not declared') },
      },
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

  it('actually consults both dependencies', async () => {
    harness = await createHarness();

    await harness.application.inject({ method: 'GET', url: '/ready' });

    expect(harness.databaseHealth.checkCallCount).toBe(1);
    expect(harness.queueHealth.checkCallCount).toBe(1);
  });
});
