/**
 * Every log line carries one of these in its `event` field. `message` is for a
 * human reading the stream; `event` is the stable identifier to filter and
 * alert on, so renaming a human-facing message never breaks a dashboard.
 */
export const logEvents = {
  httpRequestCompleted: 'http.request.completed',

  authenticationSucceeded: 'auth.login.succeeded',
  authenticationFailed: 'auth.login.failed',
  apiKeyRejected: 'apikey.rejected',
  notificationClaimSkipped: 'notification.claim_skipped',
  notificationDispatchStarted: 'notification.dispatch.started',
  notificationDispatchPaced: 'notification.dispatch.paced',
  notificationDispatchSucceeded: 'notification.dispatch.succeeded',
  notificationDispatchRetrying: 'notification.dispatch.retrying',
  notificationDispatchFailed: 'notification.dispatch.failed',
  notificationDeadLettered: 'notification.dead_lettered',
  providerSessionStatusChanged: 'provider.session.status.changed',

  webhookReceived: 'webhook.received',
  webhookRejected: 'webhook.rejected',
  webhookDuplicate: 'webhook.duplicate',
  webhookProcessed: 'webhook.processed',

  queueJobStarted: 'queue.job.started',
  queueJobCompleted: 'queue.job.completed',
  queueJobFailed: 'queue.job.failed',

  processStarted: 'process.started',
  httpRequestFailed: 'http.request.failed',
  workerShutdownStarted: 'worker.shutdown.started',
  workerShutdownCompleted: 'worker.shutdown.completed',
  healthDependencyDegraded: 'health.dependency.degraded',
  rateLimiterDegraded: 'ratelimit.degraded',
} as const;
