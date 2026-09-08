import { type NotificationEventRecord, type NotificationRecord } from '@platform/composition';
import { type NotificationEventResponse, type NotificationResponse } from '@platform/contracts';

/**
 * One shape for a notification, whichever surface asked for it.
 *
 * The dashboard and the public API answer the same question and must not be
 * able to drift: a field added for one and forgotten in the other would make
 * the two views of a delivery disagree about what happened.
 */
export function toNotificationResponse(record: NotificationRecord): NotificationResponse {
  return {
    id: record.id,
    status: record.status,
    recipient: record.recipientPhoneNumber,
    body: record.renderedBody,
    whatsAppSessionId: record.whatsAppSessionId,
    scheduledAt: record.scheduledAt?.toISOString() ?? null,
    attemptCount: record.attemptCount,
    maximumAttempts: record.maximumAttempts,
    nextAttemptAt: record.nextAttemptAt?.toISOString() ?? null,
    providerMessageId: record.providerMessageId,
    sentAt: record.sentAt?.toISOString() ?? null,
    deliveredAt: record.deliveredAt?.toISOString() ?? null,
    readAt: record.readAt?.toISOString() ?? null,
    failedAt: record.failedAt?.toISOString() ?? null,
    failureCode: record.failureCode,
    failureReason: record.failureReason,
    metadata: record.metadata,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toNotificationEventResponse(
  record: NotificationEventRecord,
): NotificationEventResponse {
  return {
    id: record.id,
    eventType: record.eventType,
    fromStatus: record.fromStatus,
    toStatus: record.toStatus,
    attemptNumber: record.attemptNumber,
    payload: record.payload,
    occurredAt: record.occurredAt.toISOString(),
  };
}
