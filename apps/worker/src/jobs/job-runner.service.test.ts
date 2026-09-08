import { createTestConfiguration } from '@platform/testing';
import { type Job } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';

import { JobRunnerService } from './job-runner.service';
import { type NotificationDispatchHandler } from './notification-dispatch.handler';
import { type NotificationMaintenanceHandler } from './notification-maintenance.handler';

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

function createRunner(handle: (job: Job<unknown>) => Promise<void>): JobRunnerService {
  const dispatch = { handle: vi.fn(handle) } as unknown as NotificationDispatchHandler;
  const maintenance = { handle: vi.fn() } as unknown as NotificationMaintenanceHandler;

  return new JobRunnerService({} as never, configuration, dispatch, maintenance);
}

describe('settling a batch of dispatch jobs', () => {
  it('completes every job when they all succeed', async () => {
    const runner = createRunner(() => Promise.resolve());

    const results = await runner.runBatch([createJob('a'), createJob('b')]);

    expect(results).toEqual([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'completed' },
    ]);
  });

  it('fails only the job that threw', async () => {
    // Without per-job settlement, one notification hitting a transient error
    // would drag every other message in the batch into a needless retry.
    const runner = createRunner((job) =>
      job.id === 'b' ? Promise.reject(new Error('boom')) : Promise.resolve(),
    );

    const results = await runner.runBatch([createJob('a'), createJob('b'), createJob('c')]);

    expect(results).toEqual([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'failed' },
      { id: 'c', status: 'completed' },
    ]);
  });

  it('runs the jobs in a batch concurrently rather than one after another', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const runner = createRunner(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
    });

    await runner.runBatch([createJob('a'), createJob('b'), createJob('c')]);

    // Awaiting them in sequence would make the configured batch size a lie:
    // the worker would fetch five jobs and then process one at a time.
    expect(peakInFlight).toBe(3);
  });
});
