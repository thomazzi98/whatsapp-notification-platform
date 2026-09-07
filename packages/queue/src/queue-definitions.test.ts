import { describe, expect, it } from 'vitest';

import { notificationDispatchPayloadSchema, webhookProcessPayloadSchema } from './job-payloads';
import { queueDefinitions, queueNames } from './queue-definitions';

describe('queue definitions', () => {
  it('declares every queue the platform sends to', () => {
    const declared = new Set(queueDefinitions.map((definition) => definition.name));

    for (const name of Object.values(queueNames)) {
      expect(declared, name).toContain(name);
    }
  });

  it('declares each queue exactly once', () => {
    const names = queueDefinitions.map((definition) => definition.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it('declares every dead letter queue it references', () => {
    const declared = new Set(queueDefinitions.map((definition) => definition.name));
    const referenced = queueDefinitions
      .map((definition) => definition.deadLetter)
      .filter((name): name is string => name !== undefined);

    for (const name of referenced) {
      // Creating a queue whose dead letter queue does not exist fails at
      // provisioning time.
      expect(declared, name).toContain(name);
    }
  });

  it('keeps the dispatch queue exclusive, so a retry can still be enqueued', () => {
    const dispatch = queueDefinitions.find(
      (definition) => definition.name === queueNames.notificationDispatch,
    );

    // Measured, not assumed: `short` and `stately` reject a send once the
    // previous job completed, which would stop every retry.
    expect(dispatch?.policy).toBe('exclusive');
  });

  it('expires a dispatch job fast enough for the stuck claim reaper to act', () => {
    const dispatch = queueDefinitions.find(
      (definition) => definition.name === queueNames.notificationDispatch,
    );

    expect(dispatch?.expireInSeconds).toBeLessThanOrEqual(300);
  });

  it('routes exhausted dispatch jobs to a dead letter queue that does not retry', () => {
    const dispatch = queueDefinitions.find(
      (definition) => definition.name === queueNames.notificationDispatch,
    );
    const deadLetter = queueDefinitions.find(
      (definition) => definition.name === queueNames.notificationDeadLetter,
    );

    expect(dispatch?.deadLetter).toBe(queueNames.notificationDeadLetter);
    expect(deadLetter?.retryLimit).toBe(0);
  });
});

describe('job payloads', () => {
  it('requires a correlation identifier on every job', () => {
    // It rides in the payload rather than a side channel so it survives a
    // broker restart and can join a worker log line to the originating request.
    const result = notificationDispatchPayloadSchema.safeParse({
      notificationId: '00000000-0000-7000-8000-000000000000',
      applicationId: '00000000-0000-7000-8000-000000000001',
    });

    expect(result.success).toBe(false);
  });

  it('accepts a well formed dispatch payload', () => {
    const result = notificationDispatchPayloadSchema.safeParse({
      correlationId: 'correlation-1',
      notificationId: '00000000-0000-7000-8000-000000000000',
      applicationId: '00000000-0000-7000-8000-000000000001',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an identifier that is not a uuid', () => {
    const result = notificationDispatchPayloadSchema.safeParse({
      correlationId: 'correlation-1',
      notificationId: 'not-a-uuid',
      applicationId: '00000000-0000-7000-8000-000000000001',
    });

    expect(result.success).toBe(false);
  });

  it('validates the webhook payload too', () => {
    expect(
      webhookProcessPayloadSchema.safeParse({
        correlationId: 'correlation-1',
        webhookDeliveryId: '00000000-0000-7000-8000-000000000002',
      }).success,
    ).toBe(true);
    expect(webhookProcessPayloadSchema.safeParse({ correlationId: 'c' }).success).toBe(false);
  });
});
