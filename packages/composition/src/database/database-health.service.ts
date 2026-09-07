import { type DatabaseConnection } from '@platform/database';
import { Inject, Injectable } from '@nestjs/common';

import { DATABASE_CONNECTION } from '../tokens';

export interface DependencyCheckResult {
  readonly status: 'up' | 'down';
  readonly durationMilliseconds: number;
  readonly reason?: string;
}

const CHECK_TIMEOUT_MILLISECONDS = 2000;

@Injectable()
export class DatabaseHealthService {
  private readonly connection: DatabaseConnection;

  public constructor(@Inject(DATABASE_CONNECTION) connection: DatabaseConnection) {
    this.connection = connection;
  }

  private async queryWithTimeout(): Promise<void> {
    // The timeout has to cover acquiring a client as well as running the query.
    // Acquisition is where an unreachable host actually stalls, so wrapping
    // only the query leaves the probe hanging on DNS or TCP timeouts.
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('The database did not respond within the probe timeout.')),
        CHECK_TIMEOUT_MILLISECONDS,
      );
    });

    try {
      await Promise.race([this.acquireAndQuery(), timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async acquireAndQuery(): Promise<void> {
    const client = await this.connection.pool.connect();

    try {
      await client.query('select 1');
    } finally {
      client.release();
    }
  }

  /**
   * A readiness probe must fail fast. Without the timeout, a database that
   * accepts connections but never answers would hold the probe open until the
   * orchestrator's own timeout, turning a clear signal into a hang.
   */
  public async check(): Promise<DependencyCheckResult> {
    const startedAt = process.hrtime.bigint();

    try {
      await this.queryWithTimeout();
      return { status: 'up', durationMilliseconds: elapsedMilliseconds(startedAt) };
    } catch (error: unknown) {
      return {
        status: 'down',
        durationMilliseconds: elapsedMilliseconds(startedAt),
        reason: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }
}

function elapsedMilliseconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
