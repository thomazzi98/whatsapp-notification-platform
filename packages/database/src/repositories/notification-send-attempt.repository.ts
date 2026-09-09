import { and, eq, isNull } from 'drizzle-orm';

import { notificationSendAttempts } from '../schema';
import { type QueryExecutor } from './notification.repository';

export const sendAttemptOutcomes = ['SUCCEEDED', 'FAILED', 'UNKNOWN'] as const;

export type SendAttemptOutcome = (typeof sendAttemptOutcomes)[number];

export interface SendAttemptRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly notificationId: string;
  readonly attemptNumber: number;
  readonly requestStartedAt: Date;
  readonly requestFinishedAt: Date | null;
  readonly outcome: SendAttemptOutcome | null;
  readonly providerMessageId: string | null;
  readonly failureCode: string | null;
}

export interface BeginSendAttemptInput {
  readonly id: string;
  readonly applicationId: string;
  readonly notificationId: string;
  readonly attemptNumber: number;
  readonly requestStartedAt: Date;
}

export interface ResolveSendAttemptInput {
  readonly applicationId: string;
  readonly notificationId: string;
  readonly attemptNumber: number;
  readonly outcome: SendAttemptOutcome;
  readonly providerMessageId?: string;
  readonly failureCode?: string;
  readonly now: Date;
}

/**
 * The ledger of provider calls, and the only durable record that a request may
 * have been written to the network.
 *
 * A row is inserted and committed before the provider is contacted, and
 * resolved once an answer arrives. A row that is still unresolved when the
 * notification comes round again therefore means one thing: the process died
 * with a send in flight, and whether WhatsApp acted on it is unknowable.
 */
export class NotificationSendAttemptRepository {
  private readonly database: QueryExecutor;

  public constructor(database: QueryExecutor) {
    this.database = database;
  }

  public async begin(
    executor: QueryExecutor,
    input: BeginSendAttemptInput,
  ): Promise<SendAttemptRecord> {
    const [inserted] = await executor.insert(notificationSendAttempts).values(input).returning();

    if (inserted === undefined) {
      throw new Error('Recording the send attempt returned no row.');
    }
    return inserted as SendAttemptRecord;
  }

  /**
   * `executor` lets the resolution commit with whatever else the caller is
   * writing. The success path needs that: an attempt marked SUCCEEDED in its own
   * statement, followed by a separate transaction for the SENT row, leaves a
   * window where a crash loses the send and the reaper resends it.
   */
  public async resolve(input: ResolveSendAttemptInput, executor?: QueryExecutor): Promise<void> {
    await (executor ?? this.database)
      .update(notificationSendAttempts)
      .set({
        outcome: input.outcome,
        requestFinishedAt: input.now,
        providerMessageId: input.providerMessageId ?? null,
        failureCode: input.failureCode ?? null,
      })
      .where(
        and(
          eq(notificationSendAttempts.notificationId, input.notificationId),
          eq(notificationSendAttempts.applicationId, input.applicationId),
          eq(notificationSendAttempts.attemptNumber, input.attemptNumber),
        ),
      );
  }

  public async findUnresolved(
    applicationId: string,
    notificationId: string,
  ): Promise<SendAttemptRecord | undefined> {
    const [found] = await this.database
      .select()
      .from(notificationSendAttempts)
      .where(
        and(
          eq(notificationSendAttempts.notificationId, notificationId),
          eq(notificationSendAttempts.applicationId, applicationId),
          isNull(notificationSendAttempts.outcome),
        ),
      )
      .orderBy(notificationSendAttempts.attemptNumber)
      .limit(1);

    return found as SendAttemptRecord | undefined;
  }
}
