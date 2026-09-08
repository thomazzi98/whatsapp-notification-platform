# 0005 — Transactional enqueue instead of an outbox table

Status: Accepted

## Context

Accepting a notification means two writes: the notification row, and the job that
will deliver it. If those are not atomic, one of two bugs is guaranteed. Write
the row first and crash, and a notification exists that nothing will ever send.
Enqueue first and crash, and a job runs for a row that was never committed.

The usual fix is the transactional outbox: write an outbox row in the same
transaction, and have a relay move it to the queue.

## Decision

pg-boss's `fromDrizzle(transaction, sql)` adapter, which enqueues through the
caller's Drizzle transaction. The claim on the idempotency key, the notification
row, the first timeline event, the job, and the completion of the key all commit
together or not at all.

The queue table *is* the outbox. There is no relay because there is nothing to
relay.

## Consequences

- On commit, everything exists. On rollback, nothing does — including the
  idempotency claim, so a client retry gets a clean claim rather than a key
  poisoned for twenty-four hours.
- This is only sound because the request handler performs no network input or
  output. The WhatsApp call happens in the worker. A test asserts that property,
  and a five second `statement_timeout` on the runtime role is the backstop.
- It ties the queue to the same database as the domain. That is the trade being
  made deliberately: see [0003](0003-postgres-as-the-only-datastore.md).
- The transaction now spans the tenant scope as well, since the enqueue runs as
  the tenant role. That role therefore needs insert permission on the queue
  tables, granted by the bootstrap step.

## Alternatives considered

**A hand-written outbox table plus a relay process.** Rejected: it is strictly
more machinery for the same guarantee, and the relay is another process to
supervise, monitor and explain.
