# 0010 — Split API keys hashed with a keyed hash

Status: Accepted

## Context

Every request to `/v1` presents an API key. Authentication is therefore on the
hottest path in the system, and it has to be both fast and safe against an
attacker who has obtained a copy of the database.

Hashing a credential with a deliberately slow function is correct for passwords,
because a password is low entropy and chosen by a human. It is the wrong tool
for a machine-generated secret, and it turns every request into a computation an
attacker can ask for by sending nonsense keys.

## Decision

A token is `wnp_{live|test}_{identifier}{secret}` — a twelve character public
identifier followed by a thirty-two character secret, both drawn from a
rejection-sampled alphanumeric alphabet.

The identifier is stored in clear text and indexed, so authentication is one
indexed lookup. The secret is stored as `HMAC-SHA256(secret, server pepper)`.
The pepper lives in configuration, not in the database, so a stolen database
dump alone does not permit offline verification.

The full token is shown once, at creation, and never again. Listings show the
prefix and the last four characters.

## Consequences

- Authentication is a single lookup and one constant-time comparison. There is
  no per-request key derivation to abuse.
- The environment prefix makes a leaked key recognisable in a log or a paste, and
  makes secret scanning possible.
- Losing the pepper invalidates every key at once. That is the correct trade for
  a value that turns a database dump into a usable credential set, and it is
  stated in the runbook.

## Alternatives considered

**Argon2 over the whole token.** Rejected: it makes every request pay a key
derivation, and it gives no benefit for a thirty-two character random secret.

**A plain SHA-256 with no key.** Rejected: it leaves a stolen database directly
verifiable offline, and the pepper costs nothing to add.
