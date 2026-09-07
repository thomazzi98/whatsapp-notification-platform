import { describe, expect, it } from 'vitest';

import {
  getCorrelationContext,
  getCorrelationId,
  runWithAdditionalCorrelationContext,
  runWithCorrelationContext,
} from './correlation-context';

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
      runWithAdditionalCorrelationContext({ notificationId: 'notification-3' }, () => {
        const context = getCorrelationContext();

        expect(context?.correlationId).toBe('correlation-3');
        expect(context?.applicationId).toBe('app-3');
        expect(context?.notificationId).toBe('notification-3');
      });
    });
  });

  it('restores the outer context when an inner scope ends', () => {
    runWithCorrelationContext({ correlationId: 'outer' }, () => {
      runWithAdditionalCorrelationContext({ notificationId: 'inner' }, () => {
        expect(getCorrelationContext()?.notificationId).toBe('inner');
      });

      expect(getCorrelationContext()?.notificationId).toBeUndefined();
    });
  });

  it('refuses to extend a context that does not exist', () => {
    expect(() => {
      runWithAdditionalCorrelationContext({ notificationId: 'orphan' }, () => undefined);
    }).toThrow(/outside an active scope/);
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
