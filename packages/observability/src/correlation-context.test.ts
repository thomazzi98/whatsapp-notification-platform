import { describe, expect, it } from 'vitest';

import {
  enrichCorrelationContext,
  getCorrelationContext,
  getCorrelationId,
  runWithCorrelationContext,
} from './correlation-context';

/** Stands in for a guard that learns the user identity and then returns. */
function enrichInsideAGuard(): void {
  enrichCorrelationContext({ userId: 'user-4' });
}

describe('correlation context', () => {
  it('is empty outside an active scope', () => {
    expect(getCorrelationContext()).toBeUndefined();
    expect(getCorrelationId()).toBeUndefined();
  });

  it('exposes the context inside a scope', () => {
    runWithCorrelationContext({ correlationId: 'correlation-1', applicationId: 'app-1' }, () => {
      expect(getCorrelationId()).toBe('correlation-1');
      expect(getCorrelationContext()?.applicationId).toBe('app-1');
    });
  });

  it('survives an await boundary', async () => {
    await runWithCorrelationContext({ correlationId: 'correlation-2' }, async () => {
      await Promise.resolve();
      expect(getCorrelationId()).toBe('correlation-2');
    });
  });

  it('merges additions without losing the existing context', () => {
    runWithCorrelationContext({ correlationId: 'correlation-3', applicationId: 'app-3' }, () => {
      enrichCorrelationContext({ notificationId: 'notification-3' });
      const context = getCorrelationContext();

      expect(context?.correlationId).toBe('correlation-3');
      expect(context?.applicationId).toBe('app-3');
      expect(context?.notificationId).toBe('notification-3');
    });
  });

  it('keeps additions after the enriching function returns', () => {
    // The reason enrichment mutates the store instead of opening a nested
    // scope: a guard that learns the user identity must not lose it the moment
    // it returns, or the enrichment never reaches the handler it describes.
    runWithCorrelationContext({ correlationId: 'correlation-4' }, () => {
      enrichInsideAGuard();

      expect(getCorrelationContext()?.userId).toBe('user-4');
    });
  });

  it('does not leak additions into a sibling scope', () => {
    runWithCorrelationContext({ correlationId: 'first' }, () => {
      enrichCorrelationContext({ userId: 'user-first' });
    });

    runWithCorrelationContext({ correlationId: 'second' }, () => {
      expect(getCorrelationContext()?.userId).toBeUndefined();
    });
  });

  it('does nothing outside an active scope rather than throwing', () => {
    // A script or a test harness must be able to call instrumented code without
    // being required to open a scope first.
    expect(() => {
      enrichCorrelationContext({ notificationId: 'orphan' });
    }).not.toThrow();
  });

  it('keeps concurrent scopes isolated from each other', async () => {
    const observed: string[] = [];

    async function record(correlationId: string, delayMilliseconds: number): Promise<void> {
      await runWithCorrelationContext({ correlationId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
        observed.push(getCorrelationId() ?? 'missing');
      });
    }

    await Promise.all([record('first', 20), record('second', 5)]);

    expect(observed.toSorted((left, right) => left.localeCompare(right))).toEqual([
      'first',
      'second',
    ]);
  });
});
