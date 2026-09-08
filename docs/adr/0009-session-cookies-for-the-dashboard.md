# 0009 — Hand-rolled session cookies for the dashboard

Status: Accepted

## Context

The dashboard needs sign-in for humans. The API needs bearer keys for machines.
These are different problems and they are best not merged.

Off-the-shelf authentication libraries in this ecosystem bring their own
database migrations, their own schema, and often their own opinion about the
ORM — which puts them in direct conflict with a schema that is already
hand-written and already carries tenant constraints.

## Decision

An opaque 256-bit session token, stored hashed, in a cookie that is
`HttpOnly`, `SameSite=Lax`, and `Secure` outside local development. Passwords
are hashed with Argon2id at OWASP's baseline parameters. State-changing
dashboard requests carry a double-submit CSRF token.

Rolling *session management* is a few hundred lines of well-understood code.
Rolling cryptography or an identity protocol would not be, and neither is here:
Argon2id comes from `@node-rs/argon2`, and token generation from `node:crypto`.

## Consequences

- One migration system, one schema, one source of truth about users.
- The token is opaque, so signing out is a delete rather than a hope that a
  self-contained token expires soon.
- No social sign-in, no multi-factor authentication, no password reset by email —
  the last of which needs an email provider this project deliberately does not
  have. These are named as gaps in the README rather than implied to exist.

## Alternatives considered

**A JSON Web Token in local storage.** Rejected twice over: it is reachable from
script, and revocation requires a server-side list, which is the thing the
format was chosen to avoid.
