import { type ApplicationConfiguration } from '@platform/configuration';
import { APPLICATION_CONFIGURATION, AuthenticationService } from '@platform/composition';
import { enrichCorrelationContext } from '@platform/observability';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { isCsrfTokenValid, deriveCsrfToken } from './csrf';
import { type RequestWithSession } from './authenticated-request';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class DashboardSessionGuard implements CanActivate {
  private readonly authentication: AuthenticationService;
  private readonly configuration: ApplicationConfiguration;

  public constructor(
    authentication: AuthenticationService,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
  ) {
    this.authentication = authentication;
    this.configuration = configuration;
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const token = request.cookies?.[this.configuration.security.sessionCookieName];

    if (token === undefined || token.length === 0) {
      throw new UnauthorizedException('Sign in to continue.');
    }

    const principal = await this.authentication.resolveSession(token);
    if (principal === undefined) {
      throw new UnauthorizedException('Your session has expired. Sign in again.');
    }

    // A double submit token on top of SameSite=Lax. The cookie alone is enough
    // for a cross-site form post to be blocked by a modern browser; requiring a
    // header the attacker's page cannot read covers older ones and any future
    // relaxation of the cookie policy.
    if (!SAFE_METHODS.has(request.method)) {
      const header = request.headers['x-csrf-token'];
      const supplied = Array.isArray(header) ? header[0] : header;
      const expected = deriveCsrfToken(
        principal.sessionId,
        this.configuration.security.apiKeyPepper,
      );

      if (supplied === undefined || !isCsrfTokenValid(supplied, expected)) {
        throw new ForbiddenException('The request is missing a valid CSRF token.');
      }
    }

    request.principal = principal;
    enrichCorrelationContext({ userId: principal.userId });

    return true;
  }
}
