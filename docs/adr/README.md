# Architecture decision records

One file per decision that was not obvious, written when the decision was made.
Each records what the alternatives were and what the decision costs, because the
cost is the part that is forgotten first.

A record is never edited to reflect a change of mind. A decision that is
superseded gets a new record, and the old one is marked as superseded by it.

| #                                                | Decision                                                       | Status   |
| ------------------------------------------------ | -------------------------------------------------------------- | -------- |
| [0001](0001-monorepo-with-pnpm-and-turborepo.md)  | A pnpm workspace monorepo built by Turborepo                   | Accepted |
| [0002](0002-layered-packages-over-a-framework.md) | Layering enforced by package boundaries, not by convention      | Accepted |
| [0003](0003-postgres-as-the-only-datastore.md)    | Postgres is the only datastore                                  | Accepted |
| [0004](0004-drizzle-with-hand-written-sql.md)     | Drizzle ORM with hand-written SQL migrations                    | Accepted |
| [0005](0005-transactional-enqueue-over-outbox.md) | Transactional enqueue instead of an outbox table                | Accepted |
| [0006](0006-state-machine-enforced-three-times.md)| The notification state machine is enforced three times          | Accepted |
| [0007](0007-at-least-once-delivery.md)            | At-least-once delivery, not exactly-once                        | Accepted |
| [0008](0008-provider-port-and-stub.md)            | A provider port, and a stub built before the adapter            | Accepted |
| [0009](0009-session-cookies-for-the-dashboard.md) | Hand-rolled session cookies for the dashboard                   | Accepted |
| [0010](0010-api-key-format-and-hashing.md)        | Split API keys hashed with a keyed hash                         | Accepted |
| [0011](0011-idempotency-keys.md)                  | Idempotency keys with a twenty-four hour window                 | Accepted |
| [0012](0012-gcra-rate-limiting-in-postgres.md)    | Rate limiting by GCRA inside Postgres                           | Accepted |
| [0013](0013-single-origin-behind-caddy.md)        | One origin for the dashboard and the API                        | Accepted |
| [0014](0014-row-level-security-as-a-backstop.md)  | Row level security as a backstop for the public API             | Accepted |
| [0015](0015-a-vite-single-page-application.md)    | A Vite single page application rather than Next.js              | Accepted |
| [0016](0016-ambient-concerns-as-ports.md)         | Clock, randomness and identifiers are ports                     | Accepted |
| [0017](0017-webhook-ingestion-and-inbox.md)       | Webhooks are verified, stored, and processed asynchronously     | Accepted |
| [0018](0018-no-else-and-no-abbreviations.md)      | No `else`, and no abbreviated identifiers                       | Accepted |
