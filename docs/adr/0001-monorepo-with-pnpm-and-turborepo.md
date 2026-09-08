# 0001 — A pnpm workspace monorepo built by Turborepo

Status: Accepted

## Context

The platform is three deployable processes — an HTTP API, a queue worker and a
dashboard — that share a domain model, a set of contracts and a database schema.
The API and the worker must run exactly the same business rules; if they drift,
a notification means one thing when it is accepted and another when it is sent.

Two repositories with a published shared library would keep them in step only as
fast as someone remembers to release and upgrade it.

## Decision

One repository, pnpm workspaces for resolution, Turborepo for task orchestration
and caching. Dependency versions are declared once in the workspace catalog, so
two packages cannot end up on different versions of Zod or Drizzle.

## Consequences

- A change to a domain rule and the three call sites that use it land in one
  commit and are reviewed together.
- `pnpm build` is topological and cached, so a change to the dashboard does not
  rebuild the worker.
- Task graphs have to be declared correctly. A lint task that reads types has to
  declare `dependsOn: ["^build"]`, or it passes locally against stale artefacts
  and fails on a clean checkout. This was found the hard way, in continuous
  integration.
- Every package must declare what it uses. That is a feature: it is the
  strongest of the three mechanisms that keep the layering honest, because a
  package that does not depend on Drizzle cannot import it.

## Alternatives considered

**Separate repositories with a published shared library.** Rejected: the release
cycle becomes the bottleneck for every cross-cutting change, and the API and the
worker would inevitably run different versions of the same rules.

**A single application with no package boundaries.** Rejected: the boundary
between the domain and the WhatsApp provider is the point of the design. Without
package boundaries it survives only as long as everyone remembers it.
