import { type ProviderSessionStatus } from '@platform/domain';
import { and, eq, sql } from 'drizzle-orm';

import { type Database } from '../connection';
import { whatsAppSessions } from '../schema';

export interface WhatsAppSessionRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly provider: string;
  readonly providerSessionName: string;
  readonly displayName: string;
  readonly status: ProviderSessionStatus;
  readonly phoneNumber: string | null;
  readonly pushName: string | null;
  readonly webhookSigningKeyCiphertext: Buffer;
  readonly sendPacingMinimumSeconds: number;
  readonly sendPacingMaximumSeconds: number;
  readonly nextSendAllowedAt: Date;
  readonly lastStatusAt: Date;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class WhatsAppSessionRepository {
  private readonly database: Database;

  public constructor(database: Database) {
    this.database = database;
  }

  public async insert(input: {
    readonly applicationId: string;
    readonly providerSessionName: string;
    readonly displayName: string;
    readonly webhookSigningKeyCiphertext: Buffer;
  }): Promise<WhatsAppSessionRecord> {
    const [inserted] = await this.database.insert(whatsAppSessions).values(input).returning();

    if (inserted === undefined) {
      throw new Error('Inserting the WhatsApp session returned no row.');
    }
    return inserted as WhatsAppSessionRecord;
  }

  public async listForApplication(applicationId: string): Promise<WhatsAppSessionRecord[]> {
    const rows = await this.database
      .select()
      .from(whatsAppSessions)
      .where(eq(whatsAppSessions.applicationId, applicationId))
      .orderBy(whatsAppSessions.createdAt);

    return rows as WhatsAppSessionRecord[];
  }

  public async findById(
    applicationId: string,
    sessionId: string,
  ): Promise<WhatsAppSessionRecord | undefined> {
    const [found] = await this.database
      .select()
      .from(whatsAppSessions)
      .where(
        and(eq(whatsAppSessions.id, sessionId), eq(whatsAppSessions.applicationId, applicationId)),
      )
      .limit(1);

    return found as WhatsAppSessionRecord | undefined;
  }

  public async findByProviderName(
    providerSessionName: string,
  ): Promise<WhatsAppSessionRecord | undefined> {
    const [found] = await this.database
      .select()
      .from(whatsAppSessions)
      .where(eq(whatsAppSessions.providerSessionName, providerSessionName))
      .limit(1);

    return found as WhatsAppSessionRecord | undefined;
  }

  public async recordStatus(
    sessionId: string,
    input: {
      readonly status: ProviderSessionStatus;
      readonly phoneNumber: string | null;
      readonly pushName: string | null;
      readonly lastError: string | null;
      readonly now: Date;
    },
  ): Promise<void> {
    await this.database
      .update(whatsAppSessions)
      .set({
        status: input.status,
        phoneNumber: input.phoneNumber,
        pushName: input.pushName,
        lastError: input.lastError,
        lastStatusAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(whatsAppSessions.id, sessionId));
  }

  /**
   * Reserves the next send slot for a session, or reports that it is not yet
   * due.
   *
   * The interval is randomised rather than fixed because a metronomic send
   * pattern is exactly the fingerprint automated-messaging detection looks for.
   * Reserving with a conditional update means two workers cannot both claim the
   * same slot.
   */
  public async reserveSendSlot(
    sessionId: string,
    now: Date,
  ): Promise<{ readonly reserved: boolean; readonly nextSendAllowedAt: Date }> {
    const [reserved] = await this.database
      .update(whatsAppSessions)
      .set({
        nextSendAllowedAt: sql`now() + (
          ${whatsAppSessions.sendPacingMinimumSeconds}
          + floor(random() * (
              ${whatsAppSessions.sendPacingMaximumSeconds}
              - ${whatsAppSessions.sendPacingMinimumSeconds} + 1
            ))
        ) * interval '1 second'`,
        updatedAt: now,
      })
      .where(
        and(
          eq(whatsAppSessions.id, sessionId),
          sql`${whatsAppSessions.nextSendAllowedAt} <= ${now}`,
        ),
      )
      .returning({ nextSendAllowedAt: whatsAppSessions.nextSendAllowedAt });

    if (reserved !== undefined) {
      return { reserved: true, nextSendAllowedAt: reserved.nextSendAllowedAt };
    }

    const [current] = await this.database
      .select({ nextSendAllowedAt: whatsAppSessions.nextSendAllowedAt })
      .from(whatsAppSessions)
      .where(eq(whatsAppSessions.id, sessionId))
      .limit(1);

    return { reserved: false, nextSendAllowedAt: current?.nextSendAllowedAt ?? now };
  }
}
