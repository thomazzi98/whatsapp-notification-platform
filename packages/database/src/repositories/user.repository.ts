import { type UserRole, type UserStatus } from '@platform/domain';
import { eq, sql } from 'drizzle-orm';

import { type QueryExecutor } from './notification.repository';
import { users } from '../schema';

export interface UserRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly name: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly lastLoginAt: Date | null;
}

export class UserRepository {
  private readonly database: QueryExecutor;

  public constructor(database: QueryExecutor) {
    this.database = database;
  }

  public async insert(input: {
    readonly organizationId: string;
    readonly email: string;
    readonly passwordHash: string;
    readonly name: string;
    readonly role: UserRole;
  }): Promise<UserRecord> {
    const [inserted] = await this.database.insert(users).values(input).returning();

    if (inserted === undefined) {
      throw new Error('Inserting the user returned no row.');
    }
    return inserted as UserRecord;
  }

  /**
   * Email is compared case-insensitively to match the unique index, so a login
   * cannot succeed for one casing and fail for another.
   */
  public async findByEmail(email: string): Promise<UserRecord | undefined> {
    const [found] = await this.database
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);

    return found as UserRecord | undefined;
  }

  public async findById(userId: string): Promise<UserRecord | undefined> {
    const [found] = await this.database.select().from(users).where(eq(users.id, userId)).limit(1);

    return found as UserRecord | undefined;
  }

  public async recordSuccessfulLogin(userId: string, at: Date): Promise<void> {
    await this.database
      .update(users)
      .set({ lastLoginAt: at, failedLoginCount: 0, lockedUntil: null, updatedAt: at })
      .where(eq(users.id, userId));
  }

  /**
   * Increments in the database rather than reading and writing, so concurrent
   * attempts cannot each read the same count and overwrite one another.
   */
  public async recordFailedLogin(userId: string, lockUntil: Date | null): Promise<void> {
    await this.database
      .update(users)
      .set({
        failedLoginCount: sql`${users.failedLoginCount} + 1`,
        lockedUntil: lockUntil,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }
}
