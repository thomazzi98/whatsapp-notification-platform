# 0019 — Stop sending through a WhatsApp restriction, and run the WEBJS engine

Status: Accepted

## Context

The number the platform sends from was restricted again and again, at a handful
of messages a day. WhatsApp limits accounts that start conversations with people
who never wrote to them, and a notification platform does exactly that. It has
two limits, and neither disconnects anything: the session keeps reporting
`WORKING` while messages are refused.

- The **reachout timelock** (error 463) refuses every message to a new contact
  for hours or days. Refusals repeated through it are what turn it into a ban.
- The **quota of new chats** (error 475) refuses messages to new contacts once a
  monthly allowance of messages to people who have not replied is used up.

The platform knew of neither. A refused message was retried as a server error,
and the natural reaction to a number that stopped working — unpair it, scan
again — restarts a restriction rather than lifting it. WAHA 2026.8 reports both
limits: with the session, live from WhatsApp, and by repeating the session's
status when they change. Its documentation says a bot should only reply to
people who wrote first, and that a restricted session must not be restarted or
paired again.

The engine mattered too. NOWEB, which the platform ran, is a websocket client
built on Baileys; WAHA asks that its guide to avoiding blocks be read before
using it, and websocket clients have refused ordinary messages as reach-outs
when they mishandled WhatsApp's contact tokens. WEBJS runs WhatsApp Web itself
in a headless browser, and is the engine WAHA documents as the one that avoids
blocking.

## Decision

The connection carries what WhatsApp enforces on its account and a pause that
follows from it.

- **Only the timelock pauses a connection**, until WhatsApp says it ends, or for
  `DELIVERY_RESTRICTION_FALLBACK_PAUSE_HOURS` when a message was refused and
  nothing says for how long. Nothing at all is sent from a paused connection:
  the platform cannot tell a new contact from an old one, and one more refusal
  is the risk being avoided.
- **The quota pauses nothing.** It refuses only new contacts and lasts until a
  cycle that can be weeks away resets, so a refusal fails just the one
  notification, and the dashboard shows the warnings WhatsApp gives before it.
- **A refused message is never retried.** 463 becomes `connection_restricted`
  and 475 `new_chat_quota_exceeded`, both permanent.
- **A pause is only ever extended**, in the statement that records it, and ends
  when its time runs out and WhatsApp confirms it.
- **A notification a pause will release in time waits** as `connection_paused`,
  costing no attempt; one the pause outlasts fails as `connection_restricted`,
  rather than going out hours late in a burst.
- **The restriction is learned as early as it can be:** from the status WAHA
  repeats, from the cached report that comes with every session lookup
  (refreshed at most every ten minutes per connection), and from a refused send.
  A delivery that fails afterwards, which is how a refusal usually surfaces on
  the browser and websocket engines, makes the next send ask WhatsApp afresh.
- **The dashboard tells the operator not to re-pair the number.**

The provider runs WEBJS, and before each send shows "typing…" for about as long
as a person would take to write the message, as WAHA recommends.

Sending stays open to anyone. Requiring that recipients write first was offered
and declined: the platform's recipients are not people who can be asked to.

## Consequences

- A restricted number stops sending, for hours or days, including to people it
  could still have reached. That is the price of never adding a refusal to the
  account's record.
- With open sending, restrictions will still happen. The platform makes them
  survivable rather than impossible. The one free measure that avoids them is
  recipients writing to the number first, and the dashboard offers the link.
- WEBJS needs a browser: more memory per connection, a slower start, and shared
  memory for Chromium. Changing engine means pairing again.
- The stub answers as WEBJS does and can still answer as NOWEB, so both readings
  of a send stay tested, and it models the timelock, the quota and both
  refusals. Which of WAHA's signals WEBJS sends, and in what shape, remains a
  required check against a real account (ADR 0008).

## Alternatives considered

**The official WhatsApp Business Platform.** It carries no ban risk for
automation, and the public API could stay as it is, with the body sent as a
parameter of an approved template. Rejected for now because it is paid per
message for anything the business starts, and the platform has to remain free.
It is the next step if restrictions stay intolerable, and the `provider` column
on a connection is where a second adapter would be chosen.

**Requiring recipients to write first.** The most effective free measure, and
WAHA's own advice. Declined because the platform notifies people who cannot be
asked to; it remains the operator's choice, per recipient.

**Another unofficial client** — Evolution API, Baileys directly, wppconnect,
whatsmeow. Each links to the account as a companion device the same way and
falls under the same limits.

**Keeping NOWEB, updated.** No re-pairing, but it keeps the engine whose
reach-out handling had already gone wrong once.
