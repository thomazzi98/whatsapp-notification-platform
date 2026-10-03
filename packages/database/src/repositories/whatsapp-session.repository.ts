import {
  type AccountLimits,
  type ProviderSessionStatus,
  type SendingPause,
  type SendingPauseReason,
} from '@platform/domain';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { type QueryExecutor } from './notification.repository';
import { type StoredAccountLimits, whatsAppSessions } from '../schema';

function toStoredAccountLimits(limits: AccountLimits): StoredAccountLimits {
  const timelock = limits.reachoutTimelock;
  const quota = limits.newChatQuota;

  return {
    reachoutTimelock:
      timelock === null
        ? null
        : {
            isActive: timelock.isActive,
            endsAt: timelock.endsAt?.toISOString() ?? null,
            enforcementType: timelock.enforcementType,
          },
    newChatQuota:
      quota === null
        ? null
        : {
            status: quota.status,
            total: quota.total,
            used: quota.used,
            cycleEndsAt: quota.cycleEndsAt?.toISOString() ?? null,
          },
  };
}

export interface WhatsAppSessionRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly provider: string;
  readonly providerSessionName: string;
  readonly displayName: string;
  readonly status: ProviderSessionStatus;
  readonly phoneNumber: string | null;
  readonly pushName: string | null;
  readonly webhookSigningKeyCiphertext: Buffer;
  readonly sendPacingMinimumSeconds: number;
  readonly sendPacingMaximumSeconds: number;
  readonly nextSendAllowedAt: Date;
  /** Nothing is sent from the connection before this; null when no pause is in force. */
  readonly sendingPausedUntil: Date | null;
  readonly sendingPausedReason: SendingPauseReason | null;
  /** The last report of WhatsApp's limits on the account, for the dashboard. */
  readonly accountLimits: StoredAccountLimits | null;
  readonly accountLimitsCheckedAt: Date | null;
  readonly lastStatusAt: Date;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class WhatsAppSessionRepository {
  private readonly database: QueryExecutor;

  public constructor(database: QueryExecutor) {
    this.database = database;
  }

  public async insert(input: {
    readonly id: string;
    readonly applicationId: string;
    readonly providerSessionName: string;
    readonly displayName: string;
    readonly webhookSigningKeyCiphertext: Buffer;
  }): Promise<WhatsAppSessionRecord> {
    const [inserted] = await this.database.insert(whatsAppSessions).values(input).returning();

    if (inserted === undefined) {
      throw new Error('Inserting the WhatsApp session returned no row.');
    }
    return inserted as WhatsAppSessionRecord;
  }

  public async listForApplication(applicationId: string): Promise<WhatsAppSessionRecord[]> {
    const rows = await this.database
      .select()
      .from(whatsAppSessions)
      .where(eq(whatsAppSessions.applicationId, applicationId))
      .orderBy(whatsAppSessions.createdAt);

    return rows as WhatsAppSessionRecord[];
  }

  public async findById(
    applicationId: string,
    sessionId: string,
  ): Promise<WhatsAppSessionRecord | undefined> {
    const [found] = await this.database
      .select()
      .from(whatsAppSessions)
      .where(
        and(eq(whatsAppSessions.id, sessionId), eq(whatsAppSessions.applicationId, applicationId)),
      )
      .limit(1);

    return found as WhatsAppSessionRecord | undefined;
  }

  /**
   * Finds a session by identifier alone.
   *
   * The tenant is deliberately absent: a provider callback carries only the
   * identifier in its URL and proves itself with a signature, so there is no
   * tenant in hand to scope by. Every other lookup keeps the tenant in its
   * signature precisely so this one has to be written on purpose.
   */
  public async findByIdWithoutTenantScope(
    sessionId: string,
  ): Promise<WhatsAppSessionRecord | undefined> {
    const [found] = await this.database
      .select()
      .from(whatsAppSessions)
      .where(eq(whatsAppSessions.id, sessionId))
      .limit(1);

    return found as WhatsAppSessionRecord | undefined;
  }

  public async findByProviderName(
    providerSessionName: string,
  ): Promise<WhatsAppSessionRecord | undefined> {
    const [found] = await this.database
      .select()
      .from(whatsAppSessions)
      .where(eq(whatsAppSessions.providerSessionName, providerSessionName))
      .limit(1);

    return found as WhatsAppSessionRecord | undefined;
  }

  /**
   * Removes a session whose creation at the provider failed.
   *
   * The row is written first so the provider session name is reserved before it
   * is used, which means a failure has to be undone rather than ignored: a
   * leftover row would occupy a name the next attempt needs.
   */
  public async delete(applicationId: string, sessionId: string): Promise<boolean> {
    const deleted = await this.database
      .delete(whatsAppSessions)
      .where(
        and(eq(whatsAppSessions.id, sessionId), eq(whatsAppSessions.applicationId, applicationId)),
      )
      .returning({ id: whatsAppSessions.id });

    return deleted.length > 0;
  }

  public async recordStatus(
    sessionId: string,
    input: {
      readonly status: ProviderSessionStatus;
      readonly phoneNumber: string | null;
      readonly pushName: string | null;
      readonly lastError: string | null;
      readonly now: Date;
    },
  ): Promise<void> {
    await this.database
      .update(whatsAppSessions)
      .set({
        status: input.status,
        phoneNumber: input.phoneNumber,
        pushName: input.pushName,
        lastError: input.lastError,
        lastStatusAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(whatsAppSessions.id, sessionId));
  }

  /**
   * Claims the next refresh of the account's limits, if the last one is old.
   *
   * The time is stamped before WhatsApp is asked, so concurrent workers ask
   * once between them and a lookup that keeps failing is not repeated on every
   * dispatch. False means somebody refreshed recently enough.
   */
  public async claimAccountLimitsRefresh(
    sessionId: string,
    now: Date,
    staleBefore: Date,
  ): Promise<boolean> {
    const isStale = or(
      isNull(whatsAppSessions.accountLimitsCheckedAt),
      lt(whatsAppSessions.accountLimitsCheckedAt, staleBefore),
    );
    const claimed = await this.database
      .update(whatsAppSessions)
      .set({ accountLimitsCheckedAt: now })
      .where(and(eq(whatsAppSessions.id, sessionId), isStale))
      .returning({ id: whatsAppSessions.id });

    return claimed.length > 0;
  }

  /**
   * Makes the next dispatch ask about the limits again, whenever the last ask
   * was. For a refusal reported after the fact, as a failed delivery, which is
   * reason enough to doubt the last answer.
   */
  public async invalidateAccountLimits(sessionId: string): Promise<void> {
    await this.database
      .update(whatsAppSessions)
      .set({ accountLimitsCheckedAt: null })
      .where(eq(whatsAppSessions.id, sessionId));
  }

  /**
   * Records what WhatsApp reports, and the pause it calls for, if any.
   *
   * A pause is only ever extended here, never shortened — the later of the one
   * in force and the new one wins, in the statement itself, so two reports
   * arriving together cannot undo each other. Only the passing of time, or
   * {@link endSendingPause}, ends one.
   */
  public async recordAccountLimits(
    sessionId: string,
    input: {
      readonly limits: AccountLimits | null;
      readonly pause: SendingPause | undefined;
      readonly now: Date;
    },
  ): Promise<void> {
    const pause = input.pause;

    await this.database
      .update(whatsAppSessions)
      .set({
        ...(input.limits !== null && {
          accountLimits: toStoredAccountLimits(input.limits),
          accountLimitsCheckedAt: input.now,
        }),
        ...(pause !== undefined && {
          sendingPausedUntil: sql`greatest(
            coalesce(${whatsAppSessions.sendingPausedUntil}, ${pause.pausedUntil}),
            ${pause.pausedUntil}
          )`,
          sendingPausedReason: pause.reason,
        }),
        updatedAt: input.now,
      })
      .where(eq(whatsAppSessions.id, sessionId));
  }

  /**
   * Lifts a pause whose time has run out, once WhatsApp has been asked again.
   *
   * Conditional on the end the caller saw, so a pause another report extended
   * in the meantime is left alone.
   */
  public async endSendingPause(sessionId: string, observedPausedUntil: Date): Promise<void> {
    await this.database
      .update(whatsAppSessions)
      .set({ sendingPausedUntil: null, sendingPausedReason: null })
      .where(
        and(
          eq(whatsAppSessions.id, sessionId),
          eq(whatsAppSessions.sendingPausedUntil, observedPausedUntil),
        ),
      );
  }

  /**
   * Reserves the next send slot for a session, or reports that it is not yet
   * due.
   *
   * The interval is randomised rather than fixed because a metronomic send
   * pattern is exactly the fingerprint automated-messaging detection looks for.
   * Reserving with a conditional update means two workers cannot both claim the
   * same slot.
   */
  public async reserveSendSlot(
    sessionId: string,
    now: Date,
  ): Promise<{ readonly reserved: boolean; readonly nextSendAllowedAt: Date }> {
    const [reserved] = await this.database
      .update(whatsAppSessions)
      .set({
        nextSendAllowedAt: sql`now() + (
          ${whatsAppSessions.sendPacingMinimumSeconds}
          + floor(random() * (
              ${whatsAppSessions.sendPacingMaximumSeconds}
              - ${whatsAppSessions.sendPacingMinimumSeconds} + 1
            ))
        ) * interval '1 second'`,
        updatedAt: now,
      })
      .where(
        and(
          eq(whatsAppSessions.id, sessionId),
          sql`${whatsAppSessions.nextSendAllowedAt} <= ${now}`,
        ),
      )
      .returning({ nextSendAllowedAt: whatsAppSessions.nextSendAllowedAt });

    if (reserved !== undefined) {
      return { reserved: true, nextSendAllowedAt: reserved.nextSendAllowedAt };
    }

    const [current] = await this.database
      .select({ nextSendAllowedAt: whatsAppSessions.nextSendAllowedAt })
      .from(whatsAppSessions)
      .where(eq(whatsAppSessions.id, sessionId))
      .limit(1);

    return { reserved: false, nextSendAllowedAt: current?.nextSendAllowedAt ?? now };
  }
}
