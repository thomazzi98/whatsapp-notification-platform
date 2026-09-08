# 0004 — Drizzle ORM with hand-written SQL migrations

Status: Accepted

## Context

The schema carries load-bearing constraints: composite foreign keys that make a
cross-tenant reference impossible, partial indexes for the queue-shaped queries,
a trigger that refuses illegal status transitions, and now row level security
policies. None of those are expressible in a portable model-first schema
language.

The build also runs in Docker and in continuous integration, where a code
generation step is one more thing to get wrong.

## Decision

Drizzle ORM for queries, with migrations kept as reviewable SQL files under
`packages/database/migrations`. Drizzle generates the first draft of a
migration; anything the generator cannot express is written by hand in the same
file.

## Consequences

- A migration is a diff a reviewer can read. `0002_notification_status_transition_guard.sql`
  is a trigger and a table, not an opaque instruction to a tool.
- No code generation step in the Docker build or in continuous integration.
- The schema exists twice — as TypeScript and as SQL — so it can drift. Tests
  close the specific drifts that matter: one asserts the database's transition
  table deep-equals the TypeScript one, another asserts every table carrying a
  tenant key has a row level security policy.
- Migrations are forward-only. There is no `down`, because a down migration that
  has never been run is not a rollback plan, it is a comforting fiction.

## Alternatives considered

**Prisma.** Rejected: at the time of the decision its CLI `latest` tag pointed at
a major version ahead of the client, and its migration model fits less well with
triggers and policies that have to be written by hand anyway.

**Raw SQL with no query builder.** Rejected: the type safety at the call site is
worth the dependency, particularly where a repository returns a record the rest
of the system depends on structurally.
