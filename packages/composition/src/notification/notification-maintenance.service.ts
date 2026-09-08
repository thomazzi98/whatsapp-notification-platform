import { type ApplicationConfiguration } from '@platform/configuration';
import {
  type DatabaseConnection,
  type NotificationRecord,
  NotificationRepository,
} from '@platform/database';
import {
  CLOCK_PORT,
  type ClockPort,
  IDENTIFIER_GENERATOR_PORT,
  type IdentifierGeneratorPort,
} from '@platform/domain';
import { enqueueInTransaction, queueNames } from '@platform/queue';
import { Inject, Injectable } from '@nestjs/common';
import { type PgBoss } from 'pg-boss';

import { APPLICATION_CONFIGURATION, DATABASE_CONNECTION, QUEUE_CLIENT } from '../tokens';

export interface MaintenanceReport {
  readonly reapedClaims: number;
  readonly requeuedNotifications: number;
}

/**
 * The batch size for one maintenance pass.
 *
 * Bounded on purpose: a pass that tried to repair an entire backlog at once
 * would hold a long transaction and starve the dispatch workers it shares a
 * database with. The cron runs again a minute later, so a large backlog drains
 * over several passes instead of one stampede.
 */
const MAINTENANCE_BATCH_SIZE = 200;

/**
 * Repairs the delivery pipeline's two failure modes that nothing else can see.
 *
 * A worker killed mid-dispatch leaves a notification in PROCESSING, and
 * PROCESSING is deliberately the one state a claim cannot be taken from — so
 * without this it would stay there forever. A dispatch job can also be lost
 * outright, which leaves a perfectly valid notification with nothing scheduled
 * to send it.
 */
@Injectable()
export class NotificationMaintenanceService {
  private readonly connection: DatabaseConnection;
  private readonly notifications: NotificationRepository;
  private readonly clock: ClockPort;
  private readonly identifiers: IdentifierGeneratorPort;
  private readonly queue: PgBoss;
  private readonly configuration: ApplicationConfiguration;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(CLOCK_PORT) clock: ClockPort,
    @Inject(IDENTIFIER_GENERATOR_PORT) identifiers: IdentifierGeneratorPort,
    @Inject(QUEUE_CLIENT) queue: PgBoss,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
  ) {
    this.connection = connection;
    this.notifications = new NotificationRepository(connection.database);
    this.clock = clock;
    this.identifiers = identifiers;
    this.queue = queue;
    this.configuration = configuration;
  }

  /**
   * Returns abandoned claims to the queue.
   *
   * The claim is released rather than retried immediately, and the attempt
   * budget is left alone: whether the crashed worker reached WhatsApp is
   * recorded in the send attempt ledger, and the dispatcher reads that ledger
   * before it does anything else.
   */
  private async reapStuckClaims(): Promise<number> {
    const now = this.clock.now();
    const cutoff = new Date(
      now.getTime() - this.configuration.delivery.stuckClaimTimeoutSeconds * 1000,
    );
    const stuck = await this.notifications.findStuckClaims(cutoff, MAINTENANCE_BATCH_SIZE);
    let reaped = 0;

    for (const notification of stuck) {
      const isReleased = await this.releaseClaim(notification, now);
      if (isReleased) {
        reaped += 1;
      }
    }

    return reaped;
  }

  private async releaseClaim(notification: NotificationRecord, now: Date): Promise<boolean> {
    return this.connection.database.transaction(async (transaction) => {
      const released = await this.notifications.applyTransition(transaction, {
        applicationId: notification.applicationId,
        notificationId: notification.id,
        expectedStatus: 'PROCESSING',
        nextStatus: 'RETRYING',
        changes: { nextAttemptAt: now, claimToken: null, claimedAt: null },
        now,
      });

      if (released === undefined) {
        // The worker that held it finished between the scan and this update.
        return false;
      }

      await this.notifications.appendEvent(transaction, {
        id: this.identifiers.generate(),
        applicationId: notification.applicationId,
        notificationId: notification.id,
        eventType: 'notification.claim_reaped',
        fromStatus: 'PROCESSING',
        toStatus: 'RETRYING',
        attemptNumber: notification.attemptCount,
        payload: { claimedAt: notification.claimedAt?.toISOString() ?? null },
        correlationId: notification.correlationId,
      });
      await this.enqueueDispatch(transaction, notification, now);

      return true;
    });
  }

  /**
   * Re-sends a dispatch job for everything that is due.
   *
   * This is safe to run repeatedly precisely because the dispatch queue uses an
   * exclusive policy: a notification that already has a live job accepts no
   * second one, so a healthy system does nothing here and only a genuinely
   * orphaned notification is picked back up.
   */
  private async requeueDueNotifications(): Promise<number> {
    const now = this.clock.now();
    const due = await this.notifications.findDueForDispatch(now, MAINTENANCE_BATCH_SIZE);
    let requeued = 0;

    for (const notification of due) {
      const jobId = await this.connection.database.transaction(async (transaction) =>
        this.enqueueDispatch(transaction, notification, now),
      );

      if (jobId !== null) {
        requeued += 1;
      }
    }

    return requeued;
  }

  private async enqueueDispatch(
    transaction: Parameters<Parameters<DatabaseConnection['database']['transaction']>[0]>[0],
    notification: NotificationRecord,
    startAfter: Date,
  ): Promise<string | null> {
    return enqueueInTransaction(
      this.queue,
      transaction,
      queueNames.notificationDispatch,
      {
        // The original correlation identifier is kept, so a repaired delivery
        // is still traceable back to the request that asked for it.
        correlationId: notification.correlationId ?? notification.id,
        notificationId: notification.id,
        applicationId: notification.applicationId,
      },
      { singletonKey: notification.id, startAfter },
    );
  }

  public async runOnce(): Promise<MaintenanceReport> {
    const reapedClaims = await this.reapStuckClaims();
    const requeuedNotifications = await this.requeueDueNotifications();

    return { reapedClaims, requeuedNotifications };
  }
}
