# 0007 — At-least-once delivery, not exactly-once

Status: Accepted

## Context

WAHA's send endpoint accepts no idempotency key. A worker can therefore be
killed after WhatsApp has accepted a message but before the outcome is
committed, and on restart there is no way to ask the provider "did you already
accept this one?" with certainty.

Every design that claims exactly-once on top of an API like that is claiming
something it cannot deliver.

## Decision

At-least-once delivery with strong duplicate suppression, stated plainly rather
than hidden.

1. **Claim before send.** A compare-and-swap moves `QUEUED` or `RETRYING` to
   `PROCESSING`. Zero rows means another worker owns it, and the handler
   completes the job successfully rather than throwing. This eliminates
   concurrent double sends entirely, and it does not depend on any queue-level
   uniqueness guarantee.
2. **Consume the attempt budget before the network call.** `beginAttempt`
   increments the attempt count and writes an attempt row with no outcome, and
   commits, before the provider is contacted. After a crash there is durable
   evidence that a request may have reached WhatsApp.
3. **Decide what an unknown outcome means, per application.**
   `unknown_outcome_policy` is `RETRY` — accept a possible duplicate rather than
   a possible silent loss — or `FAIL_CLOSED`, for tenants who would rather miss
   a message than send it twice.
4. **A unique index on `(whatsapp_session_id, provider_message_id)`** as the last
   line of defence.

## Consequences

- The README, the dashboard and this record all say at-least-once. A reader is
  never told the system guarantees something it does not.
- `FAIL_CLOSED` is a genuine choice with a genuine cost, and the failure it
  produces says exactly why the message was not retried.
- The window is narrow but real: it is bounded by the time between the provider
  accepting a message and the worker committing the outcome.
