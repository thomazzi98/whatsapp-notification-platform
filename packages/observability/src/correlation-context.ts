import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Fields carried alongside every log line for the lifetime of a request or a
 * job. The chain correlationId -> notificationId -> providerMessageId is what
 * lets an operator follow one message across the API, the queue and the worker.
 */
export interface CorrelationContext {
  readonly correlationId: string;
  readonly requestId?: string;
  readonly applicationId?: string;
  readonly userId?: string;
  readonly apiKeyId?: string;
  readonly notificationId?: string;
  readonly jobId?: string;
  readonly attemptNumber?: number;
  readonly recipientHash?: string;
}

const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export function runWithCorrelationContext<Result>(
  context: CorrelationContext,
  callback: () => Result,
): Result {
  return correlationStorage.run(context, callback);
}

/**
 * Extends the active context for the duration of a callback. Used when a scope
 * learns something new, such as a worker picking up a specific notification.
 */
export function runWithAdditionalCorrelationContext<Result>(
  additions: Partial<CorrelationContext>,
  callback: () => Result,
): Result {
  const current = correlationStorage.getStore();

  if (current === undefined) {
    throw new Error(
      'Cannot extend the correlation context outside an active scope. Call runWithCorrelationContext first.',
    );
  }

  return correlationStorage.run({ ...current, ...additions }, callback);
}

export function getCorrelationContext(): CorrelationContext | undefined {
  return correlationStorage.getStore();
}

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
