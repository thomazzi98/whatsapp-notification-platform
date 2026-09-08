# WhatsApp Notification Platform

A self-hosted, multi-tenant notification delivery platform for WhatsApp. Applications send
notifications through an HTTP API instead of integrating with a WhatsApp provider directly.

The platform persists every notification, queues it, dispatches it from a worker, and tracks its
delivery through provider webhooks — so a developer can answer "what happened to this message, and
why" without opening a log aggregator.

> **Status: under active construction.** This README grows with the implementation. See
> `docs/` for architecture notes and decision records as they land.

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

The notification domain depends on a provider _port_, never on WAHA itself, so a second provider can
be added without touching business rules.

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

and enabling `LongPathsEnabled` in the registry (requires an administrator and a reboot). Without
them, pnpm's virtual store can exceed the 260-character path limit and produce confusing partial
installs.

Running Docker commands from Git Bash is fine. Only ad-hoc `docker run -v` and `docker exec` with
absolute paths need `MSYS_NO_PATHCONV=1`, because MSYS rewrites arguments that begin with `/`.

## Running locally

```bash
corepack pnpm install
corepack pnpm setup:env
docker compose up
```

`setup:env` writes a `.env` from `.env.example` with freshly generated secrets, so the first
run does not require hand-crafting base64 keys. `.env.example` itself is generated from the
configuration schema, and a test fails if the two drift apart.

Compose brings up Postgres, a one-shot `migrate` service that applies migrations and exits, the
API, and the worker that delivers notifications. Ports are published on the loopback interface
only, and shifted off the defaults so this stack cannot collide with another local project:

| Service  | Address                 |
| -------- | ----------------------- |
| API      | `http://127.0.0.1:3100` |
| Postgres | `127.0.0.1:55432`       |

Add `--profile stub` to start a deterministic stand-in for WhatsApp on `127.0.0.1:3200`. It answers
to the same hostname as the real provider, so the whole pipeline — connect, send, deliver, receive
the delivery receipt — can be exercised without a phone, a scannable code, or an account that can
be banned.

```bash
docker compose --profile stub up
```

The API exposes two probes with deliberately different meanings. `/health` is liveness and checks
no dependency at all — a liveness probe that touches the database turns a brief Postgres outage
into a restart storm. `/ready` reports whether this instance can do useful work and returns 503,
with the reason, when the database is unreachable.

Two database roles are created: `platform_system` owns the schema and runs migrations, while
`platform_application` serves requests and is deliberately not a table owner. Keeping them
separate is what makes row level security meaningful, since a table owner is exempt from its
own policies.

## Development

```bash
corepack pnpm build
corepack pnpm test               # unit tests, no external services
corepack pnpm test:integration   # starts Postgres via Testcontainers
```

Other tasks: `pnpm lint`, `pnpm typecheck`, `pnpm verify:layers`, `pnpm verify:packaging`,
`pnpm format`.

## Code style

Enforced by lint rather than by review:

- No `else` — guard clauses, early returns, or strategy objects
- No abbreviated identifiers — `request`, `configuration`, `repository`, `database`, not `req`,
  `cfg`, `repo`, `db`
- English throughout: code, database identifiers, API responses, logs, tests, and commits

## License

MIT. See [LICENSE](LICENSE).
