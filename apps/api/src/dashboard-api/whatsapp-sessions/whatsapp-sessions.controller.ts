import {
  ApplicationService,
  type AuthenticatedPrincipal,
  type WhatsAppSessionRecord,
  WhatsAppSessionService,
} from '@platform/composition';
import {
  type QrCodeResponse,
  type WhatsAppSessionCreationRequest,
  whatsAppSessionCreationRequestSchema,
  type WhatsAppSessionResponse,
} from '@platform/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../http/authentication/authenticated-request';
import { DashboardSessionGuard } from '../../http/authentication/dashboard-session.guard';
import { ZodValidationPipe } from '../../http/validation/zod-validation.pipe';
import { UuidParameterPipe } from '../../http/validation/uuid-parameter.pipe';

function toResponse(record: WhatsAppSessionRecord): WhatsAppSessionResponse {
  return {
    id: record.id,
    displayName: record.displayName,
    status: record.status,
    phoneNumber: record.phoneNumber,
    pushName: record.pushName,
    lastError: record.lastError,
    lastStatusAt: record.lastStatusAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * Connecting WhatsApp is deliberately absent from the API-key surface.
 *
 * Pairing needs a person holding a phone in front of a screen, so exposing it
 * to a machine credential would offer a workflow that cannot complete. It lives
 * on the dashboard, behind a session cookie, where the human already is.
 */
@Controller('dashboard/applications/:applicationId/whatsapp-sessions')
@UseGuards(DashboardSessionGuard)
export class WhatsAppSessionsController {
  private readonly sessions: WhatsAppSessionService;
  private readonly applications: ApplicationService;

  public constructor(sessions: WhatsAppSessionService, applications: ApplicationService) {
    this.sessions = sessions;
    this.applications = applications;
  }

  /**
   * Establishing the application under the caller's organization first is what
   * stops a connection being read or driven across tenants.
   */
  private async authorize(principal: AuthenticatedPrincipal, applicationId: string): Promise<void> {
    await this.applications.getOrFail(principal.organizationId, applicationId);
  }

  @Get()
  public async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
  ): Promise<{ data: WhatsAppSessionResponse[] }> {
    await this.authorize(principal, applicationId);
    const records = await this.sessions.list(applicationId);

    return { data: records.map((record) => toResponse(record)) };
  }

  @Post()
  @HttpCode(201)
  public async create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Body(new ZodValidationPipe(whatsAppSessionCreationRequestSchema))
    body: WhatsAppSessionCreationRequest,
  ): Promise<WhatsAppSessionResponse> {
    await this.authorize(principal, applicationId);
    const record = await this.sessions.create({ applicationId, displayName: body.displayName });

    return toResponse(record);
  }

  @Get(':whatsAppSessionId')
  public async get(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Param('whatsAppSessionId', new UuidParameterPipe('whatsAppSessionId'))
    whatsAppSessionId: string,
  ): Promise<WhatsAppSessionResponse> {
    await this.authorize(principal, applicationId);

    return toResponse(await this.sessions.get(applicationId, whatsAppSessionId));
  }

  /**
   * Every request returns the code the provider is offering right now.
   *
   * Codes expire in under a minute and the provider issues a limited number
   * before the connection fails, so this must never be served from a cache: a
   * stale image is a code that cannot work and an attempt spent for nothing.
   */
  @Get(':whatsAppSessionId/qr-code')
  public async getQrCode(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Param('whatsAppSessionId', new UuidParameterPipe('whatsAppSessionId'))
    whatsAppSessionId: string,
  ): Promise<QrCodeResponse> {
    await this.authorize(principal, applicationId);
    const code = await this.sessions.getQrCode(applicationId, whatsAppSessionId);

    return { mimeType: code.mimeType, data: code.data };
  }

  @Post(':whatsAppSessionId/start')
  @HttpCode(200)
  public async start(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Param('whatsAppSessionId', new UuidParameterPipe('whatsAppSessionId'))
    whatsAppSessionId: string,
  ): Promise<WhatsAppSessionResponse> {
    await this.authorize(principal, applicationId);

    return toResponse(await this.sessions.start(applicationId, whatsAppSessionId));
  }

  @Post(':whatsAppSessionId/stop')
  @HttpCode(200)
  public async stop(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Param('whatsAppSessionId', new UuidParameterPipe('whatsAppSessionId'))
    whatsAppSessionId: string,
  ): Promise<WhatsAppSessionResponse> {
    await this.authorize(principal, applicationId);

    return toResponse(await this.sessions.stop(applicationId, whatsAppSessionId));
  }

  /**
   * Unpairs the WhatsApp account. Separate from stopping on purpose: this one
   * cannot be undone without somebody scanning a new code.
   */
  @Post(':whatsAppSessionId/logout')
  @HttpCode(200)
  public async logout(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Param('whatsAppSessionId', new UuidParameterPipe('whatsAppSessionId'))
    whatsAppSessionId: string,
  ): Promise<WhatsAppSessionResponse> {
    await this.authorize(principal, applicationId);

    return toResponse(await this.sessions.logout(applicationId, whatsAppSessionId));
  }

  @Delete(':whatsAppSessionId')
  @HttpCode(204)
  public async remove(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('applicationId', new UuidParameterPipe('applicationId')) applicationId: string,
    @Param('whatsAppSessionId', new UuidParameterPipe('whatsAppSessionId'))
    whatsAppSessionId: string,
  ): Promise<void> {
    await this.authorize(principal, applicationId);
    await this.sessions.delete(applicationId, whatsAppSessionId);
  }
}
