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

The provider runs WhatsApp Web itself, in a headless browser (the WEBJS engine),
so the first code takes a while to appear: the browser has to start and load
WhatsApp Web first. Codes then refresh on their own until one is scanned. The
dashboard stops asking for codes while its tab is in the background, because a
code nobody is looking at expires unscanned.

Use a number dedicated to this. It is an unofficial integration and the account
can be restricted or banned. What lowers the odds, none of which the software
can do for you:

- A real, long-used SIM number, never a virtual or VoIP one, in the WhatsApp
  Business app, with a name, a photo and a description.
- The phone kept on and online. Linked devices are logged out when the phone
  stays offline for two weeks.
- The people you notify writing to the number first, once. The dashboard shows
  the `wa.me` link for it on the connection's page. Someone who started the
  conversation is not a new contact, and WhatsApp's limits are on new contacts.
- When WhatsApp restricts the number, leaving it alone: see
  [WhatsApp restricted the number](#whatsapp-restricted-the-number).

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
   human. Notifications for a connection that cannot send wait for it, costing no
   attempt, for `DELIVERY_MAXIMUM_CONNECTION_WAIT_MINUTES` (an hour by default);
   after that they fail as `connection_unavailable` rather than go out late. To
   stop them sooner, **Cancel everything waiting** on the notifications page or on
   the connection's page.
2. **Is WhatsApp restricting the number?** The connection's page says so, and
   until when. Nothing is sent from a restricted connection until the
   restriction lifts — see
   [WhatsApp restricted the number](#whatsapp-restricted-the-number).
3. **Is the worker running?** `docker compose ps worker`. It has no HTTP port, so
   its health is its logs.
4. **Are jobs being claimed?** `SELECT name, state, count(*) FROM pgboss.job
GROUP BY 1, 2;`. Jobs in `created` with a worker running means the worker
   cannot reach the queue.
5. **Is pacing holding them?** Sending is deliberately slow — one message every
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

`connection_restricted` and `new_chat_quota_exceeded` mean WhatsApp refused the
message because of the number, not because of the message: a reachout timelock,
or a used-up quota of new chats. Neither is retried. `connection_paused` on a
notification still waiting is not a failure: it is holding until a restriction
lifts. See [WhatsApp restricted the number](#whatsapp-restricted-the-number).

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

### WhatsApp restricted the number

WhatsApp limits accounts that start conversations with people who never wrote to
them, which is what a notification platform does. It has two limits, and neither
disconnects anything: the session keeps reporting `WORKING` while messages are
refused.

- **Reachout timelock** (error 463). For hours to days, every message to a new
  contact is refused. Refusals repeated through a timelock are what turn it into
  a ban.
- **Monthly quota of new chats** (error 475). Once the allowance of messages to
  people who have not replied is used up, messages to new contacts are refused
  until the monthly cycle resets.

What the platform does about them, on its own:

1. **It pauses a timelocked connection.** It learns of the timelock from the
   status the provider repeats when one starts, from the session lookups it
   makes at most every ten minutes, or from a refused send. Nothing is sent from
   the connection until the timelock ends — or, when WhatsApp refused a message
   without saying for how long, for `DELIVERY_RESTRICTION_FALLBACK_PAUSE_HOURS`
   (six by default). Notifications the pause will release within
   `DELIVERY_MAXIMUM_CONNECTION_WAIT_MINUTES` wait for it as `connection_paused`,
   costing no attempt; the rest fail as `connection_restricted`, saying until
   when.
2. **It never retries a refused message.** A 463 fails its notification as
   `connection_restricted`, a 475 as `new_chat_quota_exceeded`. The quota does
   not pause the connection: people who already talk to the number keep
   receiving.
3. **It shows it.** The connection's page says the number is restricted and
   until when, and shows the quota as WhatsApp reports it, warnings included.
   The worker logs `provider.sending.paused` at warning level when a pause
   begins.

What you do:

1. **Nothing to the connection.** Do not restart, unpair or pair it again: that
   does not lift the restriction, and WAHA documents the same. It lifts on its
   own, and sending resumes when it does.
2. Cancel what is waiting if it should not go out late: **Cancel everything
   waiting** on the connection's page.
3. Have the recipients save the number and write to it first. A conversation
   they started is not a reach-out.
4. Send less, and only what the recipients expect. Pacing spaces messages out;
   it does not make unwanted ones acceptable.

Before WAHA reported these, the symptom was only in its log: `reachout timelock
restriction set`, sometimes followed by `Stream Errored (conflict)` as the
connection dropped.

```sql
-- Connections paused now, and what WhatsApp last reported about them.
SELECT id, display_name, sending_paused_until, account_limits, account_limits_checked_at
FROM whatsapp_sessions WHERE sending_paused_until > now();
```

### A connection cannot be deleted

A connection that any notification was queued against is part of that
notification's history, so it cannot be deleted; the dashboard refuses before the
provider is touched. **Unpair** it instead. If the provider has lost it, **Start**
creates it there again under the same name, ready to be paired by a new scan.

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

## Deploying

A push to `main` deploys it. The [Deploy workflow](../.github/workflows/deploy.yml)
runs the checks a pull request gets, publishes the `migrate`, `api`, `worker` and
`web` images to the GitHub Container Registry tagged with the commit's first twelve
characters, copies [docker-compose.production.yml](../docker-compose.production.yml)
and `tools/deploy/` to the server, and runs
[deploy.sh](../tools/deploy/deploy.sh) there over SSH. The script pulls the tag,
migrates, starts the stack, waits until every container is healthy, and asks for
`/health` through the public address before it records the tag in `.deployed-tag`.

Nothing on the server publishes a port. Ports 80 and 443 belong to a proxy the host
already runs: a Caddy that imports `/etc/caddy/sites/*.caddy` and is attached to an
external Docker network called `edge`. The dashboard container joins that network
as `whatsapp-notification-platform`, and each deploy writes the site file for the
hostname in `HTTP_PUBLIC_BASE_URL`, validates it, and reloads the proxy when it has
changed. The dashboard's own Caddy trusts that proxy through `TRUSTED_PROXY_RANGES`,
so the per-address limits meter visitors rather than one proxy address.

### Preparing a server

Once, as root, on a host with Docker and a `deploy` user in the `docker` group:

```bash
docker network create edge
install -d -o deploy -g deploy /opt/whatsapp-notification-platform /opt/edge/sites
```

Then write `/opt/whatsapp-notification-platform/.env`, owned by `deploy` and
readable by nobody else. It holds the variables in `.env.example`, generated on the
server and never copied anywhere, with these differences:

| Variable                                                    | Value                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `NODE_ENV`                                                  | `production`                                                                    |
| `HTTP_PUBLIC_BASE_URL`                                      | `https://<hostname>`                                                            |
| `SECURITY_COOKIE_SECURE`                                    | `true`                                                                          |
| `DATABASE_SYSTEM_PASSWORD`, `DATABASE_APPLICATION_PASSWORD` | In place of the two connection strings, which the compose file builds from them |
| `IMAGE_REPOSITORY`                                          | `ghcr.io/<owner>/whatsapp-notification-platform`                                |

`openssl rand -base64 32` makes a key; `openssl rand -hex 32` makes a password that
needs no escaping inside a URL.

### What the repository needs

A `production` environment that only `main` can deploy to, holding:

| Secret                       | What it is                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `DEPLOY_HOST`, `DEPLOY_USER` | Where to connect, and as whom                                                          |
| `DEPLOY_SSH_KEY`             | A key used for nothing else; its public half is in the deploy user's `authorized_keys` |
| `DEPLOY_KNOWN_HOSTS`         | The server's host key, so a different machine is refused instead of trusted            |
| `PUBLIC_BASE_URL`            | Asked for `/health` from outside the server after each deploy                          |

The registry needs nothing more. The run's own token pushes the images, and is
handed to the server on standard input to pull them while the run lasts.

### Operating it

Compose needs to know which tag is running:

```bash
cd /opt/whatsapp-notification-platform
export IMAGE_TAG="$(cat .deployed-tag)"
docker compose -f docker-compose.production.yml ps
```

Close registration once the accounts that should exist do: set
`SECURITY_REGISTRATION_ENABLED=false` in `.env`, then recreate the API with
`docker compose -f docker-compose.production.yml up -d api`.

### Rolling back

Run the Deploy workflow by hand with an earlier tag. Nothing is built; the server
switches images. On the server itself, after `docker login ghcr.io` if the images
are private:

```bash
/opt/whatsapp-notification-platform/tools/deploy/deploy.sh <tag>
```

Migrations are forward-only, so rolling back across one runs the older code against
the newer schema.

## Changing the WAHA engine

The platform runs WEBJS: WhatsApp Web itself, in a headless browser. It is
heavier than the websocket engines (budget roughly half a gigabyte of memory per
connection, and the `shm_size` the compose files set) and it is the engine WAHA
documents as the one that avoids blocking. Until October 2026 it ran NOWEB, on
which the number was restricted at a handful of messages a day. The stub answers
as WEBJS does, and can still answer as NOWEB, so the adapter keeps reading both.

Changing the engine means pairing again. `WAHA_NAMESPACE` defaults to the engine
name, so the pairing is stored per engine and a new engine finds none. The
platform copes with the provider forgetting a connection — sends wait for it as
for any lost connection, up to `DELIVERY_MAXIMUM_CONNECTION_WAIT_MINUTES` — but
the order matters:

1. Make sure no restriction is in force on the number. Pairing again does not
   lift one, and a new link made during one is the riskiest moment there is.
2. **Cancel everything waiting**, or deploy when nothing is.
3. Deploy. The new image is pulled and the provider container recreated; the
   database, `.env` and every API key are untouched.
4. Open the connection in the dashboard. It reads as stopped, because the new
   engine has no session for it. Press **Start**, which creates it again under the
   same name and signing key, and scan the code.
5. On the phone, under **Linked devices**, remove the device the old engine was
   paired as.
