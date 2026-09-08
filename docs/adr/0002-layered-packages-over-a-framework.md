# 0002 — Layering enforced by package boundaries, not by convention

Status: Accepted

## Context

The notification rules must not depend on WhatsApp. That is easy to say in a
review and hard to keep true over months: one `import` from a controller into a
database repository, and the layering is decoration.

## Decision

Layering is expressed as package dependencies and enforced three times over:

```
domain            → zod only
contracts         → domain
database, queue, provider-whatsapp → domain plus their own infrastructure
composition       → the adapters plus @nestjs/*
apps/*            → composition and contracts, never an adapter directly
```

1. **Dependency declaration.** `packages/domain/package.json` declares only Zod.
   Drizzle and the WhatsApp client are not resolvable from inside it.
2. **`dependency-cruiser`**, run as a `verify:layers` task in continuous
   integration, which catches the cases a manifest cannot express.
3. **TypeScript project references**, so a stray import fails to compile.

Ports are an `interface` plus a `Symbol` token exported from `domain`. The symbol
is usable directly as a dependency injection token, which is how the domain
stays free of a framework dependency while still being injectable.

## Consequences

- The domain is testable with no database, no queue and no HTTP.
- `composition` exists because one application cannot import another
  application's modules. It is what lets the worker boot the same services as
  the API.
- There is a real cost: a new port means touching four files. That is the price
  of the boundary being enforced rather than believed.

## Alternatives considered

**Folders inside one package, with a linter rule on import paths.** Rejected: it
depends on the rule being configured for every new folder, and it does not stop
a transitive dependency from arriving through the package manager.
