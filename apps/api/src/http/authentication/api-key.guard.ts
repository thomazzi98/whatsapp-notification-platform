import { ApiKeyService } from '@platform/composition';
import { type ApiKeyScope, hasScope } from '@platform/domain';
import { enrichCorrelationContext } from '@platform/observability';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { type RequestWithApiKey } from './authenticated-request';

export const REQUIRED_SCOPES = 'requiredScopes';

export const RequireScopes = (...scopes: ApiKeyScope[]): MethodDecorator =>
  SetMetadata(REQUIRED_SCOPES, scopes);

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly apiKeys: ApiKeyService;
  private readonly reflector: Reflector;

  public constructor(apiKeys: ApiKeyService, reflector: Reflector) {
    this.apiKeys = apiKeys;
    this.reflector = reflector;
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithApiKey>();
    const header = request.headers.authorization;

    // Bearer is the only accepted transport. Supporting a second one would
    // double the audit surface for no benefit.
    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Provide an API key as a bearer token.');
    }

    const principal = await this.apiKeys.authenticate(header.slice(BEARER_PREFIX.length));
    if (principal === undefined) {
      throw new UnauthorizedException('The API key is invalid.');
    }

    const requiredScopes =
      this.reflector.getAllAndOverride<ApiKeyScope[] | undefined>(REQUIRED_SCOPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const missingScopes = requiredScopes.filter((scope) => !hasScope(principal.scopes, scope));
    if (missingScopes.length > 0) {
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
