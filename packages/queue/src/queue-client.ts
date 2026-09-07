import { PgBoss } from 'pg-boss';

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
}

export function createQueueClient(options: QueueClientOptions): PgBoss {
  return new PgBoss({
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
}

/**
 * Installs the queue schema and declares every queue. Run once, by the migrate
 * step, before any process that sends or works jobs starts.
 */
export async function provisionQueues(connectionUrl: string, schema: string): Promise<void> {
  const boss = new PgBoss({ connectionString: connectionUrl, schema, migrate: true });

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
