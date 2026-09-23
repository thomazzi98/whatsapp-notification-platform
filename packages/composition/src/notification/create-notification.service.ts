import { createHash } from 'node:crypto';

import {
  type DatabaseConnection,
  type DatabaseTransaction,
  IdempotencyKeyRepository,
  type NotificationRecord,
  NotificationRepository,
  type QueryExecutor,
  WhatsAppSessionRepository,
  withTenantScope,
} from '@platform/database';
import {
  canSessionSend,
  CLOCK_PORT,
  type ClockPort,
  DomainError,
  IDENTIFIER_GENERATOR_PORT,
  type IdentifierGeneratorPort,
  maskPhoneNumberForLog,
  type NotificationStatus,
  parsePhoneNumber,
} from '@platform/domain';
import { getCorrelationId } from '@platform/observability';
import { enqueueInTransaction, queueNames } from '@platform/queue';
import { Inject, Injectable } from '@nestjs/common';
import { type PgBoss } from 'pg-boss';

import { DATABASE_CONNECTION, QUEUE_CLIENT } from '../tokens';

/** What every notification request carries, however it is addressed. */
interface NotificationRequest {
  readonly applicationId: string;
  readonly body: string;
  readonly whatsAppSessionId?: string;
  readonly scheduledAt?: Date;
  readonly maximumAttempts?: number;
  readonly metadata: Record<string, string>;
  readonly idempotencyKey?: string;
  readonly requestPath: string;
}

export interface CreateNotificationInput extends NotificationRequest {
  readonly recipient: string;
}

export interface CreateNotificationBatchInput extends NotificationRequest {
  /** Distinct, in the order the caller gave them. */
  readonly recipients: readonly string[];
}

export interface CreateNotificationResult {
  readonly notification: NotificationRecord;
  /** True when an earlier identical request already produced this notification. */
  readonly wasReplayed: boolean;
}

export interface CreateNotificationBatchResult {
  /** One per recipient, in the order the recipients were given. */
  readonly notifications: readonly NotificationRecord[];
  /** True when an earlier identical request already produced these notifications. */
  readonly wasReplayed: boolean;
}

type IdempotencyClaimResult =
  | {
      readonly kind: 'fresh';
      readonly idempotencyKeyId: string | null;
      readonly lockToken: string;
    }
  | {
      readonly kind: 'completed';
      readonly resourceId: string | null;
      readonly responseBody: Record<string, unknown> | null;
    };

const IDEMPOTENCY_WINDOW_HOURS = 24;

/**
 * Canonicalised so a semantically identical retry produces the same digest
 * regardless of key order in the client's JSON. A single recipient and a list
 * of them hash differently by construction, so one key cannot be replayed
 * across the two endpoints.
 */
function fingerprintRequest(
  input: NotificationRequest,
  addressing: { readonly recipient: string } | { readonly recipients: readonly string[] },
): Buffer {
  const canonical = JSON.stringify({
    applicationId: input.applicationId,
    ...addressing,
    body: input.body,
    whatsAppSessionId: input.whatsAppSessionId ?? null,
    scheduledAt: input.scheduledAt?.toISOString() ?? null,
    maximumAttempts: input.maximumAttempts ?? null,
    metadata: Object.fromEntries(
      Object.entries(input.metadata).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  });

  return createHash('sha256').update(canonical).digest();
}

function assertScheduleIsInTheFuture(input: NotificationRequest, now: Date): void {
  if (input.scheduledAt !== undefined && input.scheduledAt.getTime() <= now.getTime()) {
    throw new DomainError(
      'invalid_schedule',
      'A scheduled notification must be scheduled for a time in the future.',
    );
  }
}

/**
 * A completed batch key records the notifications it created, in request
 * order. Only a single-recipient request completes without that list, and its
 * fingerprint can never match a batch's, so a missing list is corruption rather
 * than a case to handle.
 */
function readBatchNotificationIds(responseBody: Record<string, unknown> | null): string[] {
  const identifiers = responseBody?.notificationIds;

  if (
    !Array.isArray(identifiers) ||
    !identifiers.every((identifier): identifier is string => typeof identifier === 'string')
  ) {
    throw new Error('A completed batch idempotency key recorded no notifications.');
  }
  return identifiers;
}

@Injectable()
export class CreateNotificationService {
  private readonly connection: DatabaseConnection;
  private readonly clock: ClockPort;
  private readonly identifiers: IdentifierGeneratorPort;
  private readonly queue: PgBoss;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(CLOCK_PORT) clock: ClockPort,
    @Inject(IDENTIFIER_GENERATOR_PORT) identifiers: IdentifierGeneratorPort,
    @Inject(QUEUE_CLIENT) queue: PgBoss,
  ) {
    this.connection = connection;
    this.clock = clock;
    this.identifiers = identifiers;
    this.queue = queue;
  }

  private async readOrFail(
    notifications: NotificationRepository,
    applicationId: string,
    notificationId: string,
  ): Promise<NotificationRecord> {
    const notification = await notifications.findById(applicationId, notificationId);

    if (notification === undefined) {
      throw new Error('The notification could not be read back after it was written.');
    }
    return notification;
  }

  private async readAllOrFail(
    notifications: NotificationRepository,
    applicationId: string,
    notificationIds: readonly string[],
  ): Promise<NotificationRecord[]> {
    const found: NotificationRecord[] = [];

    // One transaction is one connection, so these run one after another
    // however they are written.
    for (const notificationId of notificationIds) {
      found.push(await this.readOrFail(notifications, applicationId, notificationId));
    }
    return found;
  }

  private async resolveSession(
    whatsAppSessions: WhatsAppSessionRepository,
    applicationId: string,
    requestedSessionId: string | undefined,
  ): Promise<{ readonly id: string }> {
    const sessions = await whatsAppSessions.listForApplication(applicationId);

    if (requestedSessionId !== undefined) {
      const requested = sessions.find((session) => session.id === requestedSessionId);
      if (requested === undefined) {
        throw new DomainError(
          'whatsapp_session_not_found',
          'That WhatsApp connection does not exist.',
        );
      }
      return requested;
    }

    // Prefer a connected session, but accept any: a notification created while
    // WhatsApp is disconnected is queued rather than rejected, which is the
    // point of having a queue at all.
    const connected = sessions.find((session) => canSessionSend(session.status));
    const chosen = connected ?? sessions[0];

    if (chosen === undefined) {
      throw new DomainError(
        'no_whatsapp_session',
        'This application has no WhatsApp connection. Connect one before sending.',
      );
    }
    return chosen;
  }

  /**
   * Claims the key, or decides what an existing claim means.
   *
   * A completed claim replays what the first request created; an in-flight one
   * is a genuine conflict, because holding the connection open until the first
   * request finishes has no clean timeout story and hides the concurrency from
   * the client. A different payload under the same key is a client bug, and
   * answering it with the first response would hide that.
   */
  private async claimIdempotencyKey(
    idempotencyKeys: IdempotencyKeyRepository,
    transaction: QueryExecutor,
    input: NotificationRequest,
    fingerprint: Buffer,
    now: Date,
  ): Promise<IdempotencyClaimResult> {
    const lockToken = this.identifiers.generate();

    if (input.idempotencyKey === undefined) {
      return { kind: 'fresh', idempotencyKeyId: null, lockToken };
    }

    const claim = await idempotencyKeys.claim(transaction, {
      applicationId: input.applicationId,
      key: input.idempotencyKey,
      requestMethod: 'POST',
      requestPath: input.requestPath,
      requestFingerprint: fingerprint,
      lockToken,
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_WINDOW_HOURS * 3_600_000),
    });

    if (claim.outcome === 'claimed') {
      return { kind: 'fresh', idempotencyKeyId: claim.id, lockToken: claim.lockToken };
    }

    if (!claim.record.requestFingerprint.equals(fingerprint)) {
      throw new DomainError(
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request body.',
      );
    }
    if (claim.record.state === 'COMPLETED') {
      return {
        kind: 'completed',
        resourceId: claim.record.resourceId,
        responseBody: claim.record.responseBody,
      };
    }

    throw new DomainError(
      'idempotency_key_in_flight',
      'A request with this Idempotency-Key is already being processed. Retry shortly.',
    );
  }

  /**
   * Writes one notification, its first timeline entry and its dispatch job
   * inside the caller's transaction. Both creation paths use it, so a batch and
   * a single request cannot come to disagree about what creating one means.
   */
  private async writeNotification(
    transaction: DatabaseTransaction,
    notifications: NotificationRepository,
    draft: {
      readonly id: string;
      readonly recipient: string;
      readonly sessionId: string;
      readonly idempotencyKeyId: string | null;
      readonly correlationId: string;
      readonly request: NotificationRequest;
    },
  ): Promise<void> {
    const { request } = draft;
    const isScheduled = request.scheduledAt !== undefined;
    const status: NotificationStatus = isScheduled ? 'SCHEDULED' : 'QUEUED';

    await notifications.insert(transaction, {
      id: draft.id,
      applicationId: request.applicationId,
      whatsAppSessionId: draft.sessionId,
      templateId: null,
      status,
      recipientPhoneNumber: draft.recipient,
      renderedBody: request.body,
      templateVariables: null,
      priority: 0,
      scheduledAt: request.scheduledAt ?? null,
      maximumAttempts: request.maximumAttempts ?? 5,
      idempotencyKeyId: draft.idempotencyKeyId,
      correlationId: draft.correlationId,
      metadata: request.metadata,
    });

    await notifications.appendEvent(transaction, {
      id: this.identifiers.generate(),
      applicationId: request.applicationId,
      notificationId: draft.id,
      eventType: 'notification.created',
      fromStatus: null,
      toStatus: status,
      attemptNumber: null,
      // The recipient is masked even here: the timeline is read through
      // tenant-scoped authorization, but the payload is also copied into logs.
      payload: { recipient: maskPhoneNumberForLog(draft.recipient), scheduled: isScheduled },
      correlationId: draft.correlationId,
    });

    await enqueueInTransaction(
      this.queue,
      transaction,
      queueNames.notificationDispatch,
      {
        correlationId: draft.correlationId,
        notificationId: draft.id,
        applicationId: request.applicationId,
      },
      {
        singletonKey: draft.id,
        // Scheduling is a column in Postgres rather than a timer in a
        // process, so it survives a restart.
        ...(request.scheduledAt !== undefined && { startAfter: request.scheduledAt }),
      },
    );
  }

  /**
   * Creates a notification and its dispatch job in a single transaction.
   *
   * Claiming the idempotency key, writing the notification, recording the first
   * timeline event, enqueuing the job and completing the key all commit or roll
   * back together. That removes the dual-write problem: there is never a
   * notification with no job to dispatch it, and never a job pointing at a row
   * that was not committed. Rolling back also releases the key, so a failed
   * attempt does not poison it for the next twenty-four hours.
   *
   * It is only sound because no network call happens inside the transaction.
   * The provider is contacted by the worker, never by the request.
   */
  public async create(input: CreateNotificationInput): Promise<CreateNotificationResult> {
    const recipient = parsePhoneNumber(input.recipient);
    const now = this.clock.now();
    assertScheduleIsInTheFuture(input, now);

    const fingerprint = fingerprintRequest(input, { recipient: input.recipient });
    const correlationId = getCorrelationId() ?? this.identifiers.generate();
    const notificationId = this.identifiers.generate();

    return withTenantScope(this.connection.database, input.applicationId, async (transaction) => {
      const notifications = new NotificationRepository(transaction);
      const idempotencyKeys = new IdempotencyKeyRepository(transaction);
      const session = await this.resolveSession(
        new WhatsAppSessionRepository(transaction),
        input.applicationId,
        input.whatsAppSessionId,
      );
      const claim = await this.claimIdempotencyKey(
        idempotencyKeys,
        transaction,
        input,
        fingerprint,
        now,
      );

      if (claim.kind === 'completed') {
        // Only a batch completes without a single resource, and a batch
        // request's fingerprint can never match this one.
        if (claim.resourceId === null) {
          throw new Error('A completed idempotency key recorded no notification.');
        }
        return {
          notification: await this.readOrFail(notifications, input.applicationId, claim.resourceId),
          wasReplayed: true,
        };
      }

      await this.writeNotification(transaction, notifications, {
        id: notificationId,
        recipient,
        sessionId: session.id,
        idempotencyKeyId: claim.idempotencyKeyId,
        correlationId,
        request: input,
      });

      if (claim.idempotencyKeyId !== null) {
        await idempotencyKeys.complete(transaction, {
          id: claim.idempotencyKeyId,
          lockToken: claim.lockToken,
          responseStatus: 202,
          responseBody: { id: notificationId },
          resourceId: notificationId,
          now,
        });
      }

      return {
        notification: await this.readOrFail(notifications, input.applicationId, notificationId),
        wasReplayed: false,
      };
    });
  }

  /**
   * Creates one notification per recipient, all in one transaction.
   *
   * They share a correlation id, because they answer one request, and one
   * idempotency key, so a retried batch replays every notification it created
   * rather than creating the rest a second time. They share nothing else: each
   * is dispatched, retried and acknowledged on its own, so one partner's full
   * inbox cannot delay or fail the message to the others.
   */
  public async createBatch(
    input: CreateNotificationBatchInput,
  ): Promise<CreateNotificationBatchResult> {
    const drafts = input.recipients.map((recipient) => ({
      id: this.identifiers.generate(),
      recipient: parsePhoneNumber(recipient),
    }));
    const now = this.clock.now();
    assertScheduleIsInTheFuture(input, now);

    const fingerprint = fingerprintRequest(input, { recipients: input.recipients });
    const correlationId = getCorrelationId() ?? this.identifiers.generate();
    const notificationIds = drafts.map((draft) => draft.id);

    return withTenantScope(this.connection.database, input.applicationId, async (transaction) => {
      const notifications = new NotificationRepository(transaction);
      const idempotencyKeys = new IdempotencyKeyRepository(transaction);
      const session = await this.resolveSession(
        new WhatsAppSessionRepository(transaction),
        input.applicationId,
        input.whatsAppSessionId,
      );
      const claim = await this.claimIdempotencyKey(
        idempotencyKeys,
        transaction,
        input,
        fingerprint,
        now,
      );

      if (claim.kind === 'completed') {
        return {
          notifications: await this.readAllOrFail(
            notifications,
            input.applicationId,
            readBatchNotificationIds(claim.responseBody),
          ),
          wasReplayed: true,
        };
      }

      // Sequential on purpose: every write shares the transaction's single
      // connection, so there is nothing to gain from issuing them together.
      for (const draft of drafts) {
        await this.writeNotification(transaction, notifications, {
          id: draft.id,
          recipient: draft.recipient,
          sessionId: session.id,
          idempotencyKeyId: claim.idempotencyKeyId,
          correlationId,
          request: input,
        });
      }

      if (claim.idempotencyKeyId !== null) {
        await idempotencyKeys.complete(transaction, {
          id: claim.idempotencyKeyId,
          lockToken: claim.lockToken,
          responseStatus: 202,
          responseBody: { notificationIds },
          resourceId: null,
          now,
        });
      }

      return {
        notifications: await this.readAllOrFail(
          notifications,
          input.applicationId,
          notificationIds,
        ),
        wasReplayed: false,
      };
    });
  }
}
