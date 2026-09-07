# syntax=docker/dockerfile:1.7-labs

# One parameterised build shared by every Node service in the monorepo.
# PACKAGE_NAME selects which workspace package is built and deployed, so the
# base, dependency and build layers are shared across images instead of being
# rebuilt per service.

ARG NODE_IMAGE=node:24-bookworm-slim

# Debian rather than Alpine: @node-rs/argon2 and Tailwind's Oxide binary ship
# glibc prebuilds, and the musl variants are a reliable afternoon lost.
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV CI=true
RUN corepack enable
WORKDIR /app

# Manifests only, so the install layer is reused whenever source changes but
# dependencies do not. --parents preserves each package.json's path, which
# means adding a workspace package does not require editing this file.
FROM base AS dependencies
COPY --parents package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents packages/*/package.json apps/*/package.json tools/*/package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

FROM dependencies AS build
ARG PACKAGE_NAME
COPY . .
RUN pnpm --filter "${PACKAGE_NAME}..." build
# `--legacy` is required because this workspace does not set
# inject-workspace-packages; without it the deployed node_modules is empty.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm deploy --filter "${PACKAGE_NAME}" --prod --legacy /output

FROM ${NODE_IMAGE} AS runtime
ARG PACKAGE_NAME
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /output /app
USER node
