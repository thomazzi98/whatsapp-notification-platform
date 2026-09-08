# 0006 — The notification state machine is enforced three times

Status: Accepted

## Context

A notification moves through eight states. Two independent actors change it: the
worker, which dispatches, and the webhook processor, which applies delivery
receipts. They race by design — a receipt can arrive before the send transaction
commits.

A single guard in application code is not enough, because the guard is only
consulted by the code paths that remember to consult it.

## Decision

The same transition table is enforced at three levels.

1. **The aggregate.** `transitionTo()` asserts against the table. There is no
   setter, so there is no path that skips it.
2. **The repository.** Every write is a compare-and-swap:
   `UPDATE … WHERE id = $1 AND status = $expectedFrom`. Zero rows means someone
   else moved it first, which is a result, not an exception.
3. **The database.** A trigger reads a `notification_status_transitions` table
   and raises on an illegal change, so a `psql` session or a data-fix migration
   cannot bypass the rule either.

Two exclusions are deliberate. There is no `FAILED → QUEUED`: a retry creates a
new row that points at the original, which keeps the audit trail honest. There
is no `PROCESSING → CANCELLED`: the provider call may be in flight and a sent
message cannot be recalled, so cancelling one answers 409.

`READ` is not a state. A read receipt sets `read_at` and leaves the status at
`DELIVERED`, which stays terminal.

## Consequences

- The webhook and worker race resolves without locks: whichever commits first
  wins and the other observes zero rows.
- Writing a test fixture is harder, because the database refuses to fabricate a
  notification in a state it could not have reached. That is a feature, and it
  caught a test that tried to shortcut `QUEUED → SENT`.
- The transition table exists in TypeScript and in SQL. A test asserts they are
  identical.
