import { type ApplicationConfiguration } from '@platform/configuration';
import { type DatabaseConnection } from '@platform/database';
import { queueNames, readDeclaredQueueNames } from '@platform/queue';
import { Inject, Injectable } from '@nestjs/common';

import { type DependencyCheckResult } from '../database/database-health.service';
import { APPLICATION_CONFIGURATION, DATABASE_CONNECTION } from '../tokens';

const CHECK_TIMEOUT_MILLISECONDS = 2000;

/**
 * Whether this instance can actually hand work to the worker.
 *
 * A database check does not answer that. The queue lives in a schema the
 * runtime role does not own, provisioned by a separate step, and the two ways
 * it goes wrong are both invisible to `select 1`: the bootstrap has not run, so
 * a queue this process sends to does not exist, or it ran without granting the
 * runtime role permission to insert. Both were real failures during
 * development, and both first appeared as a 500 on somebody's request rather
 * than as an instance reporting itself unready.
 */
@Injectable()
export class QueueHealthService {
  private readonly connection: DatabaseConnection;
  private readonly schema: string;

  public constructor(
    @Inject(DATABASE_CONNECTION) connection: DatabaseConnection,
    @Inject(APPLICATION_CONFIGURATION) configuration: ApplicationConfiguration,
  ) {
    this.connection = connection;
    this.schema = configuration.queue.schema;
  }

  private async readDeclaredQueues(): Promise<Set<string>> {
    return new Set(await readDeclaredQueueNames(this.connection.pool, this.schema));
  }

  public async check(): Promise<DependencyCheckResult> {
    const startedAt = process.hrtime.bigint();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('The queue did not respond within the probe timeout.')),
        CHECK_TIMEOUT_MILLISECONDS,
      );
    });

    try {
      const declared = await Promise.race([this.readDeclaredQueues(), timeout]);
      const missing = Object.values(queueNames).filter((name) => !declared.has(name));

      if (missing.length > 0) {
        return {
          status: 'down',
          durationMilliseconds: elapsedMilliseconds(startedAt),
          reason: `The bootstrap step has not declared: ${missing.join(', ')}.`,
        };
      }

      return { status: 'up', durationMilliseconds: elapsedMilliseconds(startedAt) };
    } catch (error: unknown) {
      return {
        status: 'down',
        durationMilliseconds: elapsedMilliseconds(startedAt),
        reason: error instanceof Error ? error.message : 'unknown error',
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

function elapsedMilliseconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
