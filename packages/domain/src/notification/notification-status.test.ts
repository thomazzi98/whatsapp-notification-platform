import { describe, expect, it } from 'vitest';

import {
  assertNotificationStatusTransition,
  cancellableNotificationStatuses,
  canTransitionNotificationStatus,
  IllegalNotificationStatusTransitionError,
  isNotificationStatus,
  isTerminalNotificationStatus,
  type NotificationStatus,
  notificationStatuses,
  notificationStatusTransitions,
  terminalNotificationStatuses,
} from './notification-status';

/**
 * Written out independently of the implementation. A test that re-derived these
 * pairs from `notificationStatusTransitions` would pass no matter how that table
 * changed, which is the opposite of what this suite exists to catch.
 */
const expectedLegalTransitions: ReadonlySet<string> = new Set([
  'SCHEDULED->QUEUED',
  'SCHEDULED->CANCELLED',
  'QUEUED->PROCESSING',
  'QUEUED->CANCELLED',
  'PROCESSING->SENT',
  'PROCESSING->RETRYING',
  'PROCESSING->FAILED',
  'SENT->DELIVERED',
  'SENT->FAILED',
  'RETRYING->PROCESSING',
  'RETRYING->CANCELLED',
  'RETRYING->FAILED',
]);

function transitionKey(from: NotificationStatus, to: NotificationStatus): string {
  return `${from}->${to}`;
}

function alphabetically(left: string, right: string): number {
  return left.localeCompare(right);
}

function collectReachableStatuses(
  entryPoints: readonly NotificationStatus[],
): ReadonlySet<NotificationStatus> {
  const reached = new Set<NotificationStatus>(entryPoints);
  const pending: NotificationStatus[] = [...entryPoints];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    const unvisited = notificationStatusTransitions[current].filter((next) => !reached.has(next));
    for (const next of unvisited) {
      reached.add(next);
      pending.push(next);
    }
  }

  return reached;
}

describe('notification status transitions', () => {
  it('allows exactly the documented transitions across the full status matrix', () => {
    const unexpectedlyAllowed: string[] = [];
    const unexpectedlyRejected: string[] = [];

    for (const from of notificationStatuses) {
      for (const to of notificationStatuses) {
        const key = transitionKey(from, to);
        const shouldBeAllowed = expectedLegalTransitions.has(key);
        const isAllowed = canTransitionNotificationStatus(from, to);

        if (isAllowed && !shouldBeAllowed) {
          unexpectedlyAllowed.push(key);
        }
        if (!isAllowed && shouldBeAllowed) {
          unexpectedlyRejected.push(key);
        }
      }
    }

    expect({ unexpectedlyAllowed, unexpectedlyRejected }).toEqual({
      unexpectedlyAllowed: [],
      unexpectedlyRejected: [],
    });
  });

  it('covers every status in the transition table', () => {
    expect(Object.keys(notificationStatusTransitions).toSorted(alphabetically)).toEqual(
      [...notificationStatuses].toSorted(alphabetically),
    );
  });

  it('never allows a status to transition to itself', () => {
    const selfTransitions = notificationStatuses.filter((status) =>
      canTransitionNotificationStatus(status, status),
    );

    expect(selfTransitions).toEqual([]);
  });

  it('treats terminal statuses as having no outgoing transitions', () => {
    for (const status of terminalNotificationStatuses) {
      expect(notificationStatusTransitions[status]).toEqual([]);
      expect(isTerminalNotificationStatus(status)).toBe(true);
    }
  });

  it('treats every non-terminal status as having at least one outgoing transition', () => {
    const nonTerminalStatuses = notificationStatuses.filter(
      (status) => !isTerminalNotificationStatus(status),
    );

    for (const status of nonTerminalStatuses) {
      expect(notificationStatusTransitions[status].length).toBeGreaterThan(0);
    }
  });

  it('reaches every status from an entry point, so no status is orphaned', () => {
    const reached = collectReachableStatuses(['SCHEDULED', 'QUEUED']);

    expect([...reached].toSorted(alphabetically)).toEqual(
      [...notificationStatuses].toSorted(alphabetically),
    );
  });

  it('derives the cancellable statuses from the transition table', () => {
    expect([...cancellableNotificationStatuses].toSorted(alphabetically)).toEqual([
      'QUEUED',
      'RETRYING',
      'SCHEDULED',
    ]);
  });

  it('does not allow cancelling a notification that is already being dispatched', () => {
    // A provider call may be in flight and a sent WhatsApp message cannot be revoked.
    expect(canTransitionNotificationStatus('PROCESSING', 'CANCELLED')).toBe(false);
  });

  it('does not allow a failed notification to re-enter the pipeline', () => {
    // Retrying creates a new notification instead, which preserves the audit trail.
    for (const status of notificationStatuses) {
      expect(canTransitionNotificationStatus('FAILED', status)).toBe(false);
    }
  });

  it('keeps DELIVERED terminal so an optional read receipt cannot reopen it', () => {
    for (const status of notificationStatuses) {
      expect(canTransitionNotificationStatus('DELIVERED', status)).toBe(false);
    }
  });
});

describe('assertNotificationStatusTransition', () => {
  it('returns without throwing for a legal transition', () => {
    expect(() => {
      assertNotificationStatusTransition('QUEUED', 'PROCESSING');
    }).not.toThrow();
  });

  it('throws a typed error carrying both statuses for an illegal transition', () => {
    let caughtError: unknown;

    try {
      assertNotificationStatusTransition('DELIVERED', 'QUEUED');
    } catch (error: unknown) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(IllegalNotificationStatusTransitionError);
    const transitionError = caughtError as IllegalNotificationStatusTransitionError;
    expect(transitionError.from).toBe('DELIVERED');
    expect(transitionError.to).toBe('QUEUED');
    expect(transitionError.message).toContain('DELIVERED');
    expect(transitionError.message).toContain('QUEUED');
  });
});

describe('isNotificationStatus', () => {
  it('accepts every known status', () => {
    for (const status of notificationStatuses) {
      expect(isNotificationStatus(status)).toBe(true);
    }
  });

  it('rejects values that are not statuses', () => {
    for (const candidate of ['', 'queued', 'READ', 'UNKNOWN', 'PENDING']) {
      expect(isNotificationStatus(candidate)).toBe(false);
    }
  });
});
