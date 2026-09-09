# WhatsApp Notification Platform

A self-hosted, multi-tenant notification delivery platform for WhatsApp.
Applications send notifications through an HTTP API instead of integrating with
a WhatsApp provider directly.

The platform persists every notification, queues it, dispatches it from a
worker, and tracks its delivery through provider webhooks — so a developer can
answer "what happened to this message, and why" without opening a log
aggregator.

Everything runs locally with `docker compose up`. There is no paid service
anywhere in it.

```bash
corepack pnpm install
corepack pnpm setup:env
docker compose up
```

Then open `http://127.0.0.1:8080`, create an application, generate an API key,
connect a WhatsApp number, and send:

```bash
curl -X POST http://127.0.0.1:3100/v1/notifications \
  -H "Authorization: Bearer $WNP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"recipient":"+5511999998888","body":"Hello from the platform"}'
```

The answer is `202 Accepted`, because the message has been accepted rather than
delivered. Watch the rest happen on the notification's detail page.

## What it does

- **Accepts and answers immediately.** The request writes and enqueues in one
  transaction and returns; nothing on the request path talks to WhatsApp.
- **Retries what deserves retrying.** Twenty-one failure conditions are each
  classified as retryable or permanent, with exponential backoff and equal
  jitter, and a per-notification attempt budget.
- **Tells the truth about delivery.** Provider receipts drive the status.
  Acknowledgements merge by maximum, so an out-of-order receipt can never move a
  notification backwards.
- **Keeps tenants apart.** Scoped queries, composite foreign keys that make a
  cross-tenant reference impossible to write, and Postgres row level security
  underneath both.
- **Refuses to send twice, as far as that is possible.** Compare-and-swap claims
  make concurrent double sends impossible; the crash window is narrowed and
  named rather than papered over.
- **Paces itself.** Sends are spaced thirty to sixty seconds apart per
  connection, randomised, because a metronome is what automated-messaging
  detection looks for.

## Documentation

| Document                               | What is in it                                                       |
| -------------------------------------- | ------------------------------------------------------------------- |
| [Architecture](docs/architecture.md)   | What the parts are, how a notification travels, where the seams are |
| [Decision records](docs/adr/README.md) | Eighteen decisions, each with its alternatives and its cost         |
| [Runbook](docs/runbook.md)             | Operating it: connecting a number, diagnosing, backups, rotation    |
| [Security](docs/security.md)           | Threat model, controls, and what a review found and fixed           |
| [Performance](docs/performance.md)     | Where the time goes, what the indexes are for, measured numbers     |

The API describes itself at `/v1/openapi.json`, generated from the same schemas
that validate the requests.

## Architecture at a glance

```
Application
   │  POST /v1/notifications
   ▼
Notification API ──► Notification domain ──► Queue (Postgres)
                                                │
                                                ▼
                                           Worker ──► WhatsApp provider port
                                                            │
                                                            ▼
                                                          WAHA ──► WhatsApp
```

The notification domain depends on a provider _port_, never on WAHA itself, so a
second provider can be added without touching business rules. The queue is a
Postgres table, which is what lets a notification and the job that delivers it
commit together.

## Repository layout

| Path        | Contents                                                            |
| ----------- | ------------------------------------------------------------------- |
| `apps/`     | Deployable processes: the HTTP API, the queue worker, the dashboard |
| `packages/` | Domain rules, contracts, adapters, and the composition root         |
| `tools/`    | Development and test tooling, including a deterministic WAHA stub   |
| `docs/`     | Architecture, decision records, and operational guides              |

## Requirements

- Node.js 24 or newer
- pnpm 11.26 (activated automatically through Corepack)
- Docker with Compose v2

### Windows

Two host settings matter, because their symptoms are misleading:

```bash
git config --global core.longpaths true
```

and enabling `LongPathsEnabled` in the registry (requires an administrator and a
reboot). Without them, pnpm's virtual store can exceed the 260-character path
limit and produce confusing partial installs.

Running Docker commands from Git Bash is fine. Only ad-hoc `docker run -v` and
`docker exec` with absolute paths need `MSYS_NO_PATHCONV=1`, because MSYS
rewrites arguments that begin with `/`.

## Running locally

`setup:env` writes a `.env` from `.env.example` with freshly generated secrets,
so the first run does not require hand-crafting base64 keys. `.env.example`
itself is generated from the configuration schema, and a test fails if the two
drift apart.

Compose brings up Postgres, a one-shot `migrate` service that applies migrations
and exits, the API, the worker, and the dashboard. Ports are published on the
loopback interface only, and shifted off the defaults so this stack cannot
collide with another local project:

| Service   | Address                 |
| --------- | ----------------------- |
| Dashboard | `http://127.0.0.1:8080` |
| API       | `http://127.0.0.1:3100` |
| Postgres  | `127.0.0.1:55432`       |

The dashboard and the API answer on one origin — `8080` serves the built bundle
and forwards `/v1`, `/dashboard` and `/webhooks` to the API. That is what keeps
the session cookie first-party, removes the need for CORS entirely, and leaves
the browser bundle with no API URL compiled into it. Port `3100` reaches the API
directly, which is convenient for `curl` and for the API-key surface.

`COMPOSE_PROFILES` in `.env` chooses which WhatsApp provider starts. `setup:env`
writes `whatsapp`, which runs the real provider — the one that needs a phone to
pair. Setting it to `stub` instead runs a deterministic stand-in on
`127.0.0.1:3200`, so the whole pipeline — connect, send, deliver, receive the
delivery receipt — can be exercised without a phone, a scannable code, or an
account that can be banned. Exactly one of the two runs, because both answer to
the same hostname.

The provider is not published to the network. It holds a paired WhatsApp account
and its own API has no per-tenant authorization, so it is infrastructure this
platform speaks to rather than a boundary anyone else may reach.

The API exposes two probes with deliberately different meanings. `/health` is
liveness and checks no dependency at all — a liveness probe that touches the
database turns a thirty-second blip into a restart storm. `/ready` checks
database and queue, and returns 503, with the reason, when the database is
unreachable.

Three database roles exist. `platform_system` owns the schema and runs
migrations. `platform_application` serves requests and is deliberately not a
table owner. `platform_tenant` cannot log in at all: an API-key authenticated
request assumes it for the length of one transaction, and while it is assumed
the connection can see only that tenant's rows.

## Development

```bash
corepack pnpm build
corepack pnpm test               # unit and component tests, no external services
corepack pnpm test:integration   # starts Postgres via Testcontainers
corepack pnpm test:e2e           # drives the running stack in a browser
```

Four layers, each answering a question the one below it cannot.

| Layer       | Tool                    | Answers                                                                    |
| ----------- | ----------------------- | -------------------------------------------------------------------------- |
| Unit        | Vitest                  | Do the rules hold — the state machine, backoff, phone parsing, ack merging |
| Component   | Vitest, Testing Library | Does a screen say the right thing in this state, and is it labelled        |
| Integration | Vitest, Testcontainers  | Does the database enforce what it is supposed to, under real concurrency   |
| End to end  | Playwright              | Does the whole thing work in a browser, against the production images      |

The end-to-end suite expects `docker compose up` to be running with
`COMPOSE_PROFILES=stub`, and drives the production images rather than a
development server — so the path that actually ships is never the untested one.

Accessibility is checked in both of the last two: axe runs over every rendered
component in jsdom, and over each route in a real browser, where the rules that
need layout and colour can actually run. It has already earned its place —
the first run found two colour pairs below the contrast threshold.

Alongside the tests, six checks that answer questions a test cannot. Each one
was written because the thing it checks had already gone wrong once.

| Command                 | Refuses                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `pnpm verify:layers`    | An import that crosses a layer — a controller reaching into an adapter          |
| `pnpm verify:unused`    | A file, dependency or export nothing uses                                       |
| `pnpm verify:packaging` | A package whose manifest points at a file the build never emitted               |
| `pnpm verify:docs`      | A dead documentation link, a diagram that no longer parses, an unindexed record |
| `pnpm verify:secrets`   | A credential in the working tree or anywhere in the history                     |
| `pnpm audit --prod`     | A known vulnerability in anything that ships                                    |

The secret scanner self-tests before it runs: it classifies known secrets and
known fixtures first, and fails if it gets either wrong. A scanner that has
quietly stopped matching reports success, which is worse than not running.

Also `pnpm format`, and `pnpm build`.

```bash
docker compose up --watch
```

rebuilds and restarts a service when its sources change. It rebuilds rather than
syncing files: this project targets Docker Desktop on Windows, where bind mounts
go through 9p and inotify events do not propagate, so a file-watching reloader
there is silently dead rather than merely slow.

## Code style

Enforced by lint rather than by review:

- No `else` — guard clauses, early returns, or strategy objects
- No abbreviated identifiers — `request`, `configuration`, `repository`,
  `database`, not `req`, `cfg`, `repo`, `db`
- English throughout: code, database identifiers, API responses, logs, tests,
  and commits

The reasoning is in [ADR 0018](docs/adr/0018-no-else-and-no-abbreviations.md).

## Honest limitations

Every one of these is a consequence of a decision made on purpose. None of them
is a bug waiting to be fixed.

1. **Delivery is at-least-once, not exactly-once.** WAHA's send endpoint accepts
   no idempotency key, so a worker killed between WhatsApp accepting a message
   and the outcome being committed leaves a window that cannot be closed from
   this side. Claim-before-send removes concurrent duplicates entirely, the
   attempt budget is spent before the network call, and a unique index catches
   the rest — but the guarantee is at-least-once and is described that way
   everywhere.
2. **This is an unofficial WhatsApp integration.** The number can be banned at
   any time and no software choice prevents it. Pacing mitigates. Use a
   dedicated number, never a personal one.
3. **A missing read receipt is not a failure.** Recipients can turn read receipts
   off, and the dashboard says so rather than showing an error.
4. **Cancellation cannot recall a sent message.** That is why `PROCESSING →
CANCELLED` is an illegal transition and cancelling one answers 409.
5. **Changing the WAHA engine forces a QR re-scan.** `WAHA_NAMESPACE` defaults to
   the engine name, so the pairing is stored per engine.
6. **Idempotency keys expire after twenty-four hours**, the same contract as
   Stripe's.
7. **Row level security covers the notification surface, not everything.**
   `/v1/applications/current` reads a row already keyed by the organisation and
   application on the authenticated key, and the dashboard is authorised by
   organisation membership rather than by tenant scope. Both are protected by
   application-level scoping alone. See
   [ADR 0014](docs/adr/0014-row-level-security-as-a-backstop.md).
8. **The rate limiter fails open.** If it cannot reach the database, the request
   is served unmetered and the degradation is logged. That is the right trade for
   a limiter protecting capacity and the wrong one for a limiter protecting a
   boundary.
9. **Templates exist in the schema and not in the product.** There is a table and
   a migration; there is no API and no editor. Rendering a template into a
   message is not yet a feature.
10. **The OpenAPI document describes the public API only.** `/v1/openapi.json`
    is generated from the same Zod schemas that validate requests, and a test
    fails if a `/v1` route exists without being described. The dashboard surface
    is deliberately absent: it is an internal contract between this API and this
    dashboard, not something to generate clients against.
11. **No password reset, no multi-factor authentication, no audit log of
    dashboard actions, and no secret rotation with overlap.** The reasons, and
    what each rotation breaks, are in [Security](docs/security.md) and the
    [Runbook](docs/runbook.md).
12. **Single instance assumptions are avoided but untested at scale.** Nothing in
    the design prevents several API or worker processes from running; the claim
    is compare-and-swap and the migration barrier takes an advisory lock. It has
    not been load tested with many of each.

## License

MIT. See [LICENSE](LICENSE).
