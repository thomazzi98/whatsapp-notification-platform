# 0014 — Row level security as a backstop for the public API

Status: Accepted

## Context

Tenant isolation already has two mechanisms. Every repository scopes its queries
by `application_id`, and composite foreign keys make a cross-tenant reference
structurally impossible to write.

Neither helps against the one mistake that is easy to make and invisible in
review: a query that simply forgets the predicate. That bug returns another
tenant's data with no error anywhere.

## Decision

A `platform_tenant` role that **cannot log in**, and row level security policies
keyed on a transaction-local setting.

Every API-key authenticated notification request runs inside `withTenantScope`,
which opens a transaction, issues `SET LOCAL ROLE platform_tenant` and
`set_config('app.current_application_id', …, true)`, and runs the work there.
Both settings are transaction-local, so a pooled connection cannot carry the
role or the tenant identity into whatever runs on it next — which is exactly why
session-level `SET ROLE` behind a pool is unsafe.

The policy on each table carrying `application_id` reads: unless the current
role is `platform_tenant`, this is unrestricted; if it is, the row must belong to
the application in scope. The predicate covers `WITH CHECK` as well, so a write
aimed at another tenant is refused rather than accepted.

The tenant role is granted the narrowest set of privileges that serves the public
API. It has no access at all to users, organisations, sessions, API keys, the
webhook inbox or the rate limit buckets: a table the role cannot reach needs no
policy to protect it.

## Consequences

- A forgotten `WHERE` clause on the notification surface returns nothing rather
  than another tenant's rows. An integration test proves it with a deliberately
  unscoped `SELECT`.
- Work that legitimately spans applications — the worker, which dispatches for
  every tenant, and the dashboard, which is authorised by organisation
  membership — keeps running as the login role and is unaffected.
- This is a backstop, **not** the primary control. The repositories still scope
  every query. Anything that runs outside `withTenantScope` is protected by the
  application-level scoping alone, and `/v1/applications/current` is one such
  route: it reads a single row already keyed by both the organisation and the
  application taken from the authenticated key.
- The bootstrap step grants the login role the right to assume the tenant role,
  on every start rather than once at database creation, so an installation that
  predates the role does not end up with a database its API cannot serve from.

## Alternatives considered

**Forcing row level security on the owner and giving the login role a bypass.**
Rejected: a runtime role holding `BYPASSRLS` reads, correctly, as the control
being decorative.

**A second login role and a second connection pool.** Rejected: it adds a
connection string and a password to configuration for the same guarantee that a
non-login role reached through `SET LOCAL ROLE` provides, and a misconfigured
pool would fail in a much less obvious way.
