import { type Queue } from 'pg-boss';

export const queueNames = {
  notificationDispatch: 'notification.dispatch',
  notificationDeadLetter: 'notification.dispatch.dead',
  webhookProcess: 'webhook.process',
  maintenanceReconcile: 'maintenance.reconcile',
} as const;

export type QueueName = (typeof queueNames)[keyof typeof queueNames];

/**
 * Queues are declared here and provisioned once by the migrate step, so a typo
 * in a queue name fails at startup rather than silently sending jobs into a
 * queue nothing is listening to.
 *
 * Retry settings deliberately differ from the business retry policy. pg-boss
 * retries only cover a handler that died without recording anything — an out of
 * memory kill, a job expiry. The attempt budget that matters to a customer is
 * counted on the notification row itself, and is incremented before the
 * provider is called so an infrastructure redelivery cannot exceed it.
 */
export const queueDefinitions: readonly Queue[] = [
  {
    name: queueNames.notificationDispatch,
    /*
     * `exclusive` keeps at most one live job per singletonKey — the
     * notification id — while still accepting a new job once the previous one
     * has completed, which is what a retry needs.
     *
     * The alternatives were measured rather than assumed, because getting this
     * wrong fails silently. Under `standard` and `singleton`, duplicate sends
     * are all accepted and the queue accumulates redundant work. Under `short`
     * and `stately`, a send after the previous job completed is rejected, which
     * would have stopped every retry from ever being enqueued.
     *
     * None of this is load bearing for correctness: duplicate dispatch is
     * prevented by the compare-and-swap claim on the notification row. This
     * only keeps the queue tidy.
     */
    policy: 'exclusive',
    // A crashed worker must not hold a notification hostage; the stuck-claim
    // reaper depends on this expiring.
    expireInSeconds: 120,
    retryLimit: 3,
    retryDelay: 10,
    retryBackoff: true,
    deadLetter: queueNames.notificationDeadLetter,
    retentionSeconds: 60 * 60 * 24 * 14,
  },
  {
    name: queueNames.notificationDeadLetter,
    expireInSeconds: 120,
    retryLimit: 0,
    retentionSeconds: 60 * 60 * 24 * 30,
  },
  {
    name: queueNames.webhookProcess,
    expireInSeconds: 60,
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    retentionSeconds: 60 * 60 * 24 * 7,
  },
  {
    name: queueNames.maintenanceReconcile,
    expireInSeconds: 300,
    retryLimit: 1,
    retentionSeconds: 60 * 60 * 24,
  },
];
