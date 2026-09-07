import { type ApiKeyScope } from '@platform/domain';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';

import { type Database } from '../connection';
import { apiKeys, applications } from '../schema';

export interface ApiKeyRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly name: string;
  readonly keyIdentifier: string;
  readonly keyPrefix: string;
  readonly lastFour: string;
  readonly scopes: ApiKeyScope[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

/** What authentication needs, including the material to verify the secret. */
export interface ApiKeyAuthenticationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly organizationId: string;
  readonly keyHash: Buffer;
  readonly scopes: ApiKeyScope[];
  readonly applicationStatus: string;
}

export class ApiKeyRepository {
  private readonly database: Database;

  public constructor(database: Database) {
    this.database = database;
  }

  public async insert(input: {
    readonly applicationId: string;
    readonly name: string;
    readonly keyIdentifier: string;
    readonly keyPrefix: string;
    readonly keyHash: Buffer;
    readonly lastFour: string;
    readonly scopes: readonly ApiKeyScope[];
    readonly createdByUserId: string | null;
    readonly expiresAt: Date | null;
  }): Promise<ApiKeyRecord> {
    const [inserted] = await this.database
      .insert(apiKeys)
      .values({ ...input, scopes: [...input.scopes] })
      .returning();

    if (inserted === undefined) {
      throw new Error('Inserting the API key returned no row.');
    }
    return inserted as ApiKeyRecord;
  }

  public async listForApplication(applicationId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.database
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.applicationId, applicationId))
      .orderBy(desc(apiKeys.createdAt));

    return rows as ApiKeyRecord[];
  }

  /**
   * Resolves the public identifier to the row holding the secret's hash.
   *
   * Expiry and revocation are applied here so an unusable key never reaches the
   * verification step, and the join carries the owning organization so the
   * caller does not need a second query to establish the tenant.
   */
  public async findActiveByIdentifier(
    keyIdentifier: string,
    now: Date,
  ): Promise<ApiKeyAuthenticationRecord | undefined> {
    const hasNotExpired = or(isNull(apiKeys.expiresAt), sql`${apiKeys.expiresAt} > ${now}`);

    const [found] = await this.database
      .select({
        id: apiKeys.id,
        applicationId: apiKeys.applicationId,
        organizationId: applications.organizationId,
        keyHash: apiKeys.keyHash,
        scopes: apiKeys.scopes,
        applicationStatus: applications.status,
      })
      .from(apiKeys)
      .innerJoin(applications, eq(applications.id, apiKeys.applicationId))
      .where(
        and(
          eq(apiKeys.keyIdentifier, keyIdentifier),
          isNull(apiKeys.revokedAt),
          isNull(applications.archivedAt),
          hasNotExpired,
        ),
      )
      .limit(1);

    return found as ApiKeyAuthenticationRecord | undefined;
  }

  public async revoke(applicationId: string, apiKeyId: string, now: Date): Promise<boolean> {
    const revoked = await this.database
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(
        and(
          eq(apiKeys.id, apiKeyId),
          eq(apiKeys.applicationId, applicationId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning({ id: apiKeys.id });

    return revoked.length > 0;
  }

  /**
   * Throttled to at most one write per minute per key. Recording usage on every
   * request would turn each authenticated read into a write.
   */
  public async touchLastUsed(apiKeyId: string, now: Date): Promise<void> {
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const isDueForUpdate = or(
      isNull(apiKeys.lastUsedAt),
      sql`${apiKeys.lastUsedAt} < ${oneMinuteAgo}`,
    );

    await this.database
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(and(eq(apiKeys.id, apiKeyId), isDueForUpdate));
  }
}
