import { type ApiKeyPrincipal, ApplicationService } from '@platform/composition';
import { Controller, Get, UseGuards } from '@nestjs/common';

import { ApiKeyGuard, RequireScopes } from '../../http/authentication/api-key.guard';
import { ApiKeyRateLimitGuard } from '../../http/rate-limit/rate-limit.guard';
import { CurrentApiKey } from '../../http/authentication/authenticated-request';

interface CurrentApplicationResponse {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly scopes: readonly string[];
}

/**
 * Lets an integrator confirm which application a key belongs to and what it is
 * allowed to do, without having to send a real notification to find out.
 */
@Controller('v1/applications')
@UseGuards(ApiKeyGuard, ApiKeyRateLimitGuard)
export class CurrentApplicationController {
  private readonly applications: ApplicationService;

  public constructor(applications: ApplicationService) {
    this.applications = applications;
  }

  @Get('current')
  @RequireScopes('notifications:read')
  public async current(
    @CurrentApiKey() principal: ApiKeyPrincipal,
  ): Promise<CurrentApplicationResponse> {
    const application = await this.applications.getOrFail(
      principal.organizationId,
      principal.applicationId,
    );

    return {
      id: application.id,
      name: application.name,
      slug: application.slug,
      status: application.status,
      scopes: principal.scopes,
    };
  }
}
