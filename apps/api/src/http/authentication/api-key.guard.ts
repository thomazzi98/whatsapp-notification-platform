import { ApiKeyService, LOGGER } from '@platform/composition';
import { type ApiKeyScope, hasScope } from '@platform/domain';
import { enrichCorrelationContext, logEvents } from '@platform/observability';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Logger } from 'pino';

import { type RequestWithApiKey } from './authenticated-request';

export const REQUIRED_SCOPES = 'requiredScopes';

export const RequireScopes = (...scopes: ApiKeyScope[]): MethodDecorator =>
  SetMetadata(REQUIRED_SCOPES, scopes);

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly apiKeys: ApiKeyService;
  private readonly reflector: Reflector;
  private readonly logger: Logger;

  public constructor(apiKeys: ApiKeyService, reflector: Reflector, @Inject(LOGGER) logger: Logger) {
    this.apiKeys = apiKeys;
    this.reflector = reflector;
    this.logger = logger;
  }

  /**
   * A refused key, and why. The caller is told as little as possible on
   * purpose; the platform should not also tell itself nothing.
   */
  private recordRejection(reason: string, request: RequestWithApiKey): void {
    this.logger.warn(
      { event: logEvents.apiKeyRejected, reason, ipAddress: request.ip },
      'An API key was refused',
    );
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithApiKey>();
    const header = request.headers.authorization;

    // Bearer is the only accepted transport. Supporting a second one would
    // double the audit surface for no benefit.
    if (!header?.startsWith(BEARER_PREFIX)) {
      this.recordRejection('missing_bearer_token', request);
      throw new UnauthorizedException('Provide an API key as a bearer token.');
    }

    const principal = await this.apiKeys.authenticate(header.slice(BEARER_PREFIX.length));
    if (principal === undefined) {
      this.recordRejection('unknown_or_inactive_key', request);
      throw new UnauthorizedException('The API key is invalid.');
    }

    const requiredScopes =
      this.reflector.getAllAndOverride<ApiKeyScope[] | undefined>(REQUIRED_SCOPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const missingScopes = requiredScopes.filter((scope) => !hasScope(principal.scopes, scope));
    if (missingScopes.length > 0) {
      this.recordRejection('missing_scope', request);
      throw new ForbiddenException(
        `This API key is missing the required scope: ${missingScopes.join(', ')}.`,
      );
    }

    request.apiKeyPrincipal = principal;
    enrichCorrelationContext({
      applicationId: principal.applicationId,
      apiKeyId: principal.apiKeyId,
    });

    return true;
  }
}
