# Performance

Where the time actually goes, measured rather than assumed, and what the indexes
are for.

## What was measured, and on what

Docker Desktop on Windows 11 with WSL2, 16 CPUs and 15.5 GiB available to the
engine, everything in one Compose stack: Postgres 17, the API, the worker, and
the deterministic provider stub. Requests were issued **from inside the API
container** to `127.0.0.1:3000`, so the numbers exclude the host's port
forwarding and describe the server rather than the tunnel.

This is a laptop, not a benchmark rig, and the disk is a virtualised one. That
turns out to be the single most important fact about these numbers.

## The result that mattered

The rate limiter was making every metered request wait for a write-ahead log
flush.

| Endpoint                       | Before   | After    |
| ------------------------------ | -------- | -------- |
| `GET /v1/applications/current` | 35.7 ms  | 7.4 ms   |
| `GET /v1/notifications`        | 74.6 ms  | 8.8 ms   |
| `POST /v1/notifications`       | 256.0 ms | 116.8 ms |

All figures are p50 over forty sequential requests.

The limiter's decision is a write — an `INSERT … ON CONFLICT DO UPDATE` against
one row — and it sits on the path of every request that carries an API key.
Timed directly in `psql`, `consume_rate_limit` took **37 ms**; the same call in a
transaction with `synchronous_commit` off took **0.6 ms**. The whole cost was
the flush.

Rate limit state does not deserve that. The limiter already fails open, so it is
advisory by design; the worst an update lost to an unclean shutdown can do is let
a caller through a few requests early. The repository therefore opens its own
transaction and sets `synchronous_commit = off` inside it — scoped there
deliberately, so it can never quietly weaken the durability of a domain write.

Notification writes keep their flush. Losing an accepted notification is exactly
the failure this platform exists to prevent.

## Where the remaining time goes

With `log_min_duration_statement = 0`, every statement behind one accepted
notification is visible:

```
0.009 ms  begin
0.020 ms  select … from whatsapp_sessions …
0.353 ms  insert … idempotency_keys …
0.401 ms  insert … notifications …
0.3xx ms  insert … notification_events …
0.2xx ms  insert … pgboss.job_common …
…
317 ms    commit
```

Every statement is a fraction of a millisecond. The commit is three orders of
magnitude larger. Under concurrent load — the worker dispatching while the API
accepts — commits were observed between 317 ms and 426 ms.

That is what a virtualised disk costs. On a server with an NVMe device, or any
cloud volume with a write cache, an fsync is closer to one millisecond, and every
figure in the table above would be dominated by the statements instead. The shape
of the work is right; the constant is the host's.

The practical consequence is that this platform's write throughput is bounded by
commit latency, not by query planning or by row counts — which is also why the
one optimisation that mattered was removing a commit from the hot path rather
than tuning a query.

## Queries and their indexes

Every index exists for a query that runs, and the tenant column leads on all of
them because it is always an equality predicate — leading with a range column
would demote the equality to a filter.

The list endpoint, on the index it was designed for:

```
Limit (actual time=0.039..0.073 rows=25 loops=1)
  Buffers: shared hit=5
  ->  Index Scan Backward using notifications_application_created_at_index
        Index Cond: (application_id = '…'::uuid)
```

Twenty-five rows for five buffer hits, no sort, no heap scan.

| Index                                               | Serves                                      | Shape                                                          |
| --------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| `notifications_application_created_at_index`        | The list endpoint and its keyset pagination | `(application_id, created_at, id)`                             |
| `notifications_application_status_created_at_index` | The same list filtered by status            | `(application_id, status, created_at)`                         |
| `notifications_application_recipient_index`         | "What did we send this person?"             | `(application_id, recipient_phone_number, created_at)`         |
| `notifications_provider_message_id_unique`          | Resolving an inbound receipt in one seek    | Partial unique on `(whatsapp_session_id, provider_message_id)` |
| `notifications_due_scheduled_index`                 | The scheduler                               | Partial: `status = 'SCHEDULED'`                                |
| `notifications_due_retry_index`                     | The retry sweep                             | Partial: `status = 'RETRYING'`                                 |
| `notifications_stuck_claims_index`                  | Reaping claims a crashed worker left behind | Partial: `status = 'PROCESSING'`                               |
| `notification_send_attempts_unresolved_index`       | Finding an attempt whose outcome is unknown | Partial: `outcome IS NULL`                                     |

The partial ones are the interesting group. Each covers only work that is
actually pending, so in steady state they are nearly empty and the maintenance
sweeps cost time proportional to the backlog rather than to the history. A
notification that was delivered last month is in none of them.

Two deliberate absences:

- **`rate_limit_buckets` has no index but its primary key.** Every request
  updates its own row in place; a secondary index would turn a cheap heap-only
  update into a full index write on the hottest table in the system.
- **Primary keys on the hot tables are UUIDv7, not v4.** A v7 identifier begins
  with a millisecond timestamp, so inserts append at the right edge of the
  B-tree. Random v4 keys scatter writes across the whole index and bloat it.

## The parts that are slow on purpose

**Sending is paced at one message per thirty to sixty seconds per connection,
randomised.** End-to-end delivery time is therefore dominated by pacing, not by
anything the platform does — a backlog draining slowly is the system working.
The randomisation is not incidental: a metronome is the pattern automated
messaging detection looks for.

**The maintenance pass is bounded to two hundred rows.** A pass that tried to
repair an entire backlog at once would hold a long transaction and starve the
dispatch workers it shares a database with. The cron runs again a minute later.

**The API answers 202 rather than waiting.** Nothing on the request path
contacts WhatsApp. That is what makes an accepted notification a sub-second
operation while the provider takes seconds.

## The browser bundle

| Asset      | Raw      | Gzipped |
| ---------- | -------- | ------- |
| JavaScript | 309.9 kB | 93.4 kB |
| CSS        | 14.8 kB  | 3.9 kB  |

It was 799 kB. `verbatimModuleSyntax` preserves type-only imports as
side-effect imports, and the server packages are CommonJS, so nothing could be
tree-shaken and Zod plus the entire domain were being shipped to the browser.
The setting is disabled for the web application only.

Polling adapts to what is on screen: two seconds while a QR code is being
scanned, thirty while a connection is working, and stopped entirely on a terminal
state or a hidden tab.

## Images

| Image       | Size    |
| ----------- | ------- |
| `api`       | 273 MB  |
| `worker`    | 265 MB  |
| `migrate`   | 257 MB  |
| `waha-stub` | 238 MB  |
| `web`       | 60.5 MB |

The Node images share a base and a build cache, so the three of them do not cost
three times 260 MB on disk. `pnpm deploy --prod` prunes development dependencies
out of the runtime layer; the remainder is `node:24-bookworm-slim` itself.
Alpine would be smaller and is not used: musl breaks the Argon2 and Tailwind
native binaries.

## What has not been measured

Honest gaps, not oversights.

- **No load test.** Every figure here is sequential and single-client. Nothing
  has been measured under concurrency beyond the incidental contention of the
  worker running alongside.
- **No measurement at volume.** The largest table during measurement held a few
  hundred rows. The plans are index scans with tenant-leading keys, so they
  should hold; "should" is not "was measured".
- **No profiling of the Node processes.** The statement log shows the database is
  not the constraint, but nothing separates Fastify, Nest and the pool inside the
  remaining milliseconds.
- **No measurement against real WAHA.** Provider latency is the stub's, which is
  deliberately deterministic and therefore not representative.
