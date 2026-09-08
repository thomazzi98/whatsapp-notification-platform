import {
  type DatabaseConnection,
  type RateLimitDecision,
  type RateLimitPolicy,
  RateLimitRepository,
} from '@platform/database';
import { CLOCK_PORT, type ClockPort } from '@platform/domain';
import { logEvents } from '@platform/observability';
import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';

import { DATABASE_CONNECTION, LOGGER } from '../tokens';

export interface RateLimitOutcome extends RateLimitDecision {
  readonly limit: number;
  /**
   * True when the limiter could not reach the database and let the request
   * through anyway. The request is served; the fact that it was unmetered is
   * not hidden.
   */
  readonly wasDegraded: boolean;
}

/** Requests a person may make against sign-in before being slowed down. */
export const signInPolicy: RateLimitPolicy = {
  requestsPerPeriod: 10,
  burstAllowance: 5,
  periodSeconds: 60,
};

@Injectable()
export class RateLimitService {
  private readonly buckets: RateLimitRepository;
  private readonly clock: ClockPort;
  private readonly logger: Logger;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(CLOCK_PORT) clock: ClockPort,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.buckets = new RateLimitRepository(connection.database);
    this.clock = clock;
    this.logger = logger;
  }

  /**
   * Decides whether one request may proceed.
   *
   * It fails open. A database hiccup taking the whole API offline is a worse
   * outcome than briefly serving traffic that should have been throttled — for
   * a self-hosted product whose operator is also its only user, the rate limit
   * protects capacity rather than a boundary. The degradation is logged at
   * warning level, so it is a visible event rather than a silent one.
   */
  public async consume(subject: string, policy: RateLimitPolicy): Promise<RateLimitOutcome> {
    try {
      const decision = await this.buckets.consume(subject, policy, this.clock.now());

      return { ...decision, limit: policy.requestsPerPeriod, wasDegraded: false };
    } catch (error: unknown) {
      this.logger.warn(
        { event: logEvents.rateLimiterDegraded, error },
        'The rate limiter could not reach the database; the request was allowed unmetered',
      );

      return {
        isAllowed: true,
        remainingRequests: policy.requestsPerPeriod,
        retryAfterSeconds: 0,
        resetsAfterSeconds: 0,
        limit: policy.requestsPerPeriod,
        wasDegraded: true,
      };
    }
  }

  /** Drops buckets that can no longer influence a decision. */
  public async prune(olderThanSeconds: number): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - olderThanSeconds * 1000);

    return this.buckets.prune(cutoff);
  }
}
