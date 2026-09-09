import { type DatabaseConnection } from '@platform/database';
import { describe, expect, it, vi } from 'vitest';

import { DatabaseHealthService } from './database-health.service';

/**
 * The readiness probe's whole promise is that it answers.
 *
 * A database that accepts connections and then never replies is the case that
 * matters: without the timeout the probe hangs until the orchestrator gives up,
 * turning a clear "not ready" into a request that never returns — and nothing
 * else in the suite exercises it, because a real Postgres always answers.
 */
function connectionThat(behaviour: 'answers' | 'hangs' | 'refuses'): DatabaseConnection {
  const client = {
    query: vi.fn(() => {
      if (behaviour === 'refuses') {
        return Promise.reject(new Error('connection refused'));
      }
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(),
  };

  return {
    pool: {
      connect: vi.fn(async () => {
        if (behaviour === 'hangs') {
          await new Promise(() => {
            // Never settles, exactly like a host that accepted the socket and
            // then stopped talking.
          });
        }
        return client;
      }),
    },
  } as unknown as DatabaseConnection;
}

describe('the database readiness check', () => {
  it('reports up when the database answers', async () => {
    const result = await new DatabaseHealthService(connectionThat('answers')).check();

    expect(result.status).toBe('up');
    expect(result.durationMilliseconds).toBeGreaterThanOrEqual(0);
  });

  it('gives up on a database that never answers, rather than hanging with it', async () => {
    const started = Date.now();

    const result = await new DatabaseHealthService(connectionThat('hangs')).check();

    expect(result.status).toBe('down');
    expect(result.reason).toContain('did not respond');
    // The probe's own budget, not the orchestrator's.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports the reason a refused connection gave, rather than a generic failure', async () => {
    const result = await new DatabaseHealthService(connectionThat('refuses')).check();

    expect(result.status).toBe('down');
    expect(result.reason).toBe('connection refused');
  });
});
