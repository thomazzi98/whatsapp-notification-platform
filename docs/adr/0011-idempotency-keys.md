# 0011 — Idempotency keys with a twenty-four hour window

Status: Accepted

## Context

A client that times out while creating a notification cannot know whether the
notification was created. Without a way to say "this is the same request", the
only safe choice for the client is not to retry — which means a network blip
becomes a lost message.

## Decision

An optional `Idempotency-Key` header, unique per application, following the
contract most integrators already know from payment APIs.

The claim is an `INSERT … ON CONFLICT DO NOTHING` against a fingerprint of the
canonicalised request. Three outcomes:

| Situation                             | Answer                                   |
| ------------------------------------- | ---------------------------------------- |
| Same key, same request, already done  | Replay, with `Idempotent-Replayed: true` |
| Same key, same request, still running | 409 Conflict                             |
| Same key, different request           | 422 Unprocessable Content                |

Keys expire after twenty-four hours.

## Consequences

- The claim commits in the same transaction as the notification, so a failed
  request releases its key instead of poisoning it. See
  [0005](0005-transactional-enqueue-over-outbox.md).
- A different payload under the same key is refused rather than answered with
  the first response. Answering it would hide a client bug that will otherwise
  send the wrong message to someone.
- The fingerprint is canonicalised — keys sorted, optional fields normalised —
  so a semantically identical retry with different key order still matches.
- In-flight is a 409 rather than a blocking wait. Holding the connection open
  has no clean timeout story and hides the concurrency from the client.
