import { and, eq, sql } from 'drizzle-orm';

import { type Database } from '../connection';
import { webhookDeliveries } from '../schema';
import { type QueryExecutor } from './notification.repository';

export const webhookOutcomes = ['APPLIED', 'IGNORED', 'UNMATCHED'] as const;

export type WebhookOutcome = (typeof webhookOutcomes)[number];

export interface WebhookDeliveryRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly whatsAppSessionId: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly providerSessionName: string;
  readonly payload: Record<string, unknown>;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly processingAttempts: number;
  readonly outcome: WebhookOutcome | null;
  readonly outcomeDetail: string | null;
}

export interface RecordWebhookDeliveryInput {
  readonly id: string;
  readonly applicationId: string;
  readonly whatsAppSessionId: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly providerSessionName: string;
  readonly payload: Record<string, unknown>;
  readonly receivedAt: Date;
}

export class WebhookDeliveryRepository {
  private readonly database: Database;

  public constructor(database: Database) {
    this.database = database;
  }

  /**
   * Records a callback, or reports that this one has already been seen.
   *
   * Providers redeliver on any non-2xx and sometimes on a slow one, so the same
   * acknowledgement arriving twice is ordinary traffic rather than an error.
   * The conflict is resolved by the database instead of by a read followed by a
   * write, which would race with a concurrent redelivery.
   */
  public async record(
    executor: QueryExecutor,
    input: RecordWebhookDeliveryInput,
  ): Promise<WebhookDeliveryRecord | undefined> {
    const [inserted] = await executor
      .insert(webhookDeliveries)
      .values(input)
      .onConflictDoNothing({
        target: [webhookDeliveries.whatsAppSessionId, webhookDeliveries.providerEventId],
      })
      .returning();

    return inserted as WebhookDeliveryRecord | undefined;
  }

  public async findById(deliveryId: string): Promise<WebhookDeliveryRecord | undefined> {
    const [found] = await this.database
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);

    return found as WebhookDeliveryRecord | undefined;
  }

  /**
   * Claims the delivery for processing, counting the attempt.
   *
   * Returning no row means it has already been resolved — the job was
   * redelivered after the handler finished but before the queue recorded that.
   */
  public async claimForProcessing(deliveryId: string): Promise<WebhookDeliveryRecord | undefined> {
    const [claimed] = await this.database
      .update(webhookDeliveries)
      .set({ processingAttempts: sql`${webhookDeliveries.processingAttempts} + 1` })
      .where(
        and(eq(webhookDeliveries.id, deliveryId), sql`${webhookDeliveries.processedAt} is null`),
      )
      .returning();

    return claimed as WebhookDeliveryRecord | undefined;
  }

  public async markProcessed(input: {
    readonly deliveryId: string;
    readonly outcome: WebhookOutcome;
    readonly detail: string | null;
    readonly now: Date;
  }): Promise<void> {
    await this.database
      .update(webhookDeliveries)
      .set({
        processedAt: input.now,
        outcome: input.outcome,
        outcomeDetail: input.detail,
      })
      .where(eq(webhookDeliveries.id, input.deliveryId));
  }
}
