import {
  type DatabaseConnection,
  type NotificationRecord,
  NotificationRepository,
  type NotificationTransitionChanges,
  type WebhookDeliveryRecord,
  WebhookDeliveryRepository,
  type WebhookOutcome,
  WhatsAppSessionRepository,
} from '@platform/database';
import {
  CLOCK_PORT,
  type ClockPort,
  type DeliveryAcknowledgement,
  deliveryAcknowledgements,
  describeAcknowledgement,
  IDENTIFIER_GENERATOR_PORT,
  type IdentifierGeneratorPort,
  isDeliveredAcknowledgement,
  isDeliveryAcknowledgement,
  isFailureAcknowledgement,
  isReadAcknowledgement,
  mergeAcknowledgements,
  type NotificationStatus,
  type ProviderEvent,
} from '@platform/domain';
import { enrichCorrelationContext, logEvents } from '@platform/observability';
import { toProviderEvent } from '@platform/provider-whatsapp';
import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';

import { DATABASE_CONNECTION, LOGGER } from '../tokens';
import { ConnectionLimitsService } from '../whatsapp/connection-limits.service';

export interface ProcessWebhookResult {
  readonly outcome: WebhookOutcome;
  readonly detail: string | null;
}

/**
 * How long an acknowledgement waits for the notification it belongs to.
 *
 * The provider can report a delivery receipt before the worker has committed
 * the send, so an unmatched callback is normal for a moment and permanent after
 * that. Retrying past this window would keep re-reading a notification that is
 * never going to appear — a receipt for a message this platform did not send.
 */
const UNMATCHED_GRACE_MILLISECONDS = 60_000;

@Injectable()
export class ProcessWebhookService {
  private readonly connection: DatabaseConnection;
  private readonly deliveries: WebhookDeliveryRepository;
  private readonly notifications: NotificationRepository;
  private readonly whatsAppSessions: WhatsAppSessionRepository;
  private readonly clock: ClockPort;
  private readonly identifiers: IdentifierGeneratorPort;
  private readonly logger: Logger;
  private readonly connectionLimits: ConnectionLimitsService;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(CLOCK_PORT) clock: ClockPort,
    @Inject(IDENTIFIER_GENERATOR_PORT) identifiers: IdentifierGeneratorPort,
    @Inject(LOGGER) logger: Logger,
    connectionLimits: ConnectionLimitsService,
  ) {
    this.connection = connection;
    this.deliveries = new WebhookDeliveryRepository(connection.database);
    this.notifications = new NotificationRepository(connection.database);
    this.whatsAppSessions = new WhatsAppSessionRepository(connection.database);
    this.clock = clock;
    this.identifiers = identifiers;
    this.logger = logger;
    this.connectionLimits = connectionLimits;
  }

  private async applySessionStatus(
    delivery: WebhookDeliveryRecord,
    event: Extract<ProviderEvent, { kind: 'session_status' }>,
  ): Promise<ProcessWebhookResult> {
    await this.whatsAppSessions.recordStatus(delivery.whatsAppSessionId, {
      status: event.status,
      phoneNumber: event.phoneNumber,
      pushName: event.pushName,
      lastError: null,
      now: this.clock.now(),
    });

    // The earliest word of a restriction there is: the provider repeats the
    // status the moment WhatsApp imposes one, while a refused message itself
    // is usually reported only later, as a failed delivery.
    if (event.accountLimits !== null) {
      const session = await this.whatsAppSessions.findByIdWithoutTenantScope(
        delivery.whatsAppSessionId,
      );
      if (session !== undefined) {
        await this.connectionLimits.record(session, event.accountLimits, {
          restrictionObserved: false,
          cause: 'reported',
        });
      }
    }

    // A connection dropping out of WORKING is the event an operator most needs
    // to see, and it was previously visible only by reading the table.
    this.logger.info(
      {
        event: logEvents.providerSessionStatusChanged,
        whatsAppSessionId: delivery.whatsAppSessionId,
        status: event.status,
      },
      `The provider reports the connection as ${event.status}`,
    );

    return { outcome: 'APPLIED', detail: `session ${event.status}` };
  }

  /**
   * Advances a notification by an acknowledgement.
   *
   * Acknowledgements arrive out of order and repeat, so the stored value is the
   * highest ever seen rather than the latest received — a DEVICE receipt
   * arriving after a READ receipt must not undo the read. READ is not a status:
   * a recipient can switch read receipts off, so treating its absence as
   * anything but silence would misreport healthy traffic, and DELIVERED stays
   * terminal.
   */
  private async applyAcknowledgement(
    delivery: WebhookDeliveryRecord,
    event: Extract<ProviderEvent, { kind: 'message_acknowledgement' }>,
  ): Promise<ProcessWebhookResult> {
    if (!event.fromUs) {
      return { outcome: 'IGNORED', detail: 'inbound message' };
    }

    if (isFailureAcknowledgement(event.acknowledgement)) {
      // A refusal for the account's reach usually surfaces like this, as a
      // delivery that failed after the send was accepted, rather than as an
      // error on the send. That is reason enough to doubt the last report of
      // the account's limits, so the next send asks WhatsApp again.
      await this.connectionLimits.doubtReportedLimits(delivery.whatsAppSessionId);
    }

    const notification = await this.notifications.findByProviderMessageId(
      delivery.whatsAppSessionId,
      event.providerMessageId,
    );

    if (notification === undefined) {
      return this.reportUnmatched(delivery);
    }

    // The callback's own scope carries only the callback's identifiers. Without
    // this, a delivery that WhatsApp reported as undeliverable was recorded as
    // FAILED and every line about it named the webhook rather than the
    // notification -- so the one query an operator would run, by notification
    // id, returned nothing.
    enrichCorrelationContext({
      notificationId: notification.id,
      applicationId: notification.applicationId,
    });

    const current = isDeliveryAcknowledgement(notification.providerAcknowledgement)
      ? notification.providerAcknowledgement
      : deliveryAcknowledgements.pending;
    const merged = mergeAcknowledgements(current, event.acknowledgement);

    if (merged === current && notification.providerAcknowledgement === current) {
      return { outcome: 'IGNORED', detail: `already at ${describeAcknowledgement(current)}` };
    }

    await this.recordAcknowledgement(notification, merged, event.acknowledgement);

    return { outcome: 'APPLIED', detail: describeAcknowledgement(merged) };
  }

  private reportUnmatched(delivery: WebhookDeliveryRecord): ProcessWebhookResult {
    const age = this.clock.now().getTime() - delivery.receivedAt.getTime();

    if (age < UNMATCHED_GRACE_MILLISECONDS) {
      // The send may still be committing. Throwing hands the job back to the
      // queue, which retries it with backoff.
      throw new Error(
        'The notification for this acknowledgement does not exist yet; the callback will be retried.',
      );
    }
    return { outcome: 'UNMATCHED', detail: 'no notification has this provider message identifier' };
  }

  private async recordAcknowledgement(
    notification: NotificationRecord,
    merged: DeliveryAcknowledgement,
    received: DeliveryAcknowledgement,
  ): Promise<void> {
    const now = this.clock.now();
    const nextStatus = resolveStatus(notification.status, merged);
    const changes: NotificationTransitionChanges = {
      providerAcknowledgement: merged,
      ...(isDeliveredAcknowledgement(merged) &&
        notification.deliveredAt === null && { deliveredAt: now }),
      ...(isReadAcknowledgement(merged) && notification.readAt === null && { readAt: now }),
      ...(isFailureAcknowledgement(merged) && {
        failedAt: now,
        failureCode: 'provider_acknowledgement_error',
        failureReason: 'WhatsApp reported that this message could not be delivered.',
        failureClassification: 'PERMANENT' as const,
      }),
    };

    await this.connection.database.transaction(async (transaction) => {
      await this.notifications.applyTransition(transaction, {
        applicationId: notification.applicationId,
        notificationId: notification.id,
        expectedStatus: notification.status,
        nextStatus,
        changes,
        now,
      });
      await this.notifications.appendEvent(transaction, {
        id: this.identifiers.generate(),
        applicationId: notification.applicationId,
        notificationId: notification.id,
        eventType: 'notification.acknowledged',
        fromStatus: notification.status,
        toStatus: nextStatus,
        attemptNumber: notification.attemptCount,
        payload: {
          acknowledgement: describeAcknowledgement(received),
          highestAcknowledgement: describeAcknowledgement(merged),
        },
        correlationId: notification.correlationId,
      });
    });
  }

  private async applyEvent(
    delivery: WebhookDeliveryRecord,
    event: ProviderEvent,
  ): Promise<ProcessWebhookResult> {
    if (event.kind === 'message_acknowledgement') {
      return this.applyAcknowledgement(delivery, event);
    }
    if (event.kind === 'session_status') {
      return this.applySessionStatus(delivery, event);
    }
    return { outcome: 'IGNORED', detail: `unsupported event ${event.eventType}` };
  }

  /**
   * Applies one recorded callback.
   *
   * The delivery is claimed first, so a job redelivered after the handler
   * already finished does nothing rather than writing a second timeline entry
   * for the same receipt.
   */
  public async process(deliveryId: string): Promise<ProcessWebhookResult> {
    const delivery = await this.deliveries.claimForProcessing(deliveryId);

    if (delivery === undefined) {
      return { outcome: 'IGNORED', detail: 'already processed' };
    }

    const event = toProviderEvent({
      id: delivery.providerEventId,
      session: delivery.providerSessionName,
      event: delivery.eventType,
      payload: delivery.payload,
      me: null,
    });

    const result = await this.applyEvent(delivery, event);
    await this.deliveries.markProcessed({
      deliveryId,
      outcome: result.outcome,
      detail: result.detail,
      now: this.clock.now(),
    });

    return result;
  }
}

/**
 * A failure acknowledgement is the one case where the provider can end a
 * message's life after it was accepted. Everything else either advances a sent
 * message to delivered or changes no status at all.
 */
function resolveStatus(
  current: NotificationStatus,
  merged: DeliveryAcknowledgement,
): NotificationStatus {
  if (current !== 'SENT') {
    return current;
  }
  if (isFailureAcknowledgement(merged)) {
    return 'FAILED';
  }
  if (isDeliveredAcknowledgement(merged)) {
    return 'DELIVERED';
  }
  return current;
}
