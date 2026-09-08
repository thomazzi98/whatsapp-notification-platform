import { type UserRole } from '@platform/domain';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { type QueryExecutor } from './notification.repository';
import { organizations, userSessions, users } from '../schema';

export interface SessionWithUser {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
  readonly status: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export class UserSessionRepository {
  private readonly database: QueryExecutor;

  public constructor(database: QueryExecutor) {
    this.database = database;
  }

  public async insert(input: {
    readonly userId: string;
    readonly tokenHash: Buffer;
    readonly absoluteExpiresAt: Date;
    readonly idleExpiresAt: Date;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  }): Promise<string> {
    const [inserted] = await this.database.insert(userSessions).values(input).returning({
      id: userSessions.id,
    });

    if (inserted === undefined) {
      throw new Error('Inserting the session returned no row.');
    }
    return inserted.id;
  }

  /**
   * Resolves a session token to its user in one indexed lookup.
   *
   * Both expiry bounds are applied in the query rather than in application
   * code: an expired session must be invisible even to a code path that forgets
   * to check, and the revoked filter matches the partial index.
   */
  public async findActiveByTokenHash(
    tokenHash: Buffer,
    now: Date,
  ): Promise<SessionWithUser | undefined> {
    const [found] = await this.database
      .select({
        sessionId: userSessions.id,
        userId: users.id,
        organizationId: users.organizationId,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
        email: users.email,
        name: users.name,
        role: users.role,
        status: users.status,
        idleExpiresAt: userSessions.idleExpiresAt,
        absoluteExpiresAt: userSessions.absoluteExpiresAt,
      })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      // Joined rather than fetched separately: the dashboard shows which
      // organization a session belongs to on every screen, and a second round
      // trip for two columns on the hot authentication path is not worth it.
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(
        and(
          eq(userSessions.tokenHash, tokenHash),
          isNull(userSessions.revokedAt),
          gt(userSessions.idleExpiresAt, now),
          gt(userSessions.absoluteExpiresAt, now),
        ),
      )
      .limit(1);

    // The role column is constrained to the domain's roles by a database check,
    // which the query builder's `text` type cannot express.
    return found as SessionWithUser | undefined;
  }

  /**
   * The idle window slides on use, but the absolute expiry never moves, so a
   * stolen session cannot be kept alive indefinitely by using it.
   */
  public async touch(sessionId: string, idleExpiresAt: Date, now: Date): Promise<void> {
    await this.database
      .update(userSessions)
      .set({ idleExpiresAt, lastUsedAt: now })
      .where(eq(userSessions.id, sessionId));
  }

  public async revoke(sessionId: string, now: Date): Promise<void> {
    await this.database
      .update(userSessions)
      .set({ revokedAt: now })
      .where(and(eq(userSessions.id, sessionId), isNull(userSessions.revokedAt)));
  }

  public async revokeAllForUser(userId: string, now: Date): Promise<number> {
    const revoked = await this.database
      .update(userSessions)
      .set({ revokedAt: now })
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
      .returning({ id: userSessions.id });

    return revoked.length;
  }

  public async deleteExpired(now: Date): Promise<number> {
    const deleted = await this.database
      .delete(userSessions)
      .where(sql`${userSessions.absoluteExpiresAt} < ${now}`)
      .returning({ id: userSessions.id });

    return deleted.length;
  }
}
