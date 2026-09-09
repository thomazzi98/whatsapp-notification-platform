import { TENANT_ROLE } from '@platform/database';
import { PgBoss } from 'pg-boss';

import { grantSendPrivileges } from './grant-send-privileges';
import { queueDefinitions } from './queue-definitions';

export interface QueueClientOptions {
  readonly connectionUrl: string;
  readonly schema: string;
  /**
   * Only the worker supervises: it runs maintenance, archiving and the cron
   * schedules. The API constructs a client purely to send, so two processes do
   * not both try to maintain the same tables.
   */
  readonly supervise: boolean;
  /**
   * Called when the queue client reports a failure of its own.
   *
   * Not optional. pg-boss is an EventEmitter, and an EventEmitter that emits
   * `error` with nobody listening terminates the process -- so a database
   * restart would take the API down with it, which is exactly the failure the
   * split between liveness and readiness exists to avoid. Requiring the
   * listener makes that impossible to forget.
   */
  readonly onError: (error: Error) => void;
}

export function createQueueClient(options: QueueClientOptions): PgBoss {
  const boss = new PgBoss({
    connectionString: options.connectionUrl,
    schema: options.schema,
    supervise: options.supervise,
    schedule: options.supervise,
    // Wakes a worker the moment a job is created instead of waiting out its
    // polling interval. Polling stays active underneath as the correctness
    // floor, so a missed notification only costs latency, never a lost job.
    useListenNotify: options.supervise,
    // Migrations are applied by the one-shot migrate step, so neither the API
    // nor the worker races to install the queue schema at startup.
    migrate: false,
  });

  boss.on('error', options.onError);

  return boss;
}

/**
 * Everything a database needs before any process sends or works a job: the
 * queue schema, every queue, and the privileges the tenant role needs to
 * enqueue.
 *
 * One function rather than a sequence each caller repeats, because the migrate
 * step and the test harnesses have to end up with the same database. They did
 * not once, and the symptom was every notification returning 500 in tests while
 * production was fine.
 */
export async function bootstrapQueues(connectionUrl: string, schema: string): Promise<void> {
  await provisionQueues(connectionUrl, schema);
  // A notification and its dispatch job commit in one transaction, and that
  // transaction runs as the tenant role.
  await grantSendPrivileges(connectionUrl, schema, TENANT_ROLE);
}

/**
 * Installs the queue schema and declares every queue. Run once, by the migrate
 * step, before any process that sends or works jobs starts.
 */
export async function provisionQueues(connectionUrl: string, schema: string): Promise<void> {
  const boss = new PgBoss({ connectionString: connectionUrl, schema, migrate: true });

  // The same reason createQueueClient demands a listener: an EventEmitter that
  // emits `error` with nobody listening terminates the process. This one is
  // short-lived, but a database hiccup during migration should fail the
  // bootstrap with a message rather than an unhandled event.
  boss.on('error', (error: Error) => {
    process.stderr.write(`The queue client reported a failure while provisioning: ${error.message}
`);
  });

  await boss.start();

  try {
    // A queue cannot be created before the dead letter queue it points at, so
    // referenced queues go first. Deriving the order from the definitions makes
    // that independent of how the array happens to be written.
    const deadLetterNames = new Set(
      queueDefinitions
        .map((definition) => definition.deadLetter)
        .filter((name): name is string => name !== undefined),
    );
    const orderedDefinitions = [
      ...queueDefinitions.filter((definition) => deadLetterNames.has(definition.name)),
      ...queueDefinitions.filter((definition) => !deadLetterNames.has(definition.name)),
    ];

    for (const definition of orderedDefinitions) {
      const { name, ...options } = definition;
      // Idempotent: an existing queue has its options updated rather than
      // failing, so re-running the migrate step is safe.
      await boss.createQueue(name, options);
    }
  } finally {
    await boss.stop({ graceful: false });
  }
}
