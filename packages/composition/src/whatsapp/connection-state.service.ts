import {
  type DatabaseConnection,
  type WhatsAppSessionRecord,
  WhatsAppSessionRepository,
} from '@platform/database';
import {
  type AccountLimits,
  CLOCK_PORT,
  type ClockPort,
  WHATSAPP_PROVIDER_PORT,
  type WhatsAppProviderPort,
} from '@platform/domain';
import { Inject, Injectable } from '@nestjs/common';

import { DATABASE_CONNECTION } from '../tokens';
import { ConnectionLimitsService } from './connection-limits.service';

export const FORGOTTEN_BY_PROVIDER =
  'The WhatsApp provider no longer has this connection. Start it to pair it again.';

/**
 * How old a report of the account's limits may be before a send asks again.
 *
 * The provider repeats the session's status when a restriction starts, so a
 * callback normally gets there first; this bounds how long a missed callback
 * can go unnoticed. Ten minutes is ten to twenty paced sends at most.
 */
const ACCOUNT_LIMITS_MAXIMUM_AGE_MILLISECONDS = 10 * 60_000;

/** WhatsApp's two refusals for reaching out, as the provider failure codes name them. */
export type ReachRefusal = 'connection_restricted' | 'new_chat_quota_exceeded';

/**
 * What the platform knows about a WhatsApp connection beyond its own records:
 * whether the provider still has it, and what WhatsApp enforces on its account.
 *
 * Shared by the dashboard and the dispatcher, so both ask the same way and
 * write the same answer.
 */
@Injectable()
export class ConnectionStateService {
  private readonly sessions: WhatsAppSessionRepository;
  private readonly provider: WhatsAppProviderPort;
  private readonly clock: ClockPort;
  private readonly limits: ConnectionLimitsService;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(WHATSAPP_PROVIDER_PORT) provider: WhatsAppProviderPort,
    @Inject(CLOCK_PORT) clock: ClockPort,
    limits: ConnectionLimitsService,
  ) {
    this.sessions = new WhatsAppSessionRepository(connection.database);
    this.provider = provider;
    this.clock = clock;
    this.limits = limits;
  }

  private async reread(record: WhatsAppSessionRecord): Promise<WhatsAppSessionRecord> {
    return (await this.sessions.findById(record.applicationId, record.id)) ?? record;
  }

  /**
   * Ends a pause whose time is up, unless WhatsApp says the timelock still
   * holds, in which case the pause moves to its new end.
   */
  private async settleExpiredPause(record: WhatsAppSessionRecord): Promise<WhatsAppSessionRecord> {
    const pausedUntil = record.sendingPausedUntil;

    if (pausedUntil === null || pausedUntil.getTime() > this.clock.now().getTime()) {
      return record;
    }

    const limits = await this.fetchLimits(record);
    if (limits?.reachoutTimelock?.isActive === true) {
      // Recorded as a fresh pause: the expired one must not be what it is
      // measured against.
      await this.limits.record({ ...record, sendingPausedUntil: null }, limits, {
        restrictionObserved: false,
        cause: 'still_restricted',
      });
      return this.reread(record);
    }

    await this.sessions.endSendingPause(record.id, pausedUntil);
    if (limits !== null) {
      await this.sessions.recordAccountLimits(record.id, {
        limits,
        pause: undefined,
        now: this.clock.now(),
      });
    }
    return this.reread(record);
  }

  /** WhatsApp's own answer, or the provider's memory of it when that is all there is. */
  private async fetchLimits(record: WhatsAppSessionRecord): Promise<AccountLimits | null> {
    const fresh = await this.provider.fetchAccountLimits(record.providerSessionName);

    if (fresh.outcome === 'succeeded') {
      return fresh.value;
    }
    return this.readReportedLimits(record);
  }

  /** What the provider last heard, which costs no request to WhatsApp. */
  private async readReportedLimits(record: WhatsAppSessionRecord): Promise<AccountLimits | null> {
    const live = await this.provider.getSession(record.providerSessionName);

    if (live.outcome === 'failed' || live.value === undefined) {
      return null;
    }
    return live.value.accountLimits;
  }

  /**
   * Asks the provider what state the connection is in and writes it down.
   *
   * A provider that cannot be reached leaves the record as it was: that says
   * nothing about the connection. A provider that no longer has the session
   * is an answer, and is recorded as STOPPED — a record still saying WORKING
   * would keep being chosen for sends that can only fail.
   */
  public async refreshStatus(record: WhatsAppSessionRecord): Promise<WhatsAppSessionRecord> {
    const live = await this.provider.getSession(record.providerSessionName);

    if (live.outcome === 'failed') {
      return record;
    }

    const now = this.clock.now();
    if (live.value === undefined) {
      if (record.status !== 'STOPPED') {
        await this.sessions.recordStatus(record.id, {
          status: 'STOPPED',
          phoneNumber: record.phoneNumber,
          pushName: record.pushName,
          lastError: FORGOTTEN_BY_PROVIDER,
          now,
        });
      }
      return this.reread(record);
    }

    await this.sessions.recordStatus(record.id, {
      status: live.value.status,
      phoneNumber: live.value.phoneNumber,
      pushName: live.value.pushName,
      lastError: null,
      now,
    });
    if (live.value.accountLimits !== null) {
      await this.limits.record(record, live.value.accountLimits, {
        restrictionObserved: false,
        cause: 'reported',
      });
    }

    return this.reread(record);
  }

  /**
   * Gets the connection ready for a send: ends a pause whose time has run out,
   * once WhatsApp confirms it, and refreshes a report of the limits that has
   * grown old.
   *
   * Only one worker refreshes at a time, and a lookup that fails still counts
   * as the refresh: a provider that cannot answer must not be asked again by
   * every dispatch, and sending is never held up waiting for it.
   */
  public async prepareToSend(record: WhatsAppSessionRecord): Promise<WhatsAppSessionRecord> {
    const settled = await this.settleExpiredPause(record);
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - ACCOUNT_LIMITS_MAXIMUM_AGE_MILLISECONDS);
    const isRefreshClaimed = await this.sessions.claimAccountLimitsRefresh(
      settled.id,
      now,
      staleBefore,
    );

    if (!isRefreshClaimed) {
      return settled;
    }

    // Never checked, or doubted after a failed delivery: worth WhatsApp's own
    // answer rather than the provider's memory of it.
    const limits =
      settled.accountLimitsCheckedAt === null
        ? await this.fetchLimits(settled)
        : await this.readReportedLimits(settled);
    if (limits !== null) {
      await this.limits.record(settled, limits, { restrictionObserved: false, cause: 'reported' });
    }

    return this.reread(settled);
  }

  /**
   * Records a message WhatsApp refused for the account's reach.
   *
   * WhatsApp is asked afresh, because the refusal is the reason to doubt the
   * last report. A reachout timelock pauses the connection — until WhatsApp
   * says it ends, or for the configured fallback when it does not say, since
   * the refusal itself is proof enough. A used-up quota pauses nothing: it
   * refuses only new contacts, and is recorded for the dashboard.
   */
  public async recordRefusal(record: WhatsAppSessionRecord, refusal: ReachRefusal): Promise<void> {
    const limits = await this.fetchLimits(record);

    await this.limits.record(record, limits, {
      restrictionObserved: refusal === 'connection_restricted',
      cause: refusal,
    });
  }
}
