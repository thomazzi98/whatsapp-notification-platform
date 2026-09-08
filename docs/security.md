# Security

What this platform defends against, how, and what it deliberately does not
defend against. The last section is the honest one: it lists what a review found
and what was done about it.

## What is worth attacking

The platform holds three things an attacker wants.

**Other tenants' messages.** Notification bodies and recipient phone numbers are
personal data belonging to someone who never agreed to be in this system.

**Credentials.** API keys grant the ability to send WhatsApp messages from a real
number. The pepper that protects them, the key that encrypts webhook signing
keys, and the database password all sit in configuration.

**The WhatsApp connection itself.** A paired account can be used to send anything
to anyone, and abusing it gets the number banned — which is a denial of service
against the operator that no amount of retrying fixes.

## Two authentication surfaces, deliberately separate

| Surface      | Credential                             | Used by             |
| ------------ | -------------------------------------- | ------------------- |
| `/v1`        | `Authorization: Bearer wnp_live_…`     | Integrating systems |
| `/dashboard` | Session cookie plus a CSRF token       | People              |
| `/webhooks`  | HMAC-SHA512 over the raw request bytes | The provider        |

Session _lifecycle_ endpoints — start a connection, fetch a QR code — exist only
on the dashboard surface. Starting a WhatsApp session requires a human to scan a
code, so exposing it to API keys would create a workflow that cannot complete.

### API keys

A key is `wnp_{live|test}_{identifier}{secret}`. The identifier is public and
indexed; the secret is stored as `HMAC-SHA256(secret, pepper)` where the pepper
lives in configuration, never in the database. Authentication is one indexed
lookup and one constant-time comparison — no per-request key derivation an
attacker could ask for in bulk.

The full key is shown once. Listings show the prefix and the last four
characters, which is enough to recognise a key and useless for using one.
Reasoning in [ADR 0010](adr/0010-api-key-format-and-hashing.md).

### Dashboard sessions

An opaque 256-bit token, stored as a SHA-256 digest, in a cookie that is
`HttpOnly`, `SameSite=Lax` and `Secure` outside local development. Passwords are
Argon2id at OWASP's baseline parameters, and a malformed stored hash denies
access rather than throwing, so a corrupt row cannot turn every sign-in into a 500.

Sessions have both a hard lifetime and a sliding idle timeout. The hard lifetime
is never extended, so a stolen session expires on a schedule the attacker cannot
influence.

CSRF tokens are an HMAC over the session identifier rather than stored state, so
there is nothing to expire or to get out of step with the session.

Sign-in is rate limited per IP address, separately from the API limiter, because
the thing being protected is a password rather than capacity.

### Webhooks

The signature is verified over the exact bytes received. A route-scoped Fastify
content type parser retains the raw `Buffer` precisely for this: verifying a
re-serialised object compares a different message than the one that was signed.
The comparison is constant-time and length-guarded, and a timestamp outside the
tolerance window is refused, because a signature that never expires is a replay
waiting to happen.

## Tenant isolation, three deep

1. **Every repository query is scoped by `application_id`.** This is the primary
   control.
2. **Composite foreign keys.** `notifications(application_id, whatsapp_session_id)`
   references `whatsapp_sessions(application_id, id)`, so a row referencing
   another tenant's session cannot be written at all. This is not a check that
   runs; it is a shape the data cannot take.
3. **Row level security.** API-key authenticated notification requests run as a
   role that cannot log in, entered with `SET LOCAL ROLE` inside the request's
   transaction, and see only rows belonging to the application in scope. A
   forgotten `WHERE` clause returns nothing rather than another tenant's data.
   [ADR 0014](adr/0014-row-level-security-as-a-backstop.md) explains why the
   settings are transaction-local and what is _not_ covered.

An integration test proves the third with a deliberately unscoped `SELECT`, an
`INSERT` aimed at another tenant, and an assertion that every table carrying a
tenant key is covered by a policy.

## Secrets

Four values have no safe default and the process refuses to boot without them:
the API key pepper, the encryption key, the cursor signing key, and the log
recipient salt. `pnpm setup:env` generates them.

They are never logged. pino redacts credentials by name in both top-level and
one-level-nested forms, and the redaction list also covers message bodies,
recipients, template variables and QR codes — customer data belongs in the
tenant-scoped dashboard, not in a log aggregator where retention and access
control are weaker. Phone numbers reach logs only as a salted hash and a masked
form.

Errors are reduced before they are logged, to type, message, code, stack and
cause. The driver's error object carries its whole client — connection
parameters, socket state — and pino's default serializer copies every own
property, so a database restart used to write the host and the role it connects
as into the log repeatedly.

Nothing but `.env.example` is committed, and it contains placeholders. The
`.dockerignore` excludes `.env` from every image.

## The provider is infrastructure, not a boundary

WAHA holds a paired WhatsApp account and its API has no per-tenant
authorisation: anything that can reach it can send as that number. It is
therefore never published to the network in the default setup, and the platform
treats it as an untrusted dependency in the other direction too — its responses
are parsed with an explicit schema, and an unrecognised shape becomes
`provider_response_unreadable` rather than an assumption.

## At the edge

Caddy sets `X-Content-Type-Options`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, and a content security policy
that names exactly what the dashboard loads — which is only itself. `Server` is
removed. There is no `Strict-Transport-Security`, on purpose: the default setup
is HTTP on the loopback interface, and an HSTS header there would be both untrue
and difficult to undo.

There is no CORS configuration, because there is no cross-origin request. See
[ADR 0013](adr/0013-single-origin-behind-caddy.md).

Containers run as a non-root user. Host ports are bound to `127.0.0.1` and
shifted off the defaults.

## Input handling

Every request body, query and parameter is parsed by a Zod schema before a
handler sees it, and the parsed value — not the raw one — is what the handler
receives. Errors are RFC 9457 problem documents, and a validation failure names
the field rather than echoing the value.

Two specific cases are worth calling out. An invalid API key is never quoted in
an error or a log, because a failed credential is still a credential. Pagination
cursors are HMAC-signed, so a tampered cursor is rejected rather than turned into
a query nobody intended.

## What a review found, and what was done

The review ran `pnpm audit`, read the history for committed secrets, checked the
browser bundle for leaked configuration, and worked through the surfaces above.

| Finding                                                                                                                                                                                                 | Action                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Three moderate Fastify advisories (`GHSA-w2qp-rph6-63g4`, `GHSA-3m5p-2c4r-xxw2`, and one further), all fixed in 5.12.1. `@nestjs/platform-fastify@11.2.3` pins 5.11.3 exactly and has no newer release. | Fixed. A workspace override lifts the whole tree to 5.12.3, keeping a single copy of Fastify in the process.                                |
| `GHSA-67mh-4wv8-2f99` in esbuild, reached through drizzle-kit's legacy loader. Development only, and the affected code path is a dev server this project never runs.                                    | Fixed rather than accepted: an advisory that is merely unreachable today is one nobody re-reads tomorrow. Overridden to `^0.25.12`.         |
| Tenant isolation relied entirely on application-level scoping. The README and a source comment already described row level security that did not exist.                                                 | Fixed. Policies, a non-login tenant role, `withTenantScope`, and an isolation test.                                                         |
| `@nestjs/swagger` and `nestjs-zod` sat in the dependency catalog, used by nothing.                                                                                                                      | Removed. Unused dependency declarations are attack surface that nobody audits.                                                              |
| A database outage logged the driver's entire client object, including the host and the role it connects as, once per failed query.                                                                      | Fixed. Errors are serialised to type, message, code, stack and cause. Found by stopping Postgres rather than by reading the redaction list. |
| No committed secrets in history; only `.env.example`, which holds placeholders.                                                                                                                         | No action.                                                                                                                                  |
| No configuration in the browser bundle.                                                                                                                                                                 | No action. The single-origin design is what makes this structural rather than lucky.                                                        |

## What is out of scope, and why

These are absences, not oversights. Each is a decision.

- **No password reset.** It needs an email provider, which this project
  deliberately does not have. Recovery is an operator task.
- **No multi-factor authentication and no single sign-on.** Both are real work
  and neither is what this project is demonstrating.
- **No secret rotation with overlap.** Rotating the pepper invalidates every API
  key at once. The runbook says exactly what each rotation breaks.
- **No audit log of dashboard actions.** Notifications have a full timeline;
  "who revoked this API key" is not recorded.
- **No WAF, no bot detection, no IP reputation.** The rate limiter protects
  capacity, and it fails open — a deliberate choice for a self-hosted product
  that would be wrong for a limiter defending a security boundary.
- **The container images are not signed and no software bill of materials is
  published.**

## Reporting

This is a portfolio project rather than an operated service. If you find
something, open an issue.
