import { type RandomPort } from '../ports/random';

export interface RetryPolicy {
  readonly baseDelaySeconds: number;
  readonly backoffFactor: number;
  readonly maximumDelaySeconds: number;
  readonly maximumAttempts: number;
}

/**
 * The base delay matches the lower bound of the WhatsApp send pacing window, so
 * a retry can never fire faster than the pacing limiter would allow anyway.
 */
export const defaultRetryPolicy: RetryPolicy = {
  baseDelaySeconds: 60,
  backoffFactor: 3,
  maximumDelaySeconds: 3600,
  maximumAttempts: 5,
};

/**
 * Some failures mean the provider is not ready rather than that the message is
 * bad. Retrying those on the normal curve just burns the attempt budget while
 * a human is still scanning a QR code.
 */
export const sessionNotReadyMinimumDelaySeconds = 300;

/**
 * Equal jitter: half the computed delay, plus a random amount up to the other
 * half. Full jitter is the more common recommendation, but it permits a
 * near-zero delay, and a burst of near-instant retries is exactly the traffic
 * shape that gets a WhatsApp number banned.
 */
export function computeRetryDelaySeconds(
  policy: RetryPolicy,
  attemptNumber: number,
  random: RandomPort,
): number {
  const exponentialDelay = policy.baseDelaySeconds * policy.backoffFactor ** (attemptNumber - 1);
  const cappedDelay = Math.min(exponentialDelay, policy.maximumDelaySeconds);
  const half = Math.floor(cappedDelay / 2);

  return half + random.integerBetween(0, cappedDelay - half);
}

export function computeNextAttemptAt(
  policy: RetryPolicy,
  attemptNumber: number,
  random: RandomPort,
  now: Date,
  minimumDelaySeconds = 0,
): Date {
  const computedDelay = computeRetryDelaySeconds(policy, attemptNumber, random);
  const delaySeconds = Math.max(computedDelay, minimumDelaySeconds);

  return new Date(now.getTime() + delaySeconds * 1000);
}
