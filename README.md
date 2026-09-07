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

## Development

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm test
```

Other tasks: `pnpm lint`, `pnpm typecheck`, `pnpm verify:layers`, `pnpm format`.

## Code style

Enforced by lint rather than by review:

- No `else` — guard clauses, early returns, or strategy objects
- No abbreviated identifiers — `request`, `configuration`, `repository`, `database`, not `req`,
  `cfg`, `repo`, `db`
- English throughout: code, database identifiers, API responses, logs, tests, and commits

## License

MIT. See [LICENSE](LICENSE).
