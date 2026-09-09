# What has been verified, and how

Every claim this repository makes falls into one of four categories. The point
of separating them is that "the tests pass" and "this works against WhatsApp"
are different statements, and a reader deciding whether to trust the service
needs to know which one is being made.

| Label                         | Meaning                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Verified locally**          | Proven by an automated test against a real Postgres, and against the deterministic provider stub rather than WhatsApp. |
| **Verified against WhatsApp** | Exercised once, by hand, against real WAHA and a real WhatsApp account.                                                |
| **Not externally verified**   | Implemented and reasoned about, but nothing outside this repository has confirmed it.                                  |
| **Known limitation**          | A deliberate gap. It is not going to be fixed by a test.                                                               |

A test that passes against the stub says the platform behaves correctly **given
that the provider behaves as modelled**. The stub is modelled on WAHA's NOWEB
engine and was built from its documented and observed responses, but it is our
model of the provider, not the provider.

## The claims

### Delivery

| Claim                                                                      | Status                        | Where                                                                    |
| -------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| A notification is persisted and queued before the API answers              | Verified locally              | `apps/api/src/public-api/notifications.integration.test.ts`              |
| A message reaches a real WhatsApp account and reports DELIVERED            | **Verified against WhatsApp** | Once, by hand: provider message id `3EB0F0F0F2AFE8A2E3D436`              |
| The queue enqueue commits with the notification, or neither happens        | Verified locally              | `packages/queue/src/transactional-enqueue.integration.test.ts`           |
| Two workers racing the same notification send it once                      | Verified locally              | `apps/worker/src/jobs/notification-dispatch.integration.test.ts`         |
| A worker that loses its claim mid-send does not report the send as its own | Verified locally              | Same file; the stub holds the send open while the reaper takes the claim |
| Acknowledgement ordering (out of order, repeated, missing READ)            | Verified locally              | `apps/worker/src/jobs/webhook-process.integration.test.ts`               |
| The ack matrix is the same on the WEBJS engine                             | **Known limitation**          | Only NOWEB has been used. Switching engines requires re-validating it    |
| Delivery is exactly-once                                                   | **Known limitation**          | It is not. See "The delivery guarantee" below                            |

### Failure and recovery

| Claim                                                         | Status                      | Where                                                                             |
| ------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| A transient provider failure is retried on the backoff curve  | Verified locally            | `notification-dispatch.integration.test.ts`                                       |
| A permanent provider rejection is not retried                 | Verified locally            | Same file, and `packages/provider-whatsapp/src/waha-provider.integration.test.ts` |
| A provider `Retry-After` raises the floor of the next attempt | Verified locally            | The stub sends the header; the assertion is bounded on both sides                 |
| The attempt budget is enforced and terminates                 | Verified locally            | `notification-dispatch.integration.test.ts`                                       |
| An abandoned claim is reaped and the notification requeued    | Verified locally            | Same file                                                                         |
| A dead-lettered notification is reported at error level       | Verified locally            | `apps/worker/src/jobs/job-runner.service.test.ts`                                 |
| The worker drains in-flight work on SIGTERM, and is bounded   | Verified locally            | `apps/worker/src/graceful-shutdown.integration.test.ts`                           |
| Postgres going away is survived and reported                  | Verified locally            | Readiness probes; also exercised by hand by stopping the container                |
| WAHA going away does not take the API down                    | Verified locally            | `/ready` reports the provider as informational only                               |
| Behaviour under a real WAHA outage, or a WhatsApp ban         | **Not externally verified** | Neither has been provoked against the real provider                               |

### Isolation and security

| Claim                                                        | Status                      | Where                                                                   |
| ------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------- |
| A tenant cannot read or write another tenant's rows          | Verified locally            | `packages/database/src/tenant-isolation.integration.test.ts`            |
| The request path enters the tenant role, so RLS is not inert | Verified locally            | `apps/api/src/public-api/tenant-scope.integration.test.ts`              |
| A cross-tenant reference cannot be written                   | Verified locally            | Composite foreign keys; `notification-status-guard.integration.test.ts` |
| An API key is stored only as a peppered HMAC and shown once  | Verified locally            | `packages/security`, `tenancy.integration.test.ts`                      |
| A callback is rejected unless signed, fresh and unaltered    | Verified locally            | `apps/api/src/public-api/webhooks.integration.test.ts`                  |
| No credential is in the working tree or in git history       | Verified locally            | `pnpm verify:secrets`, which scans every commit                         |
| Secrets and message content stay out of logs                 | Verified locally            | `packages/observability/src/logger.test.ts`                             |
| The constant-time comparison is constant-time                | **Not externally verified** | A property of `timingSafeEqual`; nothing stops it being replaced        |
| Resistance to a determined attacker                          | **Not externally verified** | No penetration test, no external review                                 |

### The contract

| Claim                                                    | Status               | Where                                                               |
| -------------------------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| The documented statuses are the statuses the API returns | Verified locally     | `packages/contracts/src/openapi.test.ts` asserts them per operation |
| Request and response bodies match the document           | Verified locally     | The document is generated from the schemas that validate requests   |
| A consumer needs only a base URL and an API key          | Verified locally     | `apps/api/src/public-api/consumer-contract.integration.test.ts`     |
| No provider vocabulary reaches a consumer                | Verified locally     | Same file                                                           |
| Backwards compatibility across versions                  | **Known limitation** | There is one version and no deprecation policy                      |

### Performance

| Claim                                      | Status                      | Where                                                            |
| ------------------------------------------ | --------------------------- | ---------------------------------------------------------------- |
| The measured latencies in `performance.md` | Verified locally            | One laptop, sequential, single client                            |
| Behaviour under concurrency or at volume   | **Not externally verified** | No load test. The largest table measured held a few hundred rows |
| Provider latency                           | **Not externally verified** | Every number is the stub's, which is deterministic by design     |

## The delivery guarantee

**At-least-once, with strong duplicate suppression. Not exactly-once.**

WAHA's send endpoint accepts no idempotency key, so a worker that crashes after
WhatsApp accepts a message but before the outcome commits cannot know what
happened. Four things narrow that window, and none closes it:

1. The claim is a compare-and-swap, so concurrent workers cannot both send.
2. The attempt is recorded and committed **before** the provider is contacted,
   so a crash leaves durable evidence that a request may have been made.
3. On re-entry an unresolved attempt is resolved against the chat history before
   anything is resent.
4. The send ledger and the SENT row commit together, so a crash cannot leave an
   attempt marked successful on a notification that will be retried.

The history reconciliation in step 3 is a heuristic with both false-positive and
false-negative modes. A tenant who would rather miss a message than send it
twice can set the unknown-outcome policy to `FAIL_CLOSED`.

Claiming exactly-once on top of a provider API that is not idempotent would be
false, so it is not claimed anywhere.

## What "verified locally" costs

The integration suite runs against a real Postgres in a container, applying the
real migrations. It does not run against real WAHA, and the end-to-end suite
drives the production container images against the stub. So:

- Anything about SQL, transactions, constraints, row level security and the
  queue is verified against the real engine.
- Anything about WhatsApp's behaviour is verified against our model of it.

The one exception is the manual check recorded above, which is what confirms the
model is not wrong about the path that matters most.
