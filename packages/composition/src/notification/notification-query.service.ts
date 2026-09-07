import { createHmac, timingSafeEqual } from 'node:crypto';

import { type ApplicationConfiguration } from '@platform/configuration';
import {
  type DatabaseConnection,
  type NotificationEventRecord,
  type NotificationListFilters,
  type NotificationRecord,
  NotificationRepository,
} from '@platform/database';
import {
  CLOCK_PORT,
  type ClockPort,
  DomainError,
  IDENTIFIER_GENERATOR_PORT,
  type IdentifierGeneratorPort,
  isCancellableNotificationStatus,
  type NotificationStatus,
} from '@platform/domain';
import { getCorrelationId } from '@platform/observability';
import { Inject, Injectable } from '@nestjs/common';

import { APPLICATION_CONFIGURATION, DATABASE_CONNECTION } from '../tokens';

export interface NotificationListQuery {
  readonly statuses?: readonly NotificationStatus[];
  readonly recipient?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface NotificationListResult {
  readonly items: readonly NotificationRecord[];
  readonly nextCursor: string | null;
}

interface CursorPayload {
  readonly createdAt: string;
  readonly id: string;
}

@Injectable()
export class NotificationQueryService {
  private readonly connection: DatabaseConnection;
  private readonly notifications: NotificationRepository;
  private readonly configuration: ApplicationConfiguration;
  private readonly clock: ClockPort;
  private readonly identifiers: IdentifierGeneratorPort;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
    @Inject(CLOCK_PORT) clock: ClockPort,
    @Inject(IDENTIFIER_GENERATOR_PORT) identifiers: IdentifierGeneratorPort,
  ) {
    this.connection = connection;
    this.notifications = new NotificationRepository(connection.database);
    this.configuration = configuration;
    this.clock = clock;
    this.identifiers = identifiers;
  }

  /**
   * Cursors are signed so a tampered value is rejected rather than turned into
   * a confusing query, and so their shape stays an implementation detail.
   */
  private encodeCursor(payload: CursorPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');

    return `${encoded}.${this.signCursor(encoded)}`;
  }

  private decodeCursor(cursor: string | undefined): CursorPayload | undefined {
    if (cursor === undefined) {
      return undefined;
    }

    const [encoded, signature] = cursor.split('.', 2);
    if (encoded === undefined || signature === undefined) {
      throw new DomainError('invalid_cursor', 'The pagination cursor is not valid.');
    }

    const expected = this.signCursor(encoded);
    const suppliedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (
      suppliedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(suppliedBuffer, expectedBuffer)
    ) {
      throw new DomainError('invalid_cursor', 'The pagination cursor is not valid.');
    }

    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CursorPayload;

    return parsed;
  }

  private signCursor(encoded: string): string {
    return createHmac('sha256', Buffer.from(this.configuration.security.cursorSigningKey, 'base64'))
      .update(encoded)
      .digest('base64url');
  }

  public async getOrFail(
    applicationId: string,
    notificationId: string,
  ): Promise<NotificationRecord> {
    const found = await this.notifications.findById(applicationId, notificationId);

    if (found === undefined) {
      throw new DomainError('notification_not_found', 'That notification does not exist.');
    }
    return found;
  }

  public async listEvents(
    applicationId: string,
    notificationId: string,
  ): Promise<readonly NotificationEventRecord[]> {
    await this.getOrFail(applicationId, notificationId);

    return this.notifications.listEvents(applicationId, notificationId);
  }

  public async list(
    applicationId: string,
    query: NotificationListQuery,
  ): Promise<NotificationListResult> {
    const filters: NotificationListFilters = {
      ...(query.statuses !== undefined && { statuses: query.statuses }),
      ...(query.recipient !== undefined && { recipientPhoneNumber: query.recipient }),
    };

    const cursor = this.decodeCursor(query.cursor);
    const page = await this.notifications.list(
      applicationId,
      filters,
      cursor === undefined ? undefined : { createdAt: new Date(cursor.createdAt), id: cursor.id },
      query.limit,
    );

    return {
      items: page.items,
      nextCursor:
        page.nextCursor === null
          ? null
          : this.encodeCursor({
              createdAt: page.nextCursor.createdAt.toISOString(),
              id: page.nextCursor.id,
            }),
    };
  }

  /**
   * Cancels a notification that has not yet been handed to the provider.
   *
   * A notification already being dispatched cannot be cancelled: the provider
   * call may be in flight and a sent WhatsApp message cannot be revoked. The
   * conditional update is what makes that safe under a race with the worker —
   * whichever of the two commits first wins, and the other sees no rows.
   */
  public async cancel(applicationId: string, notificationId: string): Promise<NotificationRecord> {
    const existing = await this.getOrFail(applicationId, notificationId);

    if (!isCancellableNotificationStatus(existing.status)) {
      throw new DomainError(
        'notification_not_cancellable',
        `A notification in the ${existing.status} state cannot be cancelled.`,
        { currentStatus: existing.status },
      );
    }

    const now = this.clock.now();
    const cancelled = await this.notifications.applyTransition(this.connection.database, {
      applicationId,
      notificationId,
      expectedStatus: existing.status,
      nextStatus: 'CANCELLED',
      changes: { cancelledAt: now },
      now,
    });

    if (cancelled === undefined) {
      throw new DomainError(
        'notification_not_cancellable',
        'The notification changed state before it could be cancelled.',
      );
    }

    await this.notifications.appendEvent(this.connection.database, {
      id: this.identifiers.generate(),
      applicationId,
      notificationId,
      eventType: 'notification.cancelled',
      fromStatus: existing.status,
      toStatus: 'CANCELLED',
      attemptNumber: null,
      payload: {},
      correlationId: getCorrelationId() ?? null,
    });

    return cancelled;
  }
}
