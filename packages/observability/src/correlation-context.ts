import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Fields carried alongside every log line for the lifetime of a request or a
 * job. The chain correlationId -> notificationId -> providerMessageId is what
 * lets an operator follow one message across the API, the queue and the worker.
 */
export interface CorrelationContext {
  correlationId: string;
  requestId?: string;
  applicationId?: string;
  userId?: string;
  apiKeyId?: string;
  notificationId?: string;
  jobId?: string;
  attemptNumber?: number;
  recipientHash?: string;
}

const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export function runWithCorrelationContext<Result>(
  context: CorrelationContext,
  callback: () => Result,
): Result {
  // A fresh object per scope, because enrichment mutates it in place.
  return correlationStorage.run({ ...context }, callback);
}

/**
 * Adds fields to the scope that is already open.
 *
 * This mutates the stored object rather than opening a nested scope. Opening
 * one would apply the additions only for the duration of a callback, so a guard
 * that learned the user identity would lose it the moment it returned — the
 * enrichment would silently never reach the handler it was meant to describe.
 *
 * Outside a scope this does nothing, so code paths that run without one — a
 * test harness, a script — are not required to open one just to log.
 */
export function enrichCorrelationContext(additions: Partial<CorrelationContext>): void {
  const current = correlationStorage.getStore();

  if (current === undefined) {
    return;
  }
  Object.assign(current, additions);
}

export function getCorrelationContext(): Readonly<CorrelationContext> | undefined {
  return correlationStorage.getStore();
}

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
