import { type AccountLimits, type NewChatQuota, type ReachoutTimelock } from '@platform/domain';
import { z } from 'zod';

/**
 * WAHA's ReachoutTimelockData. Read permissively: the enforcement type is an
 * open set WhatsApp extends without notice, and a value this version does not
 * know must not hide that a timelock is in force.
 */
const reachoutTimelockSchema = z.object({
  isActive: z.boolean(),
  timeEnforcementEnds: z.number().nullish(),
  enforcementType: z.string().nullish(),
});

/** WAHA's MessageCappingData, read just as permissively. */
const messageCappingSchema = z.object({
  cappingStatus: z.string().min(1),
  totalQuota: z.number(),
  usedQuota: z.number(),
  cycleEnd: z.number().nullish(),
});

const limitsContainerSchema = z.object({
  reachoutTimelock: z.unknown().optional(),
  messageCapping: z.unknown().optional(),
});

/** WAHA reports instants as Unix seconds. Zero and nonsense mean "not said". */
function fromUnixSeconds(seconds: number | null | undefined): Date | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000);
}

export function readReachoutTimelock(value: unknown): ReachoutTimelock | null {
  const parsed = reachoutTimelockSchema.safeParse(value);

  if (!parsed.success) {
    return null;
  }
  return {
    isActive: parsed.data.isActive,
    endsAt: fromUnixSeconds(parsed.data.timeEnforcementEnds),
    enforcementType: parsed.data.enforcementType ?? null,
  };
}

export function readNewChatQuota(value: unknown): NewChatQuota | null {
  const parsed = messageCappingSchema.safeParse(value);

  if (!parsed.success) {
    return null;
  }
  return {
    status: parsed.data.cappingStatus,
    total: parsed.data.totalQuota,
    used: parsed.data.usedQuota,
    cycleEndsAt: fromUnixSeconds(parsed.data.cycleEnd),
  };
}

/**
 * Reads the limits out of anything that carries them side by side: the
 * session's `me`, or the data a WORKING status is repeated with.
 *
 * Both carry only what is in force — WAHA leaves a timelock out once it has
 * lifted and a quota out while nothing is used — so an absent field reads as
 * nothing in force, never as an error.
 */
export function readAccountLimits(container: unknown): AccountLimits {
  const parsed = limitsContainerSchema.safeParse(container ?? {});

  if (!parsed.success) {
    return { reachoutTimelock: null, newChatQuota: null };
  }
  return {
    reachoutTimelock: readReachoutTimelock(parsed.data.reachoutTimelock),
    newChatQuota: readNewChatQuota(parsed.data.messageCapping),
  };
}
