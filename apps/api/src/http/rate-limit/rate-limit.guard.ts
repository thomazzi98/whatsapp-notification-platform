import {
  type ApplicationRecord,
  ApplicationService,
  type RateLimitOutcome,
  type RateLimitPolicy,
  RateLimitService,
} from '@platform/composition';
import { type CanActivate, type ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { type FastifyReply } from 'fastify';

import { type RequestWithApiKey } from '../authentication/authenticated-request';

/**
 * The headers every rate-limited response carries, whether or not it was
 * refused.
 *
 * Standard names rather than the `X-RateLimit-` variants, because a client
 * library that already understands them should not have to be told about this
 * platform specifically. They are set on success too: a caller can only pace
 * itself if it can see how much is left before it runs out.
 */
function applyHeaders(reply: FastifyReply, outcome: RateLimitOutcome): void {
  void reply.header('ratelimit-limit', String(outcome.limit));
  void reply.header('ratelimit-remaining', String(outcome.remainingRequests));
  void reply.header('ratelimit-reset', String(Math.ceil(outcome.resetsAfterSeconds)));
}

/**
 * Limits the public API per API key.
 *
 * The subject is the key rather than the application, so one misbehaving
 * integration cannot spend another's allowance, and rather than the IP address,
 * because a server behind a shared egress would otherwise throttle its
 * neighbours.
 *
 * Runs after authentication: an unauthenticated request has no key to charge,
 * and rejecting it is cheaper than metering it.
 */
@Injectable()
export class ApiKeyRateLimitGuard implements CanActivate {
  private readonly rateLimits: RateLimitService;
  private readonly applications: ApplicationService;

  public constructor(rateLimits: RateLimitService, applications: ApplicationService) {
    this.rateLimits = rateLimits;
    this.applications = applications;
  }

  /**
   * The allowance is a property of the application, so an operator can raise it
   * for one tenant without redeploying.
   */
  private async readPolicy(
    organizationId: string,
    applicationId: string,
  ): Promise<RateLimitPolicy> {
    const application: ApplicationRecord = await this.applications.getOrFail(
      organizationId,
      applicationId,
    );

    return {
      requestsPerPeriod: application.rateLimitPerMinute,
      burstAllowance: application.rateLimitBurst,
      periodSeconds: 60,
    };
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithApiKey>();
    const reply = http.getResponse<FastifyReply>();
    const principal = request.apiKeyPrincipal;

    if (principal === undefined) {
      return true;
    }

    const policy = await this.readPolicy(principal.organizationId, principal.applicationId);
    const outcome = await this.rateLimits.consume(`apikey:${principal.apiKeyId}`, policy);
    applyHeaders(reply, outcome);

    if (outcome.isAllowed) {
      return true;
    }

    // Retry-After as well as the RateLimit headers: the first is what a generic
    // HTTP client already knows how to obey. Set before throwing, because the
    // headers already on the reply survive into the filter's response.
    void reply.header('retry-after', String(Math.ceil(outcome.retryAfterSeconds)));

    // Thrown rather than sent, so this answer goes out as problem+json with the
    // same type URL and correlation id as every other error. Written by hand it
    // was the one response that contradicted the document's own claim that every
    // error shares one shape.
    throw new HttpException(
      {
        error: 'Too Many Requests',
        message: `This API key is limited to ${String(outcome.limit)} requests per minute. Retry in ${String(Math.ceil(outcome.retryAfterSeconds))} seconds.`,
      },
      429,
    );
  }
}
