import { logEvents } from '@platform/observability';
import { queueNames } from '@platform/queue';
import { createTestConfiguration } from '@platform/testing';
import { type Job } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';

import { JobRunnerService } from './job-runner.service';
import { type NotificationDispatchHandler } from './notification-dispatch.handler';
import { type NotificationMaintenanceHandler } from './notification-maintenance.handler';
import { type WebhookProcessHandler } from './webhook-process.handler';

// Silenced: these tests deliberately exercise the paths that log errors, and
// the real output would bury a genuine failure.
const configuration = createTestConfiguration('postgres://unused.invalid:5432/notifications', {
  observability: { logLevel: 'fatal', logFormat: 'json', recipientSalt: 'unused' },
});

function createJob(id: string): Job<unknown> {
  return {
    id,
    name: 'notification.dispatch',
    data: {},
    expireInSeconds: 120,
    heartbeatSeconds: null,
    signal: new AbortController().signal,
  };
}

/** The runner only routes here; the handlers it would call are irrelevant. */
function createRunner(): JobRunnerService {
  const handler = { handle: vi.fn() };
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

  return new JobRunnerService(
    {} as never,
    configuration,
    handler as unknown as NotificationDispatchHandler,
    handler as unknown as NotificationMaintenanceHandler,
    handler as unknown as WebhookProcessHandler,
    logger as never,
  );
}

interface SubscribedQueue {
  readonly name: string;
  readonly handle: (jobs: Job<unknown>[]) => unknown;
}

/**
 * Captures what the runner subscribes to, rather than mocking pg-boss wholesale.
 *
 * `subscribe` was the one method here nothing called: the dead letter handler in
 * particular could have been deleted, or wired to the wrong queue, without a
 * single test noticing — and its whole job is to be the last thing that speaks
 * before a notification is abandoned.
 */
function createSubscribedRunner(): {
  runner: JobRunnerService;
  queues: SubscribedQueue[];
  logger: { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  schedule: ReturnType<typeof vi.fn>;
} {
  const queues: SubscribedQueue[] = [];
  const schedule = vi.fn(() => Promise.resolve(''));
  const queue = {
    work: vi.fn((name: string, _options: unknown, handle: (jobs: Job<unknown>[]) => unknown) => {
      queues.push({ name, handle });

      return Promise.resolve(name);
    }),
    schedule,
  };
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const handler = { handle: vi.fn() };

  const runner = new JobRunnerService(
    queue as never,
    configuration,
    handler as unknown as NotificationDispatchHandler,
    handler as unknown as NotificationMaintenanceHandler,
    handler as unknown as WebhookProcessHandler,
    logger as never,
  );

  return { runner, queues, logger, schedule };
}

describe('subscribing the worker to its queues', () => {
  it('takes work from every queue the platform declares', async () => {
    const { runner, queues } = createSubscribedRunner();

    await runner.subscribe();

    expect(queues.map((queue) => queue.name)).toStrictEqual([
      queueNames.notificationDispatch,
      queueNames.notificationDeadLetter,
      queueNames.webhookProcess,
      queueNames.maintenanceReconcile,
    ]);
  });

  it('schedules the repair pass, which nothing else would start', async () => {
    const { runner, schedule } = createSubscribedRunner();

    await runner.subscribe();

    expect(schedule).toHaveBeenCalledWith(queueNames.maintenanceReconcile, expect.any(String));
  });
});

async function runDeadLetterHandler(jobs: Job<unknown>[]): Promise<{
  logger: { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
}> {
  const { runner, queues, logger } = createSubscribedRunner();
  await runner.subscribe();
  const deadLetter = queues.find((queue) => queue.name === queueNames.notificationDeadLetter);

  await deadLetter?.handle(jobs);

  return { logger };
}

describe('a notification that has been dead lettered', () => {
  it('is reported at error level, naming the job an operator has to find', async () => {
    const { logger } = await runDeadLetterHandler([createJob('dead-one')]);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: logEvents.notificationDeadLettered,
        jobId: 'dead-one',
      }),
      expect.any(String),
    );
  });

  it('reports every job in the batch, not just the first', async () => {
    const { logger } = await runDeadLetterHandler([
      createJob('dead-one'),
      createJob('dead-two'),
      createJob('dead-three'),
    ]);

    expect(logger.error).toHaveBeenCalledTimes(3);
  });

  it('settles rather than throwing, so the dead letter queue does not itself back up', async () => {
    const { runner, queues } = createSubscribedRunner();
    await runner.subscribe();
    const deadLetter = queues.find((queue) => queue.name === queueNames.notificationDeadLetter);

    await expect(deadLetter?.handle([createJob('dead-one')])).resolves.toBeUndefined();
  });
});

describe('settling a batch of jobs', () => {
  it('completes every job when they all succeed', async () => {
    const results = await createRunner().settleEach([createJob('a'), createJob('b')], () =>
      Promise.resolve(),
    );

    expect(results).toEqual([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'completed' },
    ]);
  });

  it('fails only the job that threw', async () => {
    // Without per-job settlement, one notification hitting a transient error
    // would drag every other message in the batch into a needless retry.
    const results = await createRunner().settleEach(
      [createJob('a'), createJob('b'), createJob('c')],
      (job) => (job.id === 'b' ? Promise.reject(new Error('boom')) : Promise.resolve()),
    );

    expect(results).toEqual([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'failed' },
      { id: 'c', status: 'completed' },
    ]);
  });

  it('runs the jobs in a batch concurrently rather than one after another', async () => {
    let inFlight = 0;
    let peakInFlight = 0;

    await createRunner().settleEach([createJob('a'), createJob('b'), createJob('c')], async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
    });

    // Awaiting them in sequence would make the configured batch size a lie:
    // the worker would fetch five jobs and then process one at a time.
    expect(peakInFlight).toBe(3);
  });
});
