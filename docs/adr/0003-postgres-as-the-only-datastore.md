# 0003 — Postgres is the only datastore

Status: Accepted

## Context

The platform needs durable storage, a job queue with delayed and scheduled
execution, rate limit counters, and an inbox for webhook deliveries. The
reflexive answer is Postgres plus Redis.

## Decision

Postgres alone. The queue is pg-boss, which stores jobs in Postgres tables. Rate
limiting is a plpgsql function over one row per subject. Scheduling is a column,
not a timer in a process.

## Consequences

- A notification and the job that will deliver it commit in the same
  transaction. With a separate queue this is the dual-write problem and needs an
  outbox and a relay. See [0005](0005-transactional-enqueue-over-outbox.md).
- One service to run, back up, and restore. `docker compose up` is a complete
  system, which is the difference between a project someone tries and a project
  someone reads about.
- Rate limiting costs a database round trip rather than a Redis round trip. At
  the volume a WhatsApp number can sustain — a message every thirty to sixty
  seconds per connection — this is not the constraint. It would be at a
  different scale, and the limiter is behind a repository so it can move.
- Losing Postgres loses everything at once. That is a real trade: two datastores
  would degrade partially. For a self-hosted platform, one thing to keep alive
  is worth more than partial degradation.

## Alternatives considered

**Redis for the queue and rate limits.** Rejected: it reintroduces the dual write
between the notification and its job, which is the failure mode this design is
built to avoid, and it doubles the operational surface for a workload that does
not need it.
