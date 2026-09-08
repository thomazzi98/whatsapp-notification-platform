# syntax=docker/dockerfile:1.7-labs

# Builds the dashboard and serves it from the same origin as the API.
#
# The result is a static bundle behind a file server, not a Node process: the
# dashboard renders in the browser and talks to the API over the same origin,
# so a second server would only add something else to run and to patch.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable
WORKDIR /repository

FROM base AS build
# Manifests first, so a source change does not invalidate the install layer.
COPY --parents package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --parents packages/*/package.json apps/*/package.json tools/*/package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json turbo.json eslint.config.mjs ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools

# The dashboard depends on the workspace packages for their types alone, but
# the types have to exist to be checked against.
RUN pnpm --filter "@platform/web..." build

FROM caddy:2.10-alpine AS runtime
COPY docker/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repository/apps/web/dist /srv
EXPOSE 8080
