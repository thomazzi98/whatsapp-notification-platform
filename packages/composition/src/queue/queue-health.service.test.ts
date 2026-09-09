import { type ApplicationConfiguration } from '@platform/configuration';
import { type DatabaseConnection } from '@platform/database';
import { queueNames } from '@platform/queue';
import { describe, expect, it, vi } from 'vitest';

import { QueueHealthService } from './queue-health.service';

/**
 * The two ways the queue goes wrong are both invisible to the database check:
 * the bootstrap never ran, so a queue this process sends to does not exist, or
 * it ran without granting the runtime role permission to insert. Both were real
 * failures during development, and both first appeared as a 500 on somebody's
 * request rather than as an instance reporting itself unready.
 */
function connectionReturning(rows: { name: string }[] | Error | 'hangs'): DatabaseConnection {
  return {
    pool: {
      query: vi.fn(async () => {
        if (rows === 'hangs') {
          await new Promise(() => {
            // Never settles.
          });
        }
        if (rows instanceof Error) {
          throw rows;
        }
        return { rows };
      }),
    },
  } as unknown as DatabaseConnection;
}

const configuration = { queue: { schema: 'pgboss' } } as ApplicationConfiguration;

describe('the queue readiness check', () => {
  it('reports up when every declared queue is present', async () => {
    const declared = Object.values(queueNames).map((name) => ({ name }));

    const result = await new QueueHealthService(
      connectionReturning(declared),
      configuration,
    ).check();

    expect(result.status).toBe('up');
  });

  it('names the queue the bootstrap failed to declare', async () => {
    const [missing, ...rest] = Object.values(queueNames);

    const result = await new QueueHealthService(
      connectionReturning(rest.map((name) => ({ name }))),
      configuration,
    ).check();

    expect(result.status).toBe('down');
    expect(result.reason).toContain(missing);
  });

  it('reports the reason a missing grant gave', async () => {
    const result = await new QueueHealthService(
      connectionReturning(new Error('permission denied for table queue')),
      configuration,
    ).check();

    expect(result.status).toBe('down');
    expect(result.reason).toContain('permission denied');
  });

  it('gives up rather than hanging with a database that never answers', async () => {
    const started = Date.now();

    const result = await new QueueHealthService(
      connectionReturning('hangs'),
      configuration,
    ).check();

    expect(result.status).toBe('down');
    expect(result.reason).toContain('did not respond');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
