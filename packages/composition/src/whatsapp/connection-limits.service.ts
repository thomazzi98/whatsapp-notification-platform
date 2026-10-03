import { type ApplicationConfiguration } from '@platform/configuration';
import {
  type DatabaseConnection,
  type WhatsAppSessionRecord,
  WhatsAppSessionRepository,
} from '@platform/database';
import {
  type AccountLimits,
  CLOCK_PORT,
  type ClockPort,
  resolveSendingPause,
} from '@platform/domain';
import { logEvents } from '@platform/observability';
import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';

import { APPLICATION_CONFIGURATION, DATABASE_CONNECTION, LOGGER } from '../tokens';

type LimitsSubject = Pick<WhatsAppSessionRecord, 'id' | 'applicationId' | 'sendingPausedUntil'>;

/**
 * Writes down what WhatsApp enforces on a connection's account, and pauses the
 * connection when that calls for it.
 *
 * It never asks the provider anything, which is what lets callback processing
 * use it: a callback already carries the report, and the process that files
 * callbacks has no business holding a WhatsApp client.
 */
@Injectable()
export class ConnectionLimitsService {
  private readonly sessions: WhatsAppSessionRepository;
  private readonly clock: ClockPort;
  private readonly configuration: ApplicationConfiguration;
  private readonly logger: Logger;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(CLOCK_PORT) clock: ClockPort,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.sessions = new WhatsAppSessionRepository(connection.database);
    this.clock = clock;
    this.configuration = configuration;
    this.logger = logger;
  }

  private logPause(record: LimitsSubject, pausedUntil: Date, cause: string): void {
    // A warning, not information: an operator who sees this and re-pairs the
    // number to "fix" it renews the restriction instead.
    this.logger.warn(
      {
        event: logEvents.providerSendingPaused,
        whatsAppSessionId: record.id,
        applicationId: record.applicationId,
        pausedUntil: pausedUntil.toISOString(),
        cause,
      },
      `WhatsApp is restricting this number from reaching new contacts; sending is paused until ${pausedUntil.toISOString()}. Do not restart, unpair or re-pair it: that does not lift the restriction.`,
    );
  }

  /**
   * Records a report of the account's limits, and the pause it calls for.
   *
   * `restrictionObserved` is a message WhatsApp refused for reaching out: proof
   * of a timelock even when the report says none is in force, since the
   * provider can learn of one later than the refusal itself.
   */
  public async record(
    record: LimitsSubject,
    limits: AccountLimits | null,
    options: { readonly restrictionObserved: boolean; readonly cause: string },
  ): Promise<void> {
    const now = this.clock.now();
    const pause = resolveSendingPause({
      limits,
      restrictionObserved: options.restrictionObserved,
      currentPausedUntil: record.sendingPausedUntil,
      now,
      fallbackPauseMilliseconds:
        this.configuration.delivery.restrictionFallbackPauseHours * 3_600_000,
    });

    await this.sessions.recordAccountLimits(record.id, { limits, pause, now });

    // Logged when the pause begins or moves, not every time a report repeats
    // the same one.
    if (
      pause !== undefined &&
      pause.pausedUntil.getTime() !== record.sendingPausedUntil?.getTime()
    ) {
      this.logPause(record, pause.pausedUntil, options.cause);
    }
  }

  /**
   * Makes the next send ask WhatsApp about the limits again. For a delivery
   * that failed after the fact, which is how a refusal often surfaces.
   */
  public async doubtReportedLimits(sessionId: string): Promise<void> {
    await this.sessions.invalidateAccountLimits(sessionId);
  }
}
