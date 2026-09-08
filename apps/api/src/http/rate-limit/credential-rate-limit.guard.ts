import {
  RateLimitService,
  registrationPolicy,
  type RateLimitPolicy,
  signInPolicy,
} from '@platform/composition';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { type FastifyReply, type FastifyRequest } from 'fastify';

/**
 * Slows down credential guessing, keyed by address.
 *
 * By address rather than by account, because the attack this exists to blunt is
 * one client trying many accounts — a per-account limit answers the opposite
 * problem and hands anyone a way to lock a person out of their own platform by
 * failing their sign-in repeatedly.
 *
 * The account itself is protected separately: repeated failures lock the
 * account, which is a decision the authentication service owns.
 */
abstract class CredentialRateLimitGuard implements CanActivate {
  private readonly rateLimits: RateLimitService;

  protected constructor(rateLimits: RateLimitService) {
    this.rateLimits = rateLimits;
  }

  protected abstract subjectPrefix(): string;

  protected abstract policy(): RateLimitPolicy;

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const outcome = await this.rateLimits.consume(
      `${this.subjectPrefix()}:${request.ip}`,
      this.policy(),
    );
    void reply.header('ratelimit-limit', String(outcome.limit));
    void reply.header('ratelimit-remaining', String(outcome.remainingRequests));

    if (outcome.isAllowed) {
      return true;
    }

    void reply.header('retry-after', String(Math.ceil(outcome.retryAfterSeconds)));
    void reply.status(429);
    void reply.send({
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      // Deliberately says nothing about whether any address exists: an answer
      // that varied would turn the throttle into an account oracle.
      detail: `Too many attempts from this address. Retry in ${String(Math.ceil(outcome.retryAfterSeconds))} seconds.`,
      instance: request.url,
    });

    return false;
  }
}

@Injectable()
export class SignInRateLimitGuard extends CredentialRateLimitGuard {
  public constructor(rateLimits: RateLimitService) {
    super(rateLimits);
  }

  protected subjectPrefix(): string {
    return 'signin';
  }

  protected policy(): RateLimitPolicy {
    return signInPolicy;
  }
}

@Injectable()
export class RegistrationRateLimitGuard extends CredentialRateLimitGuard {
  public constructor(rateLimits: RateLimitService) {
    super(rateLimits);
  }

  protected subjectPrefix(): string {
    return 'register';
  }

  protected policy(): RateLimitPolicy {
    return registrationPolicy;
  }
}
