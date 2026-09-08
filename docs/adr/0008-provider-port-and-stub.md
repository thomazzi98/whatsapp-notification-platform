# 0008 — A provider port, and a stub built before the adapter

Status: Accepted

## Context

WAHA is an unofficial WhatsApp gateway. Its response shapes vary by engine, it
has no rate limiter, and the account behind it can be banned. Coupling the
notification rules to it would make every one of those properties a property of
the domain.

Testing against it is worse: it needs a phone, a scannable code, and an account
that a test suite can get banned.

## Decision

The domain depends on a `WhatsAppProviderPort`. `packages/provider-whatsapp`
implements it against WAHA, and `tools/waha-stub` implements the WAHA subset the
adapter uses, deterministically, in a small Fastify application.

The stub was built **before** the adapter, so the adapter had a target from its
first line, and so the entire pipeline — connect, send, deliver, receive the
receipt — is exercisable with no phone and no browser engine.

## Consequences

- Continuous integration runs the whole delivery path. Real WAHA and real
  WhatsApp are excluded from it by design.
- The stub must model the provider's awkwardness, not an idealised version of
  it. When real WhatsApp exposed that the send response and the delivery receipt
  report *different* message identifiers, the stub was changed to reproduce that
  mismatch, so the class of bug now fails locally.
- A stub that encodes the same wrong assumption as the adapter proves nothing.
  That is exactly what happened once, and it is why the real-WhatsApp check
  remains a required step rather than a formality.

## Alternatives considered

**Recording real traffic and replaying it.** Rejected as the primary mechanism:
fixtures cannot produce the failure modes — timeout, connection reset, session
not ready — that most of the retry logic exists to handle. Real captured
payloads are used as fixtures *in addition*, to keep the parsers honest.
