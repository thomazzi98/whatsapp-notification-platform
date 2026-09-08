# 0015 — A Vite single page application rather than Next.js

Status: Accepted

## Context

The dashboard is an authenticated operational tool. Nothing in it is public,
indexed, or shared as a link preview, so server-side rendering buys nothing it
would pay for.

Next.js would also introduce a second Node server sitting next to a Nest API,
and an immediate ambiguity about which of the two owns authentication.

## Decision

Vite, React and React Router as a single page application, built to static files
and served by Caddy. TanStack Query owns server state. Tailwind is loaded through
the official Vite plugin.

## Consequences

- One server owns authentication and there is no question about where a session
  is validated.
- The build output is static, so the web container is a file server.
- Polling replaces streaming, adapted to what is on screen: two seconds while a
  QR code is being scanned, thirty while a connection is working, and stopped
  entirely on a terminal state or a hidden tab.
- One subtlety cost a 799 kB bundle: `verbatimModuleSyntax` preserves type-only
  imports as side-effect imports, so the server packages were pulled into the
  browser bundle whole. It is disabled for the web application only, which
  brought the bundle to 309 kB.
