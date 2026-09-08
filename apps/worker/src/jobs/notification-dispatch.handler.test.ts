import { type DispatchInput, type DispatchResult } from '@platform/composition';
import { type Job } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';

import { NotificationDispatchHandler } from './notification-dispatch.handler';

// Silenced: these tests deliberately exercise the paths that log an error, and
// the real output would bury a genuine failure.
const silentLogger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function createJob(data: unknown, signal = new AbortController().signal): Job<unknown> {
  return {
    id: 'job-1',
    name: 'notification.dispatch',
    data,
    expireInSeconds: 120,
    heartbeatSeconds: null,
    signal,
  };
}

function createHandler(dispatch: (input: DispatchInput) => Promise<DispatchResult>): {
  readonly handler: NotificationDispatchHandler;
  readonly dispatch: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(dispatch);

  return {
    handler: new NotificationDispatchHandler({ dispatch: spy } as never, silentLogger as never),
    dispatch: spy,
  };
}

const validPayload = {
  correlationId: 'correlation-1',
  notificationId: '0193b0f0-0000-7000-8000-000000000001',
  applicationId: '0193b0f0-0000-7000-8000-000000000002',
};

describe('handling a dispatch job', () => {
  it('passes the job payload through to the dispatcher', async () => {
    const { handler, dispatch } = createHandler(() => Promise.resolve({ outcome: 'sent' }));

    await handler.handle(createJob(validPayload));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject(validPayload);
  });

  it('forwards the job abort signal so a send stops when the worker does', async () => {
    const controller = new AbortController();
    const { handler, dispatch } = createHandler(() => Promise.resolve({ outcome: 'sent' }));

    await handler.handle(createJob(validPayload, controller.signal));

    expect((dispatch.mock.calls[0]?.[0] as DispatchInput).abortSignal).toBe(controller.signal);
  });

  it('discards a payload that does not match the contract instead of retrying it', async () => {
    const { handler, dispatch } = createHandler(() => Promise.resolve({ outcome: 'sent' }));

    // Retrying would produce the same parse failure every time and fill the
    // dead letter queue with a message nothing can ever act on.
    await expect(
      handler.handle(createJob({ notificationId: 'not-a-uuid' })),
    ).resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('lets an unexpected dispatch error escape, so the queue retries the job', async () => {
    const { handler } = createHandler(() => Promise.reject(new Error('the database went away')));

    await expect(handler.handle(createJob(validPayload))).rejects.toThrow('the database went away');
  });
});
