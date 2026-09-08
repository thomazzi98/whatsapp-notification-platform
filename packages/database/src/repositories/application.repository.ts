import { type ApplicationStatus } from '@platform/domain';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { type Database } from '../connection';
import { applications } from '../schema';

export interface ApplicationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: ApplicationStatus;
  readonly rateLimitPerMinute: number;
  readonly rateLimitBurst: number;
  readonly dailySendLimit: number | null;
  readonly defaultMaximumAttempts: number;
  readonly unknownOutcomePolicy: 'RETRY' | 'FAIL_CLOSED';
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DeliverySettings {
  readonly status: ApplicationStatus;
  readonly defaultMaximumAttempts: number;
  readonly unknownOutcomePolicy: 'RETRY' | 'FAIL_CLOSED';
}

export interface UpdateApplicationInput {
  readonly name?: string;
  readonly rateLimitPerMinute?: number;
  readonly rateLimitBurst?: number;
  readonly dailySendLimit?: number | null;
  readonly defaultMaximumAttempts?: number;
  readonly unknownOutcomePolicy?: 'RETRY' | 'FAIL_CLOSED';
}

/**
 * Every method takes the organization identifier.
 *
 * Making the tenant part of the signature rather than an optional filter means
 * a cross-tenant read cannot be written by forgetting a where clause; it has to
 * be written deliberately.
 */
export class ApplicationRepository {
  private readonly database: Database;

  public constructor(database: Database) {
    this.database = database;
  }

  public async insert(input: {
    readonly organizationId: string;
    readonly name: string;
    readonly slug: string;
  }): Promise<ApplicationRecord> {
    const [inserted] = await this.database.insert(applications).values(input).returning();

    if (inserted === undefined) {
      throw new Error('Inserting the application returned no row.');
    }
    return inserted as ApplicationRecord;
  }

  public async listForOrganization(organizationId: string): Promise<ApplicationRecord[]> {
    const rows = await this.database
      .select()
      .from(applications)
      .where(and(eq(applications.organizationId, organizationId), isNull(applications.archivedAt)))
      .orderBy(desc(applications.createdAt));

    return rows as ApplicationRecord[];
  }

  public async findById(
    organizationId: string,
    applicationId: string,
  ): Promise<ApplicationRecord | undefined> {
    const [found] = await this.database
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.id, applicationId),
          eq(applications.organizationId, organizationId),
          isNull(applications.archivedAt),
        ),
      )
      .limit(1);

    return found as ApplicationRecord | undefined;
  }

  /**
   * Reads the settings the delivery pipeline needs, keyed only by application.
   *
   * The worker is reached through a job, not a request, so it has no
   * organization in hand and nothing to scope by. Returning a narrow projection
   * rather than the whole record keeps the tenant-scoped signature the rule for
   * everything a user can actually reach.
   */
  public async findDeliverySettings(applicationId: string): Promise<DeliverySettings | undefined> {
    const [found] = await this.database
      .select({
        status: applications.status,
        defaultMaximumAttempts: applications.defaultMaximumAttempts,
        unknownOutcomePolicy: applications.unknownOutcomePolicy,
      })
      .from(applications)
      .where(and(eq(applications.id, applicationId), isNull(applications.archivedAt)))
      .limit(1);

    return found as DeliverySettings | undefined;
  }

  public async update(
    organizationId: string,
    applicationId: string,
    input: UpdateApplicationInput,
  ): Promise<ApplicationRecord | undefined> {
    const [updated] = await this.database
      .update(applications)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(
          eq(applications.id, applicationId),
          eq(applications.organizationId, organizationId),
          isNull(applications.archivedAt),
        ),
      )
      .returning();

    return updated as ApplicationRecord | undefined;
  }

  public async archive(organizationId: string, applicationId: string, now: Date): Promise<boolean> {
    const archived = await this.database
      .update(applications)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(applications.id, applicationId),
          eq(applications.organizationId, organizationId),
          isNull(applications.archivedAt),
        ),
      )
      .returning({ id: applications.id });

    return archived.length > 0;
  }
}
