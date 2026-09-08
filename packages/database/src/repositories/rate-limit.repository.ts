import { sql } from 'drizzle-orm';

import { type QueryExecutor } from './notification.repository';

export interface RateLimitDecision {
  readonly isAllowed: boolean;
  readonly remainingRequests: number;
  readonly retryAfterSeconds: number;
  readonly resetsAfterSeconds: number;
}

export interface RateLimitPolicy {
  readonly requestsPerPeriod: number;
  readonly burstAllowance: number;
  readonly periodSeconds: number;
}

interface RateLimitRow extends Record<string, unknown> {
  readonly is_allowed: boolean;
  readonly remaining_requests: number;
  readonly retry_after_seconds: number;
  readonly resets_after_seconds: number;
}

export class RateLimitRepository {
  private readonly database: QueryExecutor;

  public constructor(database: QueryExecutor) {
    this.database = database;
  }

  /**
   * Spends one request against a subject's allowance.
   *
   * The whole decision happens inside one statement, which is what makes it
   * correct under concurrency: two requests arriving together cannot both read
   * the same state and both conclude they are within the limit.
   */
  public async consume(
    subject: string,
    policy: RateLimitPolicy,
    now: Date,
  ): Promise<RateLimitDecision> {
    // Every argument is cast: a bind parameter arrives untyped, and Postgres
    // cannot resolve which overload was meant from five unknowns.
    const result = await this.database.execute<RateLimitRow>(sql`
      select * from consume_rate_limit(
        ${subject}::text,
        ${policy.requestsPerPeriod}::integer,
        ${policy.burstAllowance}::integer,
        ${policy.periodSeconds}::integer,
        ${now}::timestamptz
      )
    `);
    const row = result.rows[0];

    if (row === undefined) {
      throw new Error('The rate limiter returned no decision.');
    }

    return {
      isAllowed: row.is_allowed,
      remainingRequests: Number(row.remaining_requests),
      retryAfterSeconds: Number(row.retry_after_seconds),
      resetsAfterSeconds: Number(row.resets_after_seconds),
    };
  }

  /** Removes buckets too old to belong to any window. */
  public async prune(olderThan: Date): Promise<number> {
    const result = await this.database.execute<{ prune_rate_limit_buckets: number }>(
      sql`select prune_rate_limit_buckets(${olderThan}::timestamptz)`,
    );

    return Number(result.rows[0]?.prune_rate_limit_buckets ?? 0);
  }
}
