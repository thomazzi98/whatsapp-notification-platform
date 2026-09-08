# 0013 — One origin for the dashboard and the API

Status: Accepted

## Context

A dashboard on one origin and an API on another needs cross-origin resource
sharing, a credentialed fetch policy, a cookie that survives being third-party,
and an API base URL compiled into the browser bundle. Every one of those is a
place to get security wrong, and the last one means the bundle has to be rebuilt
to be deployed somewhere else.

## Decision

Caddy serves the built single page application and reverse-proxies `/v1`,
`/dashboard` and `/webhooks` to the API. One origin.

## Consequences

- The session cookie is first-party, so `SameSite=Lax` works as intended.
- There is no cross-origin configuration to get wrong, because there is no
  cross-origin request.
- The browser bundle contains no API URL. It talks to the origin it was served
  from, so the same artefact runs locally and anywhere else.
- Port 3100 still reaches the API directly, which is convenient for `curl` and
  for the API key surface, and is not what the dashboard uses.
- Caddy is one more container. It earns its place by removing an entire class of
  configuration.
