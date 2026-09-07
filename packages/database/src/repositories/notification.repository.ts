import { type NotificationStatus } from '@platform/domain';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';

import { type Database } from '../connection';
import { notificationEvents, notifications } from '../schema';

/**
 * A repository method may run on its own or inside a caller's transaction. The
 * transactional case is what lets a notification and its dispatch job commit
 * together.
 */
export type QueryExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface NotificationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly whatsAppSessionId: string;
  readonly templateId: string | null;
  readonly status: NotificationStatus;
  readonly recipientPhoneNumber: string;
  readonly recipientChatIdentifier: string | null;
  readonly renderedBody: string;
  readonly templateVariables: Record<string, string> | null;
  readonly priority: number;
  readonly scheduledAt: Date | null;
  readonly attemptCount: number;
  readonly maximumAttempts: number;
  readonly nextAttemptAt: Date | null;
  readonly claimToken: string | null;
  readonly claimedAt: Date | null;
  readonly providerMessageId: string | null;
  readonly providerAcknowledgement: number;
  readonly sentAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly readAt: Date | null;
  readonly failedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly deadLetteredAt: Date | null;
  readonly failureCode: string | null;
  readonly failureReason: string | null;
  readonly retryOfNotificationId: string | null;
  readonly correlationId: string | null;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InsertNotificationInput {
  readonly id: string;
  readonly applicationId: string;
  readonly whatsAppSessionId: string;
  readonly templateId: string | null;
  readonly status: NotificationStatus;
  readonly recipientPhoneNumber: string;
  readonly renderedBody: string;
  readonly templateVariables: Record<string, string> | null;
  readonly priority: number;
  readonly scheduledAt: Date | null;
  readonly maximumAttempts: number;
  readonly idempotencyKeyId: string | null;
  readonly correlationId: string | null;
  readonly metadata: Record<string, string>;
}

export interface NotificationEventInput {
  readonly id: string;
  readonly applicationId: string;
  readonly notificationId: string;
  readonly eventType: string;
  readonly fromStatus: NotificationStatus | null;
  readonly toStatus: NotificationStatus | null;
  readonly attemptNumber: number | null;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string | null;
}

export interface NotificationEventRecord extends NotificationEventInput {
  readonly occurredAt: Date;
}

export interface NotificationListFilters {
  readonly statuses?: readonly NotificationStatus[];
  readonly recipientPhoneNumber?: string;
  readonly templateId?: string;
  readonly createdBefore?: Date;
}

export interface NotificationPage {
  readonly items: readonly NotificationRecord[];
  readonly nextCursor: { readonly createdAt: Date; readonly id: string } | null;
}

export class NotificationRepository {
  private readonly database: Database;

  public constructor(database: Database) {
    this.database = database;
  }

  public async insert(
    executor: QueryExecutor,
    input: InsertNotificationInput,
  ): Promise<NotificationRecord> {
    const [inserted] = await executor.insert(notifications).values(input).returning();

    if (inserted === undefined) {
      throw new Error('Inserting the notification returned no row.');
    }
    return inserted as NotificationRecord;
  }

  public async appendEvent(executor: QueryExecutor, input: NotificationEventInput): Promise<void> {
    await executor.insert(notificationEvents).values(input);
  }

  public async findById(
    applicationId: string,
    notificationId: string,
  ): Promise<NotificationRecord | undefined> {
    const [found] = await this.database
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.id, notificationId), eq(notifications.applicationId, applicationId)),
      )
      .limit(1);

    return found as NotificationRecord | undefined;
  }

  public async listEvents(
    applicationId: string,
    notificationId: string,
  ): Promise<NotificationEventRecord[]> {
    const rows = await this.database
      .select()
      .from(notificationEvents)
      .where(
        and(
          eq(notificationEvents.notificationId, notificationId),
          eq(notificationEvents.applicationId, applicationId),
        ),
      )
      .orderBy(notificationEvents.occurredAt, notificationEvents.id);

    return rows as NotificationEventRecord[];
  }

  /**
   * Keyset pagination on (createdAt, id).
   *
   * Offset pages drift on a table that is written continuously and mutated in
   * place, duplicating and skipping rows under exactly the load where the list
   * matters most.
   */
  public async list(
    applicationId: string,
    filters: NotificationListFilters,
    cursor: { readonly createdAt: Date; readonly id: string } | undefined,
    limit: number,
  ): Promise<NotificationPage> {
    const conditions = [eq(notifications.applicationId, applicationId)];

    if (filters.statuses !== undefined && filters.statuses.length > 0) {
      conditions.push(inArray(notifications.status, [...filters.statuses]));
    }
    if (filters.recipientPhoneNumber !== undefined) {
      conditions.push(eq(notifications.recipientPhoneNumber, filters.recipientPhoneNumber));
    }
    if (filters.templateId !== undefined) {
      conditions.push(eq(notifications.templateId, filters.templateId));
    }
    if (filters.createdBefore !== undefined) {
      conditions.push(lt(notifications.createdAt, filters.createdBefore));
    }
    if (cursor !== undefined) {
      // Strictly after the cursor in (createdAt, id) order, with the identifier
      // breaking ties when two rows share a timestamp.
      const sameTimestampButEarlier = and(
        eq(notifications.createdAt, cursor.createdAt),
        lt(notifications.id, cursor.id),
      );
      const olderThanCursor = or(
        lt(notifications.createdAt, cursor.createdAt),
        sameTimestampButEarlier,
      );

      if (olderThanCursor !== undefined) {
        conditions.push(olderThanCursor);
      }
    }

    // One extra row decides whether another page exists, without a count query.
    const rows = await this.database
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);

    const items = rows.slice(0, limit) as NotificationRecord[];
    const last = items.at(-1);
    const hasMorePages = rows.length > limit;
    const nextCursor =
      last !== undefined && hasMorePages ? { createdAt: last.createdAt, id: last.id } : null;

    return { items, nextCursor };
  }

  /**
   * Claims a notification for dispatch with a compare-and-swap.
   *
   * Returning no row means another worker already owns it, the notification is
   * terminal, or it was cancelled. This is the guard that makes concurrent
   * double dispatch impossible — not the queue's own deduplication, which is
   * only an optimisation.
   *
   * The attempt count increments here, before the provider is called, so a
   * worker that dies mid-send still burns an attempt and infrastructure
   * redelivery cannot exceed the budget a customer was promised.
   */
  public async claimForDispatch(
    applicationId: string,
    notificationId: string,
    claimToken: string,
    now: Date,
  ): Promise<NotificationRecord | undefined> {
    const [claimed] = await this.database
      .update(notifications)
      .set({
        status: 'PROCESSING',
        claimToken,
        claimedAt: now,
        attemptCount: sql`${notifications.attemptCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.applicationId, applicationId),
          inArray(notifications.status, ['QUEUED', 'RETRYING']),
        ),
      )
      .returning();

    return claimed as NotificationRecord | undefined;
  }

  /**
   * Moves a notification to a new status only if it is still in the status the
   * caller observed. Zero rows means something else changed it first — the
   * webhook path and the worker path race by design.
   */
  public async applyTransition(
    executor: QueryExecutor,
    input: {
      readonly applicationId: string;
      readonly notificationId: string;
      readonly expectedStatus: NotificationStatus;
      readonly nextStatus: NotificationStatus;
      readonly changes: Partial<Record<string, unknown>>;
      readonly now: Date;
    },
  ): Promise<NotificationRecord | undefined> {
    const [updated] = await executor
      .update(notifications)
      .set({ status: input.nextStatus, updatedAt: input.now, ...input.changes })
      .where(
        and(
          eq(notifications.id, input.notificationId),
          eq(notifications.applicationId, input.applicationId),
          eq(notifications.status, input.expectedStatus),
        ),
      )
      .returning();

    return updated as NotificationRecord | undefined;
  }
}
