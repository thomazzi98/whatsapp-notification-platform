import {
  type ApiKeyRecord,
  ApiKeyService,
  ApplicationService,
  type AuthenticatedPrincipal,
} from '@platform/composition';
import {
  type ApiKeyResponse,
  type ApiKeyCreationRequest,
  apiKeyCreationRequestSchema,
  type ApiKeyCreationResponse,
} from '@platform/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../http/authentication/authenticated-request';
import { DashboardSessionGuard } from '../../http/authentication/dashboard-session.guard';
import { ZodValidationPipe } from '../../http/validation/zod-validation.pipe';
import { UuidParameterPipe } from '../../http/validation/uuid-parameter.pipe';

function toResponse(record: ApiKeyRecord): ApiKeyResponse {
  return {
    id: record.id,
    name: record.name,
    displayPrefix: record.keyPrefix,
    lastFour: record.lastFour,
    scopes: record.scopes,
    createdAt: record.createdAt.toISOString(),
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
  };
}

@Controller('dashboard/applications/:applicationId/api-keys')
@UseGuards(DashboardSessionGuard)
export class ApiKeysController {
  private readonly apiKeys: ApiKeyService;
  private readonly applications: ApplicationService;

  public constructor(apiKeys: ApiKeyService, applications: ApplicationService) {
    this.apiKeys = apiKeys;
    this.applications = applications;
  }

  @Get()
  public async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
  ): Promise<{ data: ApiKeyResponse[] }> {
    // Establishing the application under the caller's organization first is
    // what stops a key list being read across tenants.
    await this.applications.getOrFail(principal.organizationId, applicationId);
    const records = await this.apiKeys.list(applicationId);

    return { data: records.map((record) => toResponse(record)) };
  }

  @Post()
  public async create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Body(new ZodValidationPipe(apiKeyCreationRequestSchema)) body: ApiKeyCreationRequest,
  ): Promise<ApiKeyCreationResponse> {
    await this.applications.getOrFail(principal.organizationId, applicationId);

    const created = await this.apiKeys.create({
      applicationId,
      name: body.name,
      scopes: body.scopes,
      createdByUserId: principal.userId,
      expiresAt:
        body.expiresAt === undefined || body.expiresAt === null ? null : new Date(body.expiresAt),
    });

    // The only response in the platform that carries a usable credential. It is
    // returned once and is not recoverable afterwards.
    return { ...toResponse(created.record), plaintextKey: created.plaintextKey };
  }

  @Delete(':apiKeyId')
  @HttpCode(204)
  public async revoke(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Param('apiKeyId', new UuidParameterPipe('apiKeyId')) apiKeyId: string,
  ): Promise<void> {
    await this.applications.getOrFail(principal.organizationId, applicationId);
    await this.apiKeys.revoke(applicationId, apiKeyId);
  }
}
