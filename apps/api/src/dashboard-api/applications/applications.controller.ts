import {
  type ApplicationRecord,
  ApplicationService,
  type AuthenticatedPrincipal,
} from '@platform/composition';
import {
  type ApplicationResponse,
  type ApplicationCreationRequest,
  applicationCreationRequestSchema,
  type UpdateApplicationRequest,
  updateApplicationRequestSchema,
} from '@platform/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../../http/authentication/authenticated-request';
import { DashboardSessionGuard } from '../../http/authentication/dashboard-session.guard';
import { ZodValidationPipe } from '../../http/validation/zod-validation.pipe';
import { UuidParameterPipe } from '../../http/validation/uuid-parameter.pipe';

function toResponse(record: ApplicationRecord): ApplicationResponse {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    status: record.status,
    rateLimitPerMinute: record.rateLimitPerMinute,
    rateLimitBurst: record.rateLimitBurst,
    dailySendLimit: record.dailySendLimit,
    defaultMaximumAttempts: record.defaultMaximumAttempts,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

@Controller('dashboard/applications')
@UseGuards(DashboardSessionGuard)
export class ApplicationsController {
  private readonly applications: ApplicationService;

  public constructor(applications: ApplicationService) {
    this.applications = applications;
  }

  @Get()
  public async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<{ data: ApplicationResponse[] }> {
    const records = await this.applications.list(principal.organizationId);

    return { data: records.map((record) => toResponse(record)) };
  }

  @Post()
  public async create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(applicationCreationRequestSchema)) body: ApplicationCreationRequest,
  ): Promise<ApplicationResponse> {
    const record = await this.applications.create(principal.organizationId, body);

    return toResponse(record);
  }

  @Get(':applicationId')
  public async get(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
  ): Promise<ApplicationResponse> {
    // Scoped by organization, so an application belonging to another tenant is
    // reported as not found rather than forbidden — the API must not confirm
    // that an identifier exists.
    const record = await this.applications.getOrFail(principal.organizationId, applicationId);

    return toResponse(record);
  }

  @Patch(':applicationId')
  public async update(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Body(new ZodValidationPipe(updateApplicationRequestSchema)) body: UpdateApplicationRequest,
  ): Promise<ApplicationResponse> {
    const record = await this.applications.update(principal.organizationId, applicationId, body);

    return toResponse(record);
  }

  @Delete(':applicationId')
  @HttpCode(204)
  public async archive(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
  ): Promise<void> {
    await this.applications.archive(principal.organizationId, applicationId);
  }
}
