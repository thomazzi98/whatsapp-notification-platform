import { type ApplicationConfiguration } from '@platform/configuration';
import {
  APPLICATION_CONFIGURATION,
  type AuthenticatedPrincipal,
  AuthenticationService,
  type EstablishedSession,
} from '@platform/composition';
import {
  type LoginRequest,
  loginRequestSchema,
  type RegisterRequest,
  registerRequestSchema,
} from '@platform/contracts';
import { logEvents } from '@platform/observability';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Res,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { type FastifyReply } from 'fastify';

import { CurrentUser } from '../../http/authentication/authenticated-request';
import { deriveCsrfToken } from '../../http/authentication/csrf';
import { DashboardSessionGuard } from '../../http/authentication/dashboard-session.guard';
import { ZodValidationPipe } from '../../http/validation/zod-validation.pipe';

interface SessionResponse {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly role: string;
    readonly organizationId: string;
  };
  readonly csrfToken: string;
}

@Controller('dashboard/auth')
export class AuthenticationController {
  private readonly authentication: AuthenticationService;
  private readonly configuration: ApplicationConfiguration;

  public constructor(
    authentication: AuthenticationService,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
  ) {
    this.authentication = authentication;
    this.configuration = configuration;
  }

  private toSessionResponse(principal: AuthenticatedPrincipal): SessionResponse {
    return {
      user: {
        id: principal.userId,
        email: principal.email,
        name: principal.name,
        role: principal.role,
        organizationId: principal.organizationId,
      },
      csrfToken: deriveCsrfToken(principal.sessionId, this.configuration.security.apiKeyPepper),
    };
  }

  private setSessionCookie(reply: FastifyReply, session: EstablishedSession): void {
    void reply.setCookie(this.configuration.security.sessionCookieName, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.configuration.security.cookieSecure,
      path: '/',
      expires: session.expiresAt,
    });
  }

  @Post('register')
  @UsePipes(new ZodValidationPipe(registerRequestSchema))
  public async register(
    @Body() body: RegisterRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const session = await this.authentication.register(body);
    this.setSessionCookie(reply, session);

    return this.toSessionResponse(session.principal);
  }

  @Post('login')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(loginRequestSchema))
  public async login(
    @Body() body: LoginRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const session = await this.authentication.login({
      email: body.email,
      password: body.password,
      ipAddress: reply.request.ip,
      userAgent: reply.request.headers['user-agent'] ?? null,
    });
    this.setSessionCookie(reply, session);
    reply.log.info({ event: logEvents.authenticationSucceeded }, 'Signed in');

    return this.toSessionResponse(session.principal);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(DashboardSessionGuard)
  public async logout(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.authentication.logout(principal.sessionId);
    void reply.clearCookie(this.configuration.security.sessionCookieName, { path: '/' });
  }

  @Get('session')
  @UseGuards(DashboardSessionGuard)
  public session(@CurrentUser() principal: AuthenticatedPrincipal): SessionResponse {
    return this.toSessionResponse(principal);
  }
}
