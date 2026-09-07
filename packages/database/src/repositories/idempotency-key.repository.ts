import { and, eq, lt, sql } from 'drizzle-orm';

import { type Database } from '../connection';
import { idempotencyKeys } from '../schema';
import { type QueryExecutor } from './notification.repository';

export interface IdempotencyClaimInput {
  readonly applicationId: string;
  readonly key: string;
  readonly requestMethod: string;
  readonly requestPath: string;
  readonly requestFingerprint: Buffer;
  readonly lockToken: string;
  readonly expiresAt: Date;
}

export interface IdempotencyRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly key: string;
  readonly requestFingerprint: Buffer;
  readonly state: 'IN_FLIGHT' | 'COMPLETED';
  readonly lockToken: string;
  readonly responseStatus: number | null;
  readonly responseBody: Record<string, unknown> | null;
  readonly resourceId: string | null;
  readonly createdAt: Date;
}

export type IdempotencyClaim =
  | { readonly outcome: 'claimed'; readonly id: string; readonly lockToken: string }
  | { readonly outcome: 'exists'; readonly record: IdempotencyRecord };

export class IdempotencyKeyRepository {
  private readonly database: Database;

  public constructor(database: Database) {
    this.database = database;
  }

  /**
   * Claims the key, or reports the record that already holds it.
   *
   * `ON CONFLICT DO NOTHING` takes a speculative insertion lock, so a
   * concurrent request for the same key blocks until this transaction commits
   * or aborts and then observes the correct outcome. That is what makes two
   * simultaneous retries of the same request safe without an advisory lock.
   */
  public async claim(
    executor: QueryExecutor,
    input: IdempotencyClaimInput,
  ): Promise<IdempotencyClaim> {
    const [inserted] = await executor
      .insert(idempotencyKeys)
      .values({ ...input, state: 'IN_FLIGHT' })
      .onConflictDoNothing({ target: [idempotencyKeys.applicationId, idempotencyKeys.key] })
      .returning({ id: idempotencyKeys.id, lockToken: idempotencyKeys.lockToken });

    if (inserted !== undefined) {
      return { outcome: 'claimed', id: inserted.id, lockToken: inserted.lockToken };
    }

    const [existing] = await executor
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.applicationId, input.applicationId),
          eq(idempotencyKeys.key, input.key),
        ),
      )
      .limit(1);

    if (existing === undefined) {
      // The row was deleted between the insert and the read — the expiry reaper
      // is the only thing that does that. Treating it as claimable lets the
      // caller retry rather than fail on a race with maintenance.
      return { outcome: 'claimed', id: input.lockToken, lockToken: input.lockToken };
    }

    return { outcome: 'exists', record: existing as IdempotencyRecord };
  }

  public async complete(
    executor: QueryExecutor,
    input: {
      readonly id: string;
      readonly lockToken: string;
      readonly responseStatus: number;
      readonly responseBody: Record<string, unknown>;
      readonly resourceId: string | null;
      readonly now: Date;
    },
  ): Promise<void> {
    await executor
      .update(idempotencyKeys)
      .set({
        state: 'COMPLETED',
        responseStatus: input.responseStatus,
        responseBody: input.responseBody,
        resourceId: input.resourceId,
        completedAt: input.now,
      })
      .where(and(eq(idempotencyKeys.id, input.id), eq(idempotencyKeys.lockToken, input.lockToken)));
  }

  /**
   * Takes over a claim abandoned by a process that died mid-request. Guarded by
   * the observed lock token, so only one instance can win the takeover.
   */
  public async takeOverStaleClaim(
    id: string,
    observedLockToken: string,
    newLockToken: string,
    now: Date,
  ): Promise<boolean> {
    const taken = await this.database
      .update(idempotencyKeys)
      .set({ lockToken: newLockToken, createdAt: now })
      .where(
        and(
          eq(idempotencyKeys.id, id),
          eq(idempotencyKeys.lockToken, observedLockToken),
          eq(idempotencyKeys.state, 'IN_FLIGHT'),
        ),
      )
      .returning({ id: idempotencyKeys.id });

    return taken.length > 0;
  }

  public async deleteExpired(now: Date, batchSize: number): Promise<number> {
    const deleted = await this.database
      .delete(idempotencyKeys)
      .where(
        sql`${idempotencyKeys.id} in (
          select id from ${idempotencyKeys} where ${lt(idempotencyKeys.expiresAt, now)}
          limit ${batchSize}
        )`,
      )
      .returning({ id: idempotencyKeys.id });

    return deleted.length;
  }
}
