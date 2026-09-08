# 0012 — Rate limiting by GCRA inside Postgres

Status: Accepted

## Context

Two different limits are needed, and they are frequently confused.

The first protects platform capacity: how many API requests a key may make. The
second protects the WhatsApp account from being banned: how fast messages may be
sent from one connection. They have different subjects, different windows, and
different consequences for being wrong.

A fixed window is the usual implementation and it has a well-known flaw: a caller
can spend a whole allowance at the end of one window and the next at the start of
the following one, so "sixty a minute" permits a hundred and twenty in two
seconds.

## Decision

For API requests, the generic cell rate algorithm in a plpgsql function. One row
per subject holds the theoretical arrival time of the next request that would be
exactly on pace. A burst allowance is how far ahead of that a caller may borrow.

The decision and the write are a **single** `INSERT … ON CONFLICT DO UPDATE …
WHERE` statement. Reading first and writing second leaves a window in which two
callers observe the same state and both conclude they are within the limit — and
for a subject with no row yet, `SELECT … FOR UPDATE` locks nothing at all, so it
serialises nothing. That bug was written, and a concurrency test found it.

For WhatsApp pacing, a separate limiter in the worker with a randomised thirty
to sixty second interval per connection. It is randomised precisely because
GCRA's metronomic output is the pattern automated-messaging detection looks for.

## Consequences

- No window-boundary burst, and an exact `retry-after` rather than "try again
  next window".
- `rate_limit_buckets` has no secondary index, so the hot in-place update stays
  heap-only. A reaper deletes rows older than any window they could belong to.
- The limiter **fails open** and logs the degradation at warning level. For a
  self-hosted product, a database hiccup taking the API offline is worse than
  briefly serving unmetered traffic. That is a deliberate choice, and it would be
  the wrong one for a limiter defending a security boundary rather than capacity.
