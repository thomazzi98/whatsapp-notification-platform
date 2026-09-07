/**
 * The notification lifecycle. This module is the single source of truth for
 * which transitions are legal; the database trigger in
 * `packages/database/migrations` mirrors this table and a drift test asserts
 * the two agree.
 */
export const notificationStatuses = [
  'SCHEDULED',
  'QUEUED',
  'PROCESSING',
  'SENT',
  'DELIVERED',
  'RETRYING',
  'FAILED',
  'CANCELLED',
] as const;

export type NotificationStatus = (typeof notificationStatuses)[number];

/**
 * Deliberate exclusions:
 *
 * - `FAILED` has no outgoing edges. Retrying a dead notification creates a new
 *   row that points back through `retryOfNotificationId`, so the audit trail
 *   never rewrites history.
 * - `PROCESSING` cannot be cancelled. A provider call may already be in flight
 *   and a sent WhatsApp message cannot be revoked, so offering cancellation
 *   there would be a lie.
 * - `DELIVERED` is terminal. A read receipt sets `readAt` without changing
 *   status, because read receipts are optional and their absence is not a
 *   delivery failure.
 */
export const notificationStatusTransitions = {
  SCHEDULED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SENT', 'RETRYING', 'FAILED'],
  SENT: ['DELIVERED', 'FAILED'],
  DELIVERED: [],
  RETRYING: ['PROCESSING', 'CANCELLED', 'FAILED'],
  FAILED: [],
  CANCELLED: [],
} as const satisfies Record<NotificationStatus, readonly NotificationStatus[]>;

export const terminalNotificationStatuses = ['DELIVERED', 'FAILED', 'CANCELLED'] as const;

export type TerminalNotificationStatus = (typeof terminalNotificationStatuses)[number];

const terminalStatusSet: ReadonlySet<NotificationStatus> = new Set(terminalNotificationStatuses);

export function isTerminalNotificationStatus(status: NotificationStatus): boolean {
  return terminalStatusSet.has(status);
}

export function isNotificationStatus(candidate: string): candidate is NotificationStatus {
  return (notificationStatuses as readonly string[]).includes(candidate);
}

export function canTransitionNotificationStatus(
  from: NotificationStatus,
  to: NotificationStatus,
): boolean {
  return (notificationStatusTransitions[from] as readonly NotificationStatus[]).includes(to);
}

/**
 * The set of statuses a caller is allowed to cancel from. Derived from the
 * transition table rather than written out separately, so the two can never
 * disagree.
 */
export const cancellableNotificationStatuses: readonly NotificationStatus[] =
  notificationStatuses.filter((status) => canTransitionNotificationStatus(status, 'CANCELLED'));

export function isCancellableNotificationStatus(status: NotificationStatus): boolean {
  return canTransitionNotificationStatus(status, 'CANCELLED');
}

export class IllegalNotificationStatusTransitionError extends Error {
  public readonly from: NotificationStatus;
  public readonly to: NotificationStatus;

  public constructor(from: NotificationStatus, to: NotificationStatus) {
    super(`Cannot move a notification from ${from} to ${to}.`);
    this.name = 'IllegalNotificationStatusTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertNotificationStatusTransition(
  from: NotificationStatus,
  to: NotificationStatus,
): void {
  if (canTransitionNotificationStatus(from, to)) {
    return;
  }
  throw new IllegalNotificationStatusTransitionError(from, to);
}
