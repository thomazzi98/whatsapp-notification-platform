# 0016 — Clock, randomness and identifiers are ports

Status: Accepted

## Context

Retry backoff uses jitter. Scheduling compares against the current time.
Identifiers are UUIDv7, which embeds a timestamp. All three read ambient state,
and all three are on paths whose correctness has to be provable.

Testing them by freezing global timers works until two tests need different
times, or until a library caches a timer reference before the fake is installed.

## Decision

`ClockPort`, `RandomPort` and `IdentifierGeneratorPort` are interfaces plus
symbol tokens exported from the domain. Production implementations live in
`packages/security` over `node:crypto`. Tests pass explicit values.

## Consequences

- Backoff, jitter, scheduling and pacing are ordinary pure functions to test. The
  equal-jitter calculation is asserted at its exact bounds rather than sampled.
- The domain has no import from `node:crypto` and no global state.
- Every service that needs the time has one more constructor parameter. That is
  the visible cost, and it is small next to a test suite that cannot flake on
  timing.
- UUIDv7 is generated rather than taken from a library: Node has no built-in
  generator, and time-ordered keys keep primary key inserts appending at the
  right edge of the index rather than scattering across it.
