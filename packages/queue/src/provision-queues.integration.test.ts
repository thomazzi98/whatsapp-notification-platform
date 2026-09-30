import { type PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { createQueueClient, provisionQueues } from './queue-client';
import { queueNames } from './queue-definitions';

/**
 * The migrate step runs against databases that already have their queues, and
 * pg-boss only ever creates a queue that is missing. Without reconciling, a
 * changed definition would reach a fresh test database and never production.
 */
let connectionUrl: string;
let boss: PgBoss;
const failures: Error[] = [];

beforeAll(async () => {
  connectionUrl = inject('databaseUrl');
  boss = createQueueClient({
    connectionUrl,
    schema: 'pgboss',
    supervise: false,
    onError: (error) => {
      failures.push(error);
    },
  });
  await boss.start();
}, 180_000);

afterEach(() => {
  expect(failures).toStrictEqual([]);
});

afterAll(async () => {
  // The other suites share this database and expect the declared queues.
  await provisionQueues(connectionUrl, 'pgboss');
  await boss.stop({ graceful: false });
});

describe('provisioning a database that already has its queues', () => {
  it('moves the dispatch queue to the policy it is declared with', async () => {
    // An installation provisioned before the policy changed.
    await boss.deleteQueue(queueNames.notificationDispatch);
    await boss.createQueue(queueNames.notificationDispatch, {
      policy: 'exclusive',
      deadLetter: queueNames.notificationDeadLetter,
    });

    await provisionQueues(connectionUrl, 'pgboss');

    const queue = await boss.getQueue(queueNames.notificationDispatch);
    expect(queue?.policy).toBe('stately');
    expect(queue?.deadLetter).toBe(queueNames.notificationDeadLetter);
  });

  it('updates an option that drifted, and keeps the jobs that are waiting', async () => {
    await boss.updateQueue(queueNames.notificationDispatch, { retryLimit: 9 });
    const waiting = await boss.send(
      queueNames.notificationDispatch,
      { correlationId: 'correlation-waiting' },
      { singletonKey: 'provisioned-1', startAfter: new Date(Date.now() + 3_600_000) },
    );

    await provisionQueues(connectionUrl, 'pgboss');

    if (waiting === null) {
      throw new Error('The waiting job was not accepted.');
    }
    const queue = await boss.getQueue(queueNames.notificationDispatch);
    expect(queue?.retryLimit).toBe(3);
    expect(await boss.getJobById(queueNames.notificationDispatch, waiting)).not.toBeNull();
  });
});
