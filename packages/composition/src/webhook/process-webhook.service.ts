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
import { toProviderEvent } from '@platform/provider-whatsapp';
import { Inject, Injectable } from '@nestjs/common';

import { DATABASE_CONNECTION } from '../tokens';

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

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(CLOCK_PORT) clock: ClockPort,
    @Inject(IDENTIFIER_GENERATOR_PORT) identifiers: IdentifierGeneratorPort,
  ) {
    this.connection = connection;
    this.deliveries = new WebhookDeliveryRepository(connection.database);
    this.notifications = new NotificationRepository(connection.database);
    this.whatsAppSessions = new WhatsAppSessionRepository(connection.database);
    this.clock = clock;
    this.identifiers = identifiers;
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

    const notification = await this.notifications.findByProviderMessageId(
      delivery.whatsAppSessionId,
      event.providerMessageId,
    );

    if (notification === undefined) {
      return this.reportUnmatched(delivery);
    }

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
