# Runbook

How to operate the platform: starting it, connecting a number, and what to do
when something is wrong. Every command assumes the repository root.

## Starting

```bash
corepack pnpm install
corepack pnpm setup:env
docker compose up
```

`setup:env` writes `.env` from `.env.example` and generates the four secrets that
have no safe default. Compose then starts Postgres, runs `migrate` to completion,
and brings up the API, the worker, the dashboard and the WhatsApp provider.

| Service   | Address                 |
| --------- | ----------------------- |
| Dashboard | `http://127.0.0.1:8080` |
| API       | `http://127.0.0.1:3100` |
| Postgres  | `127.0.0.1:55432`       |

`COMPOSE_PROFILES` selects the provider. `whatsapp` runs the real gateway and
needs a phone; `stub` runs a deterministic stand-in and needs nothing. Exactly
one runs, because both answer to the hostname `waha`.

## Connecting a WhatsApp number

1. Sign in to the dashboard and open an application.
2. **Connections → Connect WhatsApp.** The session starts and a QR code appears.
3. Scan it with the phone that will send the messages, in WhatsApp under
   **Linked devices**.
4. Wait for the status to reach `WORKING`. Nothing before that means connected.

Two things about the QR flow are worth knowing in advance. The first code takes
about a minute to appear and later ones about twenty seconds. A session gets six
codes; after the sixth it fails and has to be restarted. The dashboard shows
which of the six is on screen, and refuses to consume attempts while the tab is
in the background — otherwise a forgotten tab silently burns the budget.

Use a number dedicated to this. It is an unofficial integration and the account
can be banned.

## Sending a first notification

Create an API key under **API keys**. It is shown once.

```bash
curl -X POST http://127.0.0.1:3100/v1/notifications \
  -H "Authorization: Bearer $WNP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"recipient":"+5511999998888","body":"Hello from the platform"}'
```

The answer is `202 Accepted` with a notification id. Delivery happens afterwards;
watch it on the notification's detail page, or poll
`GET /v1/notifications/{id}`.

## Everyday checks

```bash
docker compose ps                       # what is up, and whether it is healthy
docker compose logs -f worker           # the process that actually sends
curl -s http://127.0.0.1:3100/ready     # database and queue, with reasons
```

`/ready` reports WAHA as informational. A WhatsApp outage never makes the API
report itself unready, because the dashboard has to stay reachable exactly then.

Useful queries:

```sql
-- What the queue is holding right now.
SELECT status, count(*) FROM notifications GROUP BY status ORDER BY 2 DESC;

-- Anything stuck mid-dispatch: a claim older than the timeout means a worker died.
SELECT id, claimed_at FROM notifications
WHERE status = 'PROCESSING' AND claimed_at < now() - interval '5 minutes';

-- Deliveries that arrived for a notification nobody could match.
SELECT * FROM webhook_deliveries WHERE outcome = 'UNMATCHED' ORDER BY created_at DESC LIMIT 20;
```

## When something is wrong

### Nothing is being delivered

Check in this order, because each answer changes the next step.

1. **Is the session `WORKING`?** Connections page, or
   `SELECT status FROM whatsapp_sessions;`. A session in `SCAN_QR_CODE` needs a
   human, and notifications for it are deferred rather than failed.
2. **Is the worker running?** `docker compose ps worker`. It has no HTTP port, so
   its health is its logs.
3. **Are jobs being claimed?** `SELECT name, state, count(*) FROM pgboss.job
GROUP BY 1, 2;`. Jobs in `created` with a worker running means the worker
   cannot reach the queue.
4. **Is pacing holding them?** Sending is deliberately slow — one message every
   thirty to sixty seconds per connection. A backlog draining slowly is the
   system working, not failing.

### A notification failed

The detail page shows the failure code, the classification, and every attempt.
One code means the platform is misconfigured rather than the message being bad:
`provider_unauthorized`. It is permanent, and it means `WAHA_API_KEY` does not
match what the gateway expects.

`provider_response_unreadable` means the gateway answered in a shape the adapter
does not recognise — normally an engine change. It is retryable and counted as an
unknown outcome.

### Delivery receipts are not arriving

`WAHA_WEBHOOK_PUBLIC_URL` must be reachable **from the WAHA container**, not from
your machine. In the default Compose setup that is `http://api:3000`.

Check what arrived:

```sql
SELECT outcome, count(*) FROM webhook_deliveries GROUP BY 1;
```

`APPLIED` is the normal case, `IGNORED` an event type with no rule, `UNMATCHED` a
receipt for a notification that could not be found even after the grace period.

An empty table means nothing is arriving at all. A delivery whose signature does
not verify is refused at the edge and never stored, so it appears in the API logs
rather than here — normally it means the signing key held for the session and the
one WAHA is using have diverged, which a recreated session fixes.

### The API answers 429

The rate limiter refused the request; `retry-after` says for how long. Every `/v1`
response carries `ratelimit-limit`, `ratelimit-remaining` and `ratelimit-reset`,
so a client can pace itself rather than discover the limit by hitting it.

If the limiter cannot reach the database it fails open and logs
`ratelimit.degraded` at warning level. Traffic is served unmetered until the
database returns.

### A worker died mid-dispatch

Nothing needs doing. The maintenance job reaps claims older than
`DELIVERY_STUCK_CLAIM_TIMEOUT_SECONDS` and requeues them. The attempt is already
spent, on purpose: a crash after the provider accepted a message must not be
retried for free.

## Maintenance

The worker runs a maintenance pass on a schedule. One pass reaps abandoned
claims, requeues notifications whose job was lost, and prunes rate limit buckets
older than any window they could belong to. It is bounded to two hundred rows per
pass, so a large backlog drains over several passes rather than in one long
transaction that starves dispatch.

## Backups

Everything is in Postgres except the WhatsApp pairing, which is in the `waha`
container's volumes.

```bash
docker compose exec postgres pg_dump -U platform_system notifications > backup.sql
```

Losing the WAHA volumes means re-scanning the QR code. Losing the database means
losing the notification history; the pairing survives.

## Rotating secrets

| Secret                        | Effect of rotating                                               |
| ----------------------------- | ---------------------------------------------------------------- |
| `SECURITY_API_KEY_PEPPER`     | Invalidates **every** API key. Issue new ones.                   |
| `SECURITY_ENCRYPTION_KEY`     | Makes stored webhook signing keys unreadable. Recreate sessions. |
| `SECURITY_CURSOR_SIGNING_KEY` | Invalidates outstanding pagination cursors. Harmless.            |
| `WAHA_API_KEY`                | Must be changed in the same `.env`; both sides read it.          |

There is no key rotation scheme with overlap. That is a real limitation, and it
is the reason each row above says what breaks.

## Upgrading

`migrate` runs on every start and is idempotent, so the sequence is: pull, build,
`docker compose up`. Migrations hold an advisory lock, so several instances
starting together do not race.

Migrations are forward-only. There is no `down` — a rollback that has never been
executed is not a plan. Restore from a backup instead.

## Changing the WAHA engine

Don't, unless you are prepared to re-scan. `WAHA_NAMESPACE` defaults to the engine
name, so the pairing is stored per engine and switching loses it. The stub and the
acknowledgement mapping are modelled on NOWEB.
