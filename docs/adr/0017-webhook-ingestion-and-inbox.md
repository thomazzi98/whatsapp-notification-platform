# 0017 — Webhooks are verified, stored, and processed asynchronously

Status: Accepted

## Context

Delivery receipts arrive as webhooks. They are the only source of truth for
whether a message actually reached a device, they arrive out of order, they
repeat, and the endpoint that receives them is reachable by anything that can
reach the API.

Doing the work inside the request would make the provider wait on our database
and would let a slow processing step turn into a redelivery storm.

## Decision

The endpoint verifies, stores and returns. Nothing else.

1. A route-scoped content type parser retains the raw bytes. The HMAC-SHA512
   signature is verified over exactly those bytes — verifying a re-serialised
   object compares a different message than the one that was signed.
2. The comparison is constant-time and length-guarded.
3. A timestamp outside the tolerance is rejected, so a captured delivery cannot
   be replayed indefinitely.
4. The delivery is inserted into an inbox with `ON CONFLICT DO NOTHING`, keyed by
   the provider's event identifier, and a job is enqueued. The response is a
   fast 2xx.

The worker applies it. Acknowledgement levels merge by maximum, so a receipt
arriving out of order can never move a notification backwards. A receipt for a
notification that does not exist yet is retried for sixty seconds — the send
transaction may still be committing — and recorded as unmatched after that,
rather than being lost or retried forever.

## Consequences

- The provider sees a fast, honest acknowledgement, and processing failures are
  retried by the queue rather than by the provider.
- Duplicate deliveries are free: the inbox insert simply does nothing.
- A missing read receipt is not a failure. Recipients can turn read receipts off,
  and the dashboard says so in place of showing an error.
