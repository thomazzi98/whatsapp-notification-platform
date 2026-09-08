import { createDatabaseConnection, type DatabaseConnection, schema } from '@platform/database';
import { eq } from 'drizzle-orm';
import { type PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { enqueueInTransaction } from './enqueue-in-transaction';
import { createQueueClient } from './queue-client';
import { queueNames } from './queue-definitions';

/**
 * The property the whole architecture rests on.
 *
 * pg-boss stores jobs in the same Postgres instance as the domain data, so a
 * job can be written by the transaction that writes the row it refers to. That
 * removes the dual-write problem an outbox table would otherwise exist to
 * solve: there is no window in which a notification exists with no job to
 * dispatch it, and none in which a job points at a row that was never
 * committed.
 *
 * These tests exist because the entire design depends on it actually being
 * true, not on the documentation saying so.
 */
let connection: DatabaseConnection;
let boss: PgBoss;
/** Collected rather than ignored: an unobserved failure here is a lost job. */
const failures: Error[] = [];
let organizationId: string;

beforeAll(async () => {
  const connectionUrl = inject('databaseUrl');
  connection = createDatabaseConnection({
    connectionUrl,
    maximumPoolSize: 4,
    applicationName: 'transactional-enqueue-test',
  });

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

afterAll(async () => {
  await boss.stop({ graceful: false });
  await connection.close();
});

beforeEach(async () => {
  // The exclusive policy means a job left behind by a previous test would
  // block the next send for the same key.
  await boss.deleteQueuedJobs(queueNames.notificationDispatch);
  await connection.database.delete(schema.applications);
  await connection.database.delete(schema.organizations);

  const [organization] = await connection.database
    .insert(schema.organizations)
    .values({ name: 'Acme', slug: `acme-${Date.now().toString(36)}` })
    .returning();

  if (organization === undefined) {
    throw new Error('Failed to create the fixture organization.');
  }
  organizationId = organization.id;
});

async function countApplications(slug: string): Promise<number> {
  const rows = await connection.database
    .select()
    .from(schema.applications)
    .where(eq(schema.applications.slug, slug));

  return rows.length;
}

describe('enqueueInTransaction', () => {
  it('commits the row and the job together', async () => {
    let jobId: string | null = null;

    await connection.database.transaction(async (transaction) => {
      await transaction
        .insert(schema.applications)
        .values({ organizationId, name: 'Committed', slug: 'committed' });

      jobId = await enqueueInTransaction(
        boss,
        transaction,
        queueNames.notificationDispatch,
        { correlationId: 'correlation-commit', notificationId: 'notification-1' },
        { singletonKey: 'notification-1' },
      );
    });

    expect(jobId).toBeTypeOf('string');
    expect(await countApplications('committed')).toBe(1);

    const job = await boss.getJobById(queueNames.notificationDispatch, jobId as unknown as string);
    expect(job).not.toBeNull();
    expect(job?.data).toMatchObject({ correlationId: 'correlation-commit' });
  });

  it('discards the job when the transaction rolls back', async () => {
    let jobId: string | null = null;

    await expect(
      connection.database.transaction(async (transaction) => {
        await transaction
          .insert(schema.applications)
          .values({ organizationId, name: 'Rolled back', slug: 'rolled-back' });

        jobId = await enqueueInTransaction(
          boss,
          transaction,
          queueNames.notificationDispatch,
          { correlationId: 'correlation-rollback', notificationId: 'notification-2' },
          { singletonKey: 'notification-2' },
        );

        throw new Error('Something failed after the enqueue.');
      }),
    ).rejects.toThrow('Something failed after the enqueue.');

    // Neither survives: this is the property that makes a separate outbox
    // table unnecessary.
    expect(await countApplications('rolled-back')).toBe(0);

    const job = await boss.getJobById(queueNames.notificationDispatch, jobId as unknown as string);
    expect(job).toBeNull();
  });

  it('rolls the job back when the database rejects the row', async () => {
    // A constraint violation is the realistic version of the failure above.
    let jobId: string | null = null;

    await expect(
      connection.database.transaction(async (transaction) => {
        await transaction
          .insert(schema.applications)
          .values({ organizationId, name: 'First', slug: 'duplicate' });

        jobId = await enqueueInTransaction(
          boss,
          transaction,
          queueNames.notificationDispatch,
          { correlationId: 'correlation-constraint', notificationId: 'notification-3' },
          { singletonKey: 'notification-3' },
        );

        await transaction
          .insert(schema.applications)
          .values({ organizationId, name: 'Second', slug: 'duplicate' });
      }),
    ).rejects.toThrow();

    expect(await countApplications('duplicate')).toBe(0);
    expect(
      await boss.getJobById(queueNames.notificationDispatch, jobId as unknown as string),
    ).toBeNull();
  });

  it('makes a committed job available to a worker', async () => {
    await connection.database.transaction(async (transaction) => {
      await enqueueInTransaction(
        boss,
        transaction,
        queueNames.notificationDispatch,
        { correlationId: 'correlation-fetch', notificationId: 'notification-4' },
        { singletonKey: 'notification-4' },
      );
    });

    const fetched = await boss.fetch(queueNames.notificationDispatch, { batchSize: 10 });

    expect(fetched.length).toBeGreaterThan(0);
    expect(
      fetched.some(
        (job) => (job.data as { correlationId: string }).correlationId === 'correlation-fetch',
      ),
    ).toBe(true);
  });

  it('does not make a rolled back job available to a worker', async () => {
    await expect(
      connection.database.transaction(async (transaction) => {
        await enqueueInTransaction(
          boss,
          transaction,
          queueNames.notificationDispatch,
          { correlationId: 'correlation-never', notificationId: 'notification-5' },
          { singletonKey: 'notification-5' },
        );
        throw new Error('rolled back');
      }),
    ).rejects.toThrow();

    const fetched = await boss.fetch(queueNames.notificationDispatch, { batchSize: 10 });
    const correlationIds = fetched.map(
      (job) => (job.data as { correlationId: string }).correlationId,
    );

    expect(correlationIds).not.toContain('correlation-never');
  });

  it('honours a future startAfter, so a scheduled job is not picked up early', async () => {
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);

    await connection.database.transaction(async (transaction) => {
      await enqueueInTransaction(
        boss,
        transaction,
        queueNames.notificationDispatch,
        { correlationId: 'correlation-scheduled', notificationId: 'notification-6' },
        { startAfter: oneHourFromNow, singletonKey: 'notification-6' },
      );
    });

    const fetched = await boss.fetch(queueNames.notificationDispatch, { batchSize: 10 });
    const correlationIds = fetched.map(
      (job) => (job.data as { correlationId: string }).correlationId,
    );

    // Scheduling is durable because it is a column in Postgres, not a timer in
    // a process that a restart would forget.
    expect(correlationIds).not.toContain('correlation-scheduled');
  });

  it('accepts only one live job per notification', async () => {
    const singletonKey = 'notification-7';

    const results = await Promise.all(
      [1, 2, 3].map(async (attempt) =>
        connection.database.transaction(async (transaction) =>
          enqueueInTransaction(
            boss,
            transaction,
            queueNames.notificationDispatch,
            { correlationId: `correlation-${String(attempt)}`, notificationId: singletonKey },
            { singletonKey },
          ),
        ),
      ),
    );

    expect(results.filter((jobId) => jobId !== null)).toHaveLength(1);
  });

  it('accepts a new job for the same notification once the previous one completed', async () => {
    // The reason the queue uses the `exclusive` policy rather than `short` or
    // `stately`: those reject a send after completion, which would stop every
    // retry from ever being enqueued.
    const singletonKey = 'notification-8';

    const first = await connection.database.transaction(async (transaction) =>
      enqueueInTransaction(
        boss,
        transaction,
        queueNames.notificationDispatch,
        { correlationId: 'correlation-attempt-1', notificationId: singletonKey },
        { singletonKey },
      ),
    );
    expect(first).not.toBeNull();

    const [job] = await boss.fetch(queueNames.notificationDispatch, { batchSize: 1 });
    if (job === undefined) {
      throw new Error('Expected the enqueued job to be available.');
    }
    await boss.complete(queueNames.notificationDispatch, job.id);

    const retry = await connection.database.transaction(async (transaction) =>
      enqueueInTransaction(
        boss,
        transaction,
        queueNames.notificationDispatch,
        { correlationId: 'correlation-attempt-2', notificationId: singletonKey },
        { singletonKey },
      ),
    );

    expect(retry).not.toBeNull();
  });
});
