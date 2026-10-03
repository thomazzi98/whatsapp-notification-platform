/**
 * What WhatsApp itself reports about how far this account may reach out.
 *
 * WhatsApp restricts accounts that start conversations with people who never
 * wrote to them, and it does so without disconnecting anything: the session
 * keeps reporting itself as working while every message to a new contact is
 * refused. These are the two signals it gives about that, translated out of the
 * provider's vocabulary.
 */
export interface ReachoutTimelock {
  readonly isActive: boolean;
  /** When WhatsApp lifts it, or null when it did not say. */
  readonly endsAt: Date | null;
  /** WhatsApp's own label for the enforcement. Informational, and an open set. */
  readonly enforcementType: string | null;
}

/**
 * The monthly allowance of messages to people who have not replied.
 *
 * The status is WhatsApp's (NONE, FIRST_WARNING, SECOND_WARNING, CAPPED) and is
 * kept as a string because WhatsApp adds values without notice.
 */
export interface NewChatQuota {
  readonly status: string;
  /** Negative when the account has no cap at all. */
  readonly total: number;
  readonly used: number;
  readonly cycleEndsAt: Date | null;
}

export interface AccountLimits {
  /** Null when no timelock is known to be in force. */
  readonly reachoutTimelock: ReachoutTimelock | null;
  /** Null when WhatsApp reported nothing about the quota. */
  readonly newChatQuota: NewChatQuota | null;
}

export const sendingPauseReasons = ['REACHOUT_TIMELOCK'] as const;

export type SendingPauseReason = (typeof sendingPauseReasons)[number];

export interface SendingPause {
  readonly pausedUntil: Date;
  readonly reason: SendingPauseReason;
}

export interface SendingPauseInput {
  /** The freshest report, if there is one. */
  readonly limits: AccountLimits | null;
  /** WhatsApp refused a message for reaching out, whatever the report says. */
  readonly restrictionObserved: boolean;
  /** The pause already in force, if any. */
  readonly currentPausedUntil: Date | null;
  readonly now: Date;
  /** How long to stop when WhatsApp refused but did not say for how long. */
  readonly fallbackPauseMilliseconds: number;
}

/**
 * Decides whether a connection has to stop sending, and until when.
 *
 * Only the timelock stops a connection. While it holds, every message to a new
 * contact is refused, and reports tie repeated refusals to the account being
 * banned outright, so nothing is sent until it lifts — not even to people who
 * would have received it, because the platform cannot tell them apart.
 *
 * The quota never stops a connection. Once it is used up, only messages to new
 * contacts are refused, until a cycle that can be weeks away resets; people who
 * already talk to the number keep receiving, and each refusal fails just the
 * one notification it concerns.
 *
 * A pause is never shortened. A report that says nothing is in force can be
 * stale — the provider learns of a timelock from WhatsApp, not from the send it
 * refused — so the only thing that ends a pause is its time running out.
 */
export function resolveSendingPause(input: SendingPauseInput): SendingPause | undefined {
  const candidate = findPauseEnd(input);

  if (candidate === undefined) {
    return undefined;
  }

  const current = input.currentPausedUntil;
  const pausedUntil =
    current !== null && current.getTime() > candidate.getTime() ? current : candidate;

  return { pausedUntil, reason: 'REACHOUT_TIMELOCK' };
}

function findPauseEnd(input: SendingPauseInput): Date | undefined {
  const fallback = new Date(input.now.getTime() + input.fallbackPauseMilliseconds);
  const timelock = input.limits?.reachoutTimelock;

  if (timelock?.isActive === true) {
    const endsAt = timelock.endsAt;

    return endsAt !== null && endsAt.getTime() > input.now.getTime() ? endsAt : fallback;
  }
  return input.restrictionObserved ? fallback : undefined;
}

export function isSendingPaused(pausedUntil: Date | null, now: Date): boolean {
  return pausedUntil !== null && pausedUntil.getTime() > now.getTime();
}

/**
 * Whether WhatsApp has started warning that the quota is running out.
 *
 * Shown to an operator before it matters: once the quota is used up nothing
 * lifts it before the cycle ends, so the warning is the last moment slowing
 * down can still help.
 */
export function isNewChatQuotaUnderPressure(quota: NewChatQuota | null): boolean {
  return quota !== null && quota.status !== 'NONE';
}
