import { ApplicationRepository, type DatabaseConnection } from '@platform/database';
import { type ApplicationRecord } from '@platform/database';
import { CLOCK_PORT, type ClockPort, DomainError } from '@platform/domain';
import { Inject, Injectable } from '@nestjs/common';

import { DATABASE_CONNECTION } from '../tokens';

interface PostgresErrorCause {
  readonly constraint?: string;
}

@Injectable()
export class ApplicationService {
  private readonly applications: ApplicationRepository;
  private readonly clock: ClockPort;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(CLOCK_PORT) clock: ClockPort,
  ) {
    this.applications = new ApplicationRepository(connection.database);
    this.clock = clock;
  }

  public async create(
    organizationId: string,
    input: { readonly name: string; readonly slug: string },
  ): Promise<ApplicationRecord> {
    try {
      return await this.applications.insert({ organizationId, ...input });
    } catch (error: unknown) {
      // Let the database decide, rather than checking first: a check-then-act
      // pair races, while the unique index cannot be beaten.
      const constraint = (error as { cause?: PostgresErrorCause }).cause?.constraint;
      if (constraint === 'applications_organization_slug_unique') {
        throw new DomainError(
          'application_slug_taken',
          'An application with that identifier already exists.',
          { slug: input.slug },
        );
      }
      throw error;
    }
  }

  public async list(organizationId: string): Promise<ApplicationRecord[]> {
    return this.applications.listForOrganization(organizationId);
  }

  /**
   * Throws rather than returning undefined so a caller cannot accidentally
   * continue with no application. The same error is used for an application
   * that belongs to another organization, so the API cannot be used to probe
   * which identifiers exist.
   */
  public async getOrFail(
    organizationId: string,
    applicationId: string,
  ): Promise<ApplicationRecord> {
    const found = await this.applications.findById(organizationId, applicationId);

    if (found === undefined) {
      throw new DomainError('application_not_found', 'That application does not exist.');
    }
    return found;
  }

  public async update(
    organizationId: string,
    applicationId: string,
    input: Parameters<ApplicationRepository['update']>[2],
  ): Promise<ApplicationRecord> {
    const updated = await this.applications.update(organizationId, applicationId, input);

    if (updated === undefined) {
      throw new DomainError('application_not_found', 'That application does not exist.');
    }
    return updated;
  }

  public async archive(organizationId: string, applicationId: string): Promise<void> {
    const wasArchived = await this.applications.archive(
      organizationId,
      applicationId,
      this.clock.now(),
    );

    if (!wasArchived) {
      throw new DomainError('application_not_found', 'That application does not exist.');
    }
  }
}
