/**
 * Every log line carries one of these in its `event` field. `message` is for a
 * human reading the stream; `event` is the stable identifier to filter and
 * alert on, so renaming a human-facing message never breaks a dashboard.
 */
export const logEvents = {
  httpRequestCompleted: 'http.request.completed',

  authenticationSucceeded: 'auth.login.succeeded',
  authenticationFailed: 'auth.login.failed',
  authenticationSessionExpired: 'auth.session.expired',
  apiKeyAccepted: 'apikey.authenticated',
  apiKeyRejected: 'apikey.rejected',

  notificationAccepted: 'notification.accepted',
  notificationDeduplicated: 'notification.deduplicated',
  notificationEnqueued: 'notification.enqueued',
  notificationClaimSkipped: 'notification.claim_skipped',
  notificationDispatchStarted: 'notification.dispatch.started',
  notificationDispatchPaced: 'notification.dispatch.paced',
  notificationDispatchSucceeded: 'notification.dispatch.succeeded',
  notificationDispatchRetrying: 'notification.dispatch.retrying',
  notificationDispatchFailed: 'notification.dispatch.failed',
  notificationStateChanged: 'notification.state.changed',
  notificationStateRejected: 'notification.state.rejected',
  notificationDeadLettered: 'notification.dead_lettered',

  providerRequest: 'provider.request',
  providerUnavailable: 'provider.unavailable',
  providerSessionStatusChanged: 'provider.session.status.changed',

  webhookReceived: 'webhook.received',
  webhookRejected: 'webhook.rejected',
  webhookDuplicate: 'webhook.duplicate',
  webhookProcessed: 'webhook.processed',

  queueJobStarted: 'queue.job.started',
  queueJobCompleted: 'queue.job.completed',
  queueJobFailed: 'queue.job.failed',

  workerShutdownStarted: 'worker.shutdown.started',
  workerShutdownCompleted: 'worker.shutdown.completed',

  databaseMigrationApplied: 'database.migration.applied',
  healthDependencyDegraded: 'health.dependency.degraded',
  rateLimiterDegraded: 'ratelimit.degraded',
} as const;

export type LogEvent = (typeof logEvents)[keyof typeof logEvents];
