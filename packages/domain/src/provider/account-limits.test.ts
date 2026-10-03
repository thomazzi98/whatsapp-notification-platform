import { describe, expect, it } from 'vitest';

import {
  type AccountLimits,
  isNewChatQuotaUnderPressure,
  isSendingPaused,
  type NewChatQuota,
  resolveSendingPause,
} from './account-limits';

const now = new Date('2026-10-03T12:00:00.000Z');
const sixHours = 6 * 3_600_000;
const inTwoHours = new Date(now.getTime() + 2 * 3_600_000);
const inTenHours = new Date(now.getTime() + 10 * 3_600_000);
const aSecondAgo = new Date(now.getTime() - 1000);

function limits(overrides: Partial<AccountLimits> = {}): AccountLimits {
  return { reachoutTimelock: null, newChatQuota: null, ...overrides };
}

function quota(status: string): NewChatQuota {
  return { status, total: 100, used: 100, cycleEndsAt: inTenHours };
}

describe('deciding whether a connection stops sending', () => {
  it('stops until WhatsApp lifts the timelock', () => {
    const pause = resolveSendingPause({
      limits: limits({
        reachoutTimelock: { isActive: true, endsAt: inTwoHours, enforcementType: 'DEFAULT' },
      }),
      restrictionObserved: false,
      currentPausedUntil: null,
      now,
      fallbackPauseMilliseconds: sixHours,
    });

    expect(pause).toStrictEqual({ pausedUntil: inTwoHours, reason: 'REACHOUT_TIMELOCK' });
  });

  it('falls back to a fixed pause when the timelock has no end', () => {
    const pause = resolveSendingPause({
      limits: limits({
        reachoutTimelock: { isActive: true, endsAt: null, enforcementType: null },
      }),
      restrictionObserved: false,
      currentPausedUntil: null,
      now,
      fallbackPauseMilliseconds: sixHours,
    });

    expect(pause?.pausedUntil).toStrictEqual(new Date(now.getTime() + sixHours));
  });

  it('treats an end already in the past as no end at all', () => {
    const pause = resolveSendingPause({
      limits: limits({
        reachoutTimelock: { isActive: true, endsAt: aSecondAgo, enforcementType: null },
      }),
      restrictionObserved: false,
      currentPausedUntil: null,
      now,
      fallbackPauseMilliseconds: sixHours,
    });

    expect(pause?.pausedUntil).toStrictEqual(new Date(now.getTime() + sixHours));
  });

  it('stops after a refusal even when the report says nothing is in force', () => {
    // The provider learns of a timelock from WhatsApp, not from the send it
    // refused, so its report can lag behind the refusal itself.
    const pause = resolveSendingPause({
      limits: limits(),
      restrictionObserved: true,
      currentPausedUntil: null,
      now,
      fallbackPauseMilliseconds: sixHours,
    });

    expect(pause).toStrictEqual({
      pausedUntil: new Date(now.getTime() + sixHours),
      reason: 'REACHOUT_TIMELOCK',
    });
  });

  it('does not stop for a used-up quota, which refuses only new contacts', () => {
    const pause = resolveSendingPause({
      limits: limits({ newChatQuota: quota('CAPPED') }),
      restrictionObserved: false,
      currentPausedUntil: null,
      now,
      fallbackPauseMilliseconds: sixHours,
    });

    expect(pause).toBeUndefined();
  });

  it('never shortens a pause already in force', () => {
    const pause = resolveSendingPause({
      limits: limits({
        reachoutTimelock: { isActive: true, endsAt: inTwoHours, enforcementType: null },
      }),
      restrictionObserved: false,
      currentPausedUntil: inTenHours,
      now,
      fallbackPauseMilliseconds: sixHours,
    });

    expect(pause?.pausedUntil).toStrictEqual(inTenHours);
  });

  it('extends a pause when the new end is later', () => {
    const pause = resolveSendingPause({
      limits: limits({
        reachoutTimelock: { isActive: true, endsAt: inTenHours, enforcementType: null },
      }),
      restrictionObserved: false,
      currentPausedUntil: inTwoHours,
      now,
      fallbackPauseMilliseconds: sixHours,
    });

    expect(pause?.pausedUntil).toStrictEqual(inTenHours);
  });

  it('leaves a connection alone when nothing is in force and nothing was refused', () => {
    const pause = resolveSendingPause({
      limits: limits(),
      restrictionObserved: false,
      currentPausedUntil: null,
      now,
      fallbackPauseMilliseconds: sixHours,
    });

    expect(pause).toBeUndefined();
  });
});

describe('whether a connection is paused', () => {
  it('is paused until the moment the pause ends, and not after', () => {
    expect(isSendingPaused(inTwoHours, now)).toBe(true);
    expect(isSendingPaused(now, now)).toBe(false);
    expect(isSendingPaused(null, now)).toBe(false);
  });
});

describe('the new-chat quota', () => {
  it('is under pressure from the first warning on', () => {
    expect(isNewChatQuotaUnderPressure(quota('FIRST_WARNING'))).toBe(true);
    expect(isNewChatQuotaUnderPressure(quota('CAPPED'))).toBe(true);
    expect(isNewChatQuotaUnderPressure(quota('A_STATUS_WHATSAPP_ADDS_LATER'))).toBe(true);
  });

  it('is not under pressure when WhatsApp reports nothing', () => {
    expect(isNewChatQuotaUnderPressure(quota('NONE'))).toBe(false);
    expect(isNewChatQuotaUnderPressure(null)).toBe(false);
  });
});
