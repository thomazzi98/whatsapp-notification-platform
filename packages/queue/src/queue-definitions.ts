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
     * `stately` keeps at most one job per state for each singletonKey — the
     * notification id — so a notification has at most one job waiting and one
     * running, and never two of either.
     *
     * The job that schedules a retry or a paced send is still running when it
     * does so. `exclusive`, used before, counts that running job, so it
     * rejected every one of those follow-ups without an error. The maintenance
     * pass, meant only as a repair path, ended up releasing all of them at its
     * once-a-minute tick: the randomised thirty to sixty seconds between sends
     * never happened, and a paced session sent exactly once a minute, the
     * mechanical rhythm the pacing exists to avoid. The integration tests
     * reproduce both the rejection and the fix against real Postgres.
     *
     * None of this is load bearing for correctness: duplicate dispatch is
     * prevented by the compare-and-swap claim on the notification row, which
     * also refuses a job that arrives before the notification is due.
     */
    policy: 'stately',
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
