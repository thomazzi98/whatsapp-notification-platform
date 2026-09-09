import { describe, expect, it } from 'vitest';

import { type RandomPort } from '../ports/random';
import {
  computeNextAttemptAt,
  computeRetryDelaySeconds,
  defaultRetryPolicy,
  type RetryPolicy,
  sessionNotReadyMinimumDelaySeconds,
} from './retry-policy';

/** Returns the lowest value in the range, so jitter contributes nothing. */
const lowestRandom: RandomPort = { integerBetween: (minimum) => minimum };

/** Returns the highest value in the range. */
const highestRandom: RandomPort = { integerBetween: (_minimum, maximum) => maximum };

const midpointRandom: RandomPort = {
  integerBetween: (minimum, maximum) => Math.floor((minimum + maximum) / 2),
};

describe('computeRetryDelaySeconds', () => {
  it('grows exponentially across attempts', () => {
    const delays = [1, 2, 3, 4].map((attemptNumber) =>
      computeRetryDelaySeconds(defaultRetryPolicy, attemptNumber, highestRandom),
    );

    expect(delays).toEqual([60, 180, 540, 1620]);
  });

  it('never returns less than half the computed delay, so retries cannot bunch up', () => {
    for (const attemptNumber of [1, 2, 3, 4, 5]) {
      const lowest = computeRetryDelaySeconds(defaultRetryPolicy, attemptNumber, lowestRandom);
      const highest = computeRetryDelaySeconds(defaultRetryPolicy, attemptNumber, highestRandom);

      expect(lowest).toBeGreaterThanOrEqual(Math.floor(highest / 2));
      expect(lowest).toBeLessThanOrEqual(highest);
    }
  });

  it('produces the documented jitter window for the first retry', () => {
    expect(computeRetryDelaySeconds(defaultRetryPolicy, 1, lowestRandom)).toBe(30);
    expect(computeRetryDelaySeconds(defaultRetryPolicy, 1, highestRandom)).toBe(60);
    expect(computeRetryDelaySeconds(defaultRetryPolicy, 1, midpointRandom)).toBe(45);
  });

  it('caps the delay so a late attempt does not wait for hours', () => {
    const policy: RetryPolicy = { ...defaultRetryPolicy, maximumAttempts: 12 };
    const delay = computeRetryDelaySeconds(policy, 12, highestRandom);

    expect(delay).toBe(policy.maximumDelaySeconds);
  });

  it('never returns zero, which is the burst pattern that gets a number banned', () => {
    for (const attemptNumber of [1, 2, 3, 4, 5]) {
      expect(
        computeRetryDelaySeconds(defaultRetryPolicy, attemptNumber, lowestRandom),
      ).toBeGreaterThan(0);
    }
  });

  it('keeps the first retry no faster than the send pacing window allows', () => {
    // The pacing limiter enforces a 30 to 60 second gap between sends, so a
    // retry arriving sooner would only be deferred again.
    expect(computeRetryDelaySeconds(defaultRetryPolicy, 1, lowestRandom)).toBeGreaterThanOrEqual(
      30,
    );
  });
});

describe('computeNextAttemptAt', () => {
  const now = new Date('2026-09-07T12:00:00.000Z');

  it('schedules the next attempt relative to the supplied time', () => {
    const nextAttemptAt = computeNextAttemptAt(defaultRetryPolicy, 1, highestRandom, now);

    expect(nextAttemptAt.toISOString()).toBe('2026-09-07T12:01:00.000Z');
  });

  it('honours a minimum delay floor for failures that need operator action', () => {
    const nextAttemptAt = computeNextAttemptAt(
      defaultRetryPolicy,
      1,
      lowestRandom,
      now,
      sessionNotReadyMinimumDelaySeconds,
    );

    expect(nextAttemptAt.getTime() - now.getTime()).toBe(sessionNotReadyMinimumDelaySeconds * 1000);
  });

  it('keeps the computed delay when it already exceeds the floor', () => {
    const nextAttemptAt = computeNextAttemptAt(defaultRetryPolicy, 4, highestRandom, now, 60);

    expect(nextAttemptAt.getTime() - now.getTime()).toBe(1620 * 1000);
  });

  it('never schedules an attempt in the past', () => {
    for (const attemptNumber of [1, 2, 3, 4, 5]) {
      const nextAttemptAt = computeNextAttemptAt(
        defaultRetryPolicy,
        attemptNumber,
        lowestRandom,
        now,
      );

      expect(nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
