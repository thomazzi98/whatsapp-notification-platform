import { sql } from 'drizzle-orm';
import { type DrizzleTransactionLike, fromDrizzle, type PgBoss, type SendOptions } from 'pg-boss';

import { type QueueName } from './queue-definitions';

/**
 * Sends a job on the caller's transaction.
 *
 * This is the property the whole architecture rests on. The job row is written
 * by the same transaction that writes the notification, so the two commit or
 * roll back together. There is no window in which a notification exists with no
 * job to dispatch it, and none in which a job references a notification that
 * was never committed — which is the dual-write problem an outbox table would
 * otherwise exist to solve.
 *
 * It is only sound because the surrounding transaction performs no network
 * calls. The provider is contacted by the worker, never inside the request.
 */
export async function enqueueInTransaction(
  boss: PgBoss,
  transaction: DrizzleTransactionLike,
  queueName: QueueName,
  data: object,
  options: SendOptions = {},
): Promise<string | null> {
  return boss.send(queueName, data, {
    ...options,
    // eslint-disable-next-line unicorn/name-replacements -- pg-boss option name.
    db: fromDrizzle(transaction, sql),
  });
}
