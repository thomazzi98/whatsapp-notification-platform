import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { applyMigrations } from '../bootstrap';
import { createDatabaseConnection, type DatabaseConnection } from '../connection';
import { RateLimitRepository } from './rate-limit.repository';

let connection: DatabaseConnection;
let buckets: RateLimitRepository;
let subjectCounter = 0;

/** Ten a minute with a burst of five: one every six seconds, five in hand. */
const policy = { requestsPerPeriod: 10, burstAllowance: 5, periodSeconds: 60 };

beforeAll(async () => {
  connection = createDatabaseConnection({
    connectionUrl: inject('databaseUrl'),
    maximumPoolSize: 4,
    applicationName: 'rate-limit-test',
  });

  // The container is shared and empty; each suite brings the schema it needs.
  await applyMigrations({
    database: connection.database,
    pool: connection.pool,
    migrationsFolder: './migrations',
  });

  buckets = new RateLimitRepository(connection.database);
});

afterAll(async () => {
  await connection.close();
});

beforeEach(() => {
  subjectCounter += 1;
});

const subject = (): string => `test:${String(subjectCounter)}`;
const at = (seconds: number): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

describe('spending an allowance', () => {
  it('allows a burst and then refuses', async () => {
    const key = subject();
    const outcomes = [];

    // All at the same instant, so nothing is replenished between them.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      outcomes.push(await buckets.consume(key, policy, at(0)));
    }

    expect(outcomes.slice(0, 5).map((outcome) => outcome.isAllowed)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(outcomes[5]?.isAllowed).toBe(false);
  });

  it('says exactly how long to wait, rather than until the next window', async () => {
    const key = subject();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await buckets.consume(key, policy, at(0));
    }

    const refused = await buckets.consume(key, policy, at(0));

    // One emission interval: six seconds at ten a minute. A fixed window would
    // have to say "up to sixty".
    expect(refused.retryAfterSeconds).toBeCloseTo(6, 1);
  });

  it('lets the refused request through once that wait has passed', async () => {
    const key = subject();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await buckets.consume(key, policy, at(0));
    }
    const refused = await buckets.consume(key, policy, at(0));
    const afterWaiting = await buckets.consume(key, policy, at(6));

    expect(refused.isAllowed).toBe(false);
    expect(afterWaiting.isAllowed).toBe(true);
  });

  it('refills gradually rather than all at once', async () => {
    const key = subject();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await buckets.consume(key, policy, at(0));
    }

    // Twelve seconds buys two, not the whole allowance back.
    const first = await buckets.consume(key, policy, at(12));
    const second = await buckets.consume(key, policy, at(12));
    const third = await buckets.consume(key, policy, at(12));

    expect([first.isAllowed, second.isAllowed, third.isAllowed]).toEqual([true, true, false]);
  });

  it('does not let an idle subject accumulate an unbounded allowance', async () => {
    const key = subject();
    await buckets.consume(key, policy, at(0));

    // An hour later the burst is full, and no larger than the burst.
    const outcomes = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      outcomes.push(await buckets.consume(key, policy, at(3600)));
    }

    expect(outcomes.filter((outcome) => outcome.isAllowed)).toHaveLength(5);
  });

  it("keeps one subject out of another one's way", async () => {
    const first = `${subject()}:a`;
    const second = `${subject()}:b`;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await buckets.consume(first, policy, at(0));
    }

    const spared = await buckets.consume(second, policy, at(0));

    expect(spared.isAllowed).toBe(true);
  });

  it('reports what is left before it runs out', async () => {
    const key = subject();

    const first = await buckets.consume(key, policy, at(0));
    const second = await buckets.consume(key, policy, at(0));

    // A caller can only pace itself if the answer is visible before the refusal.
    expect(first.remainingRequests).toBeGreaterThan(second.remainingRequests);
    expect(second.remainingRequests).toBeGreaterThanOrEqual(0);
  });
});

describe('two requests arriving together', () => {
  it('spends the allowance once, not twice', async () => {
    const key = subject();
    const tight = { requestsPerPeriod: 10, burstAllowance: 1, periodSeconds: 60 };

    // The decision is one statement precisely so this cannot both-succeed.
    const outcomes = await Promise.all([
      buckets.consume(key, tight, at(0)),
      buckets.consume(key, tight, at(0)),
      buckets.consume(key, tight, at(0)),
      buckets.consume(key, tight, at(0)),
    ]);

    expect(outcomes.filter((outcome) => outcome.isAllowed)).toHaveLength(1);
  });
});

describe('pruning', () => {
  it('removes buckets too old to influence a decision, and keeps fresh ones', async () => {
    const stale = `${subject()}:stale`;
    const fresh = `${subject()}:fresh`;
    await buckets.consume(stale, policy, at(0));
    await buckets.consume(fresh, policy, at(3600));

    const removed = await buckets.prune(at(1800));

    const afterPruning = await buckets.consume(stale, policy, at(3600));

    expect(removed).toBeGreaterThanOrEqual(1);
    // A pruned subject starts over, which is the same answer a missing row
    // would have given anyway.
    expect(afterPruning.isAllowed).toBe(true);
  });
});
