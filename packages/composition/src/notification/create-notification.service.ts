import { createHash } from 'node:crypto';

import {
  type DatabaseConnection,
  IdempotencyKeyRepository,
  type NotificationRecord,
  NotificationRepository,
  type QueryExecutor,
  WhatsAppSessionRepository,
} from '@platform/database';
import {
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

export interface CreateNotificationInput {
  readonly applicationId: string;
  readonly recipient: string;
  readonly body: string;
  readonly whatsAppSessionId?: string;
  readonly scheduledAt?: Date;
  readonly maximumAttempts?: number;
  readonly metadata: Record<string, string>;
  readonly idempotencyKey?: string;
  readonly requestPath: string;
}

export interface CreateNotificationResult {
  readonly notification: NotificationRecord;
  /** True when an earlier identical request already produced this notification. */
  readonly wasReplayed: boolean;
}

const IDEMPOTENCY_WINDOW_HOURS = 24;

/**
 * Canonicalised so a semantically identical retry produces the same digest
 * regardless of key order in the client's JSON.
 */
function fingerprintRequest(input: CreateNotificationInput): Buffer {
  const canonical = JSON.stringify({
    applicationId: input.applicationId,
    recipient: input.recipient,
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

@Injectable()
export class CreateNotificationService {
  private readonly connection: DatabaseConnection;
  private readonly notifications: NotificationRepository;
  private readonly idempotencyKeys: IdempotencyKeyRepository;
  private readonly whatsAppSessions: WhatsAppSessionRepository;
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
    this.notifications = new NotificationRepository(connection.database);
    this.idempotencyKeys = new IdempotencyKeyRepository(connection.database);
    this.whatsAppSessions = new WhatsAppSessionRepository(connection.database);
    this.clock = clock;
    this.identifiers = identifiers;
    this.queue = queue;
  }

  private async resolveSession(
    applicationId: string,
    requestedSessionId: string | undefined,
  ): Promise<{ readonly id: string }> {
    const sessions = await this.whatsAppSessions.listForApplication(applicationId);

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
    const connected = sessions.find((session) => session.status === 'WORKING');
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
   * A completed claim replays the original notification; an in-flight one is a
   * genuine conflict, because holding the connection open until the first
   * request finishes has no clean timeout story and hides the concurrency from
   * the client. A different payload under the same key is a client bug, and
   * answering it with the first response would hide that.
   */
  private async claimIdempotencyKey(
    transaction: QueryExecutor,
    input: CreateNotificationInput,
    fingerprint: Buffer,
    now: Date,
  ): Promise<{
    readonly idempotencyKeyId: string | null;
    readonly lockToken: string;
    readonly replayOf?: string;
  }> {
    const lockToken = this.identifiers.generate();

    if (input.idempotencyKey === undefined) {
      return { idempotencyKeyId: null, lockToken };
    }

    const claim = await this.idempotencyKeys.claim(transaction, {
      applicationId: input.applicationId,
      key: input.idempotencyKey,
      requestMethod: 'POST',
      requestPath: input.requestPath,
      requestFingerprint: fingerprint,
      lockToken,
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_WINDOW_HOURS * 3_600_000),
    });

    if (claim.outcome === 'claimed') {
      return { idempotencyKeyId: claim.id, lockToken: claim.lockToken };
    }

    if (!claim.record.requestFingerprint.equals(fingerprint)) {
      throw new DomainError(
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request body.',
      );
    }
    if (claim.record.state === 'COMPLETED' && claim.record.resourceId !== null) {
      return {
        idempotencyKeyId: claim.record.id,
        lockToken: claim.record.lockToken,
        replayOf: claim.record.resourceId,
      };
    }

    throw new DomainError(
      'idempotency_key_in_flight',
      'A request with this Idempotency-Key is already being processed. Retry shortly.',
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

    if (input.scheduledAt !== undefined && input.scheduledAt.getTime() <= now.getTime()) {
      throw new DomainError(
        'invalid_schedule',
        'A scheduled notification must be scheduled for a time in the future.',
      );
    }

    const session = await this.resolveSession(input.applicationId, input.whatsAppSessionId);
    const fingerprint = fingerprintRequest(input);
    const correlationId = getCorrelationId() ?? this.identifiers.generate();
    const notificationId = this.identifiers.generate();
    const isScheduled = input.scheduledAt !== undefined;
    const status: NotificationStatus = isScheduled ? 'SCHEDULED' : 'QUEUED';

    const outcome = await this.connection.database.transaction(async (transaction) => {
      const claim = await this.claimIdempotencyKey(transaction, input, fingerprint, now);

      if (claim.replayOf !== undefined) {
        return { notificationId: claim.replayOf, wasReplayed: true };
      }

      await this.notifications.insert(transaction, {
        id: notificationId,
        applicationId: input.applicationId,
        whatsAppSessionId: session.id,
        templateId: null,
        status,
        recipientPhoneNumber: recipient,
        renderedBody: input.body,
        templateVariables: null,
        priority: 0,
        scheduledAt: input.scheduledAt ?? null,
        maximumAttempts: input.maximumAttempts ?? 5,
        idempotencyKeyId: claim.idempotencyKeyId,
        correlationId,
        metadata: input.metadata,
      });

      await this.notifications.appendEvent(transaction, {
        id: this.identifiers.generate(),
        applicationId: input.applicationId,
        notificationId,
        eventType: 'notification.created',
        fromStatus: null,
        toStatus: status,
        attemptNumber: null,
        // The recipient is masked even here: the timeline is read through
        // tenant-scoped authorization, but the payload is also copied into logs.
        payload: { recipient: maskPhoneNumberForLog(recipient), scheduled: isScheduled },
        correlationId,
      });

      await enqueueInTransaction(
        this.queue,
        transaction,
        queueNames.notificationDispatch,
        { correlationId, notificationId, applicationId: input.applicationId },
        {
          singletonKey: notificationId,
          // Scheduling is a column in Postgres rather than a timer in a
          // process, so it survives a restart.
          ...(input.scheduledAt !== undefined && { startAfter: input.scheduledAt }),
        },
      );

      if (claim.idempotencyKeyId !== null) {
        await this.idempotencyKeys.complete(transaction, {
          id: claim.idempotencyKeyId,
          lockToken: claim.lockToken,
          responseStatus: 201,
          responseBody: { id: notificationId },
          resourceId: notificationId,
          now,
        });
      }

      return { notificationId, wasReplayed: false };
    });

    const notification = await this.notifications.findById(
      input.applicationId,
      outcome.notificationId,
    );
    if (notification === undefined) {
      throw new Error('The notification disappeared immediately after it was created.');
    }

    return { notification, wasReplayed: outcome.wasReplayed };
  }
}
