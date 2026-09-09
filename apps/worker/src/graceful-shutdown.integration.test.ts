import {
  DatabaseModule,
  ObservabilityModule,
  QUEUE_CLIENT,
  QueueModule,
} from '@platform/composition';
import { type ApplicationConfiguration } from '@platform/configuration';
import { createTestConfiguration } from '@platform/testing';
import { Test, type TestingModule } from '@nestjs/testing';
import { type PgBoss } from 'pg-boss';
import { afterEach, describe, expect, inject, it } from 'vitest';

/**
 * Shutdown is the one behaviour that only fails in production.
 *
 * Everything else in the worker is exercised by calling it; the drain is
 * exercised by an orchestrator sending SIGTERM while a message is halfway to
 * WhatsApp. Nothing in the suite proved the in-flight handler is allowed to
 * finish, so removing the graceful `stop` left every test green — and the only
 * symptom would have been notifications abandoned mid-send on every deploy.
 *
 * Both halves matter, and they pull against each other: a shutdown that does
 * not wait loses work, and a shutdown that waits without a bound never ends.
 */
const probeQueue = 'test.graceful_shutdown_probe';

interface HandlerTrace {
  startedAt?: number;
  finishedAt?: number;
}

let moduleReference: TestingModule | undefined;

async function startWorkerWith(options: {
  readonly shutdownTimeoutSeconds: number;
  readonly handlerDurationMilliseconds: number;
}): Promise<HandlerTrace> {
  const base = createTestConfiguration(inject('databaseUrl'));
  const configuration: ApplicationConfiguration = {
    ...base,
    queue: { ...base.queue, shutdownTimeoutSeconds: options.shutdownTimeoutSeconds },
  };

  moduleReference = await Test.createTestingModule({
    imports: [
      ObservabilityModule.forConfiguration(configuration, { serviceName: 'shutdown-test' }),
      DatabaseModule.forConfiguration(configuration, { applicationName: 'shutdown-test' }),
      QueueModule.forConfiguration(configuration, { supervise: false }),
    ],
  }).compile();

  const queue = moduleReference.get<PgBoss>(QUEUE_CLIENT);
  const trace: HandlerTrace = {};

  await queue.createQueue(probeQueue);
  await queue.work(probeQueue, { batchSize: 1, pollingIntervalSeconds: 1 }, async () => {
    trace.startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, options.handlerDurationMilliseconds));
    trace.finishedAt = Date.now();
  });
  await queue.send(probeQueue, {});

  // Shutting down before the job is picked up would prove nothing, so wait for
  // the handler to actually be running.
  const deadline = Date.now() + 20_000;
  while (trace.startedAt === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(trace.startedAt).toBeDefined();

  return trace;
}

afterEach(async () => {
  const leftOpen = moduleReference;
  moduleReference = undefined;
  await leftOpen?.close();
});

describe('shutting the worker down', () => {
  it('lets a job that is already running finish before it returns', async () => {
    const trace = await startWorkerWith({
      shutdownTimeoutSeconds: 10,
      handlerDurationMilliseconds: 1500,
    });

    const closing = moduleReference;
    moduleReference = undefined;
    await closing?.close();
    const returnedAt = Date.now();

    expect(trace.finishedAt).toBeDefined();
    // Not merely "it finished": it finished before the shutdown handed control
    // back. A handler still running past this point is killed by the process
    // exit that follows.
    expect(trace.finishedAt ?? Infinity).toBeLessThanOrEqual(returnedAt);
  });

  it('gives up on a job that outruns its budget rather than hanging with it', async () => {
    const trace = await startWorkerWith({
      shutdownTimeoutSeconds: 1,
      handlerDurationMilliseconds: 20_000,
    });

    const closing = moduleReference;
    moduleReference = undefined;
    const startedClosingAt = Date.now();
    await closing?.close();

    expect(trace.finishedAt).toBeUndefined();
    // The budget, plus room for the poll that notices it, and far below the
    // twenty seconds the handler wants. An orchestrator's SIGKILL deadline is
    // what this is racing. The job itself is not lost: its claim is reaped,
    // which notification-dispatch.integration.test.ts covers.
    expect(Date.now() - startedClosingAt).toBeLessThan(10_000);
  });
});
