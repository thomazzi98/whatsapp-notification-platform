import { eq } from 'drizzle-orm';

import { type QueryExecutor } from './notification.repository';
import { organizations } from '../schema';

export interface OrganizationRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
}

export class OrganizationRepository {
  private readonly database: QueryExecutor;

  public constructor(database: QueryExecutor) {
    this.database = database;
  }

  public async insert(input: {
    readonly name: string;
    readonly slug: string;
  }): Promise<OrganizationRecord> {
    const [inserted] = await this.database
      .insert(organizations)
      .values({ name: input.name, slug: input.slug })
      .returning();

    if (inserted === undefined) {
      throw new Error('Inserting the organization returned no row.');
    }
    return inserted;
  }

  public async findById(organizationId: string): Promise<OrganizationRecord | undefined> {
    const [found] = await this.database
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    return found;
  }
}
