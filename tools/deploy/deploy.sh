#!/usr/bin/env bash
#
# Deploys the production stack, or rolls it back.
#
#   tools/deploy/deploy.sh <image-tag>
#
# The deploy workflow runs exactly this over SSH, and a person rolls back by
# running it by hand with an earlier tag, so the automated path and the manual
# one cannot drift apart. IMAGE_REPOSITORY, the registry path the images are
# published under, comes from the environment or from the server's .env.
#
# It never removes a volume. The database and the WhatsApp pairing live there,
# and a failed deploy is fixed by deploying a tag that works, not by deleting
# anything.

set -Eeuo pipefail

readonly TAG="${1:-}"
readonly DEPLOY_DIRECTORY="${DEPLOY_DIRECTORY:-/opt/whatsapp-notification-platform}"
readonly EDGE_SITES_DIRECTORY="${EDGE_SITES_DIRECTORY:-/opt/edge/sites}"
readonly EDGE_SITE_FILE="${EDGE_SITES_DIRECTORY}/whatsapp-notification-platform.caddy"
readonly COMPOSE_FILE="docker-compose.production.yml"
readonly SERVICES_BUILT_HERE=(migrate api worker web)

say() { printf '\n==> %s\n' "$1"; }
fail() {
  printf '\n!!! %s\n' "$1" >&2
  exit 1
}
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# It is interpolated into image references and, for a rollback, typed by a
# person, so anything that is not plainly a tag stops here.
if [[ ! "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "usage: $0 <image-tag>" >&2
  exit 2
fi

# ── Preflight ────────────────────────────────────────────────────────────────
say "Checking the server before touching anything"

cd "$DEPLOY_DIRECTORY" || fail "$DEPLOY_DIRECTORY does not exist. Prepare the server first (docs/runbook.md)."
[[ -f "$COMPOSE_FILE" ]] || fail "$COMPOSE_FILE is missing from $DEPLOY_DIRECTORY."
[[ -f .env ]] || fail ".env is missing. It holds the secrets, is generated on this server, and is never committed."
docker network inspect edge >/dev/null 2>&1 ||
  fail "There is no 'edge' network. It belongs to the proxy that owns ports 80 and 443 here (docs/runbook.md)."

# Values are read out of .env rather than sourced: it is a Compose file, not a
# shell script, and a secret containing a quote or a dollar sign must not run.
read_setting() { sed -n "s/^$1=//p" .env | tail -n 1 | tr -d "\r\"'"; }

IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-$(read_setting IMAGE_REPOSITORY)}"
[[ -n "$IMAGE_REPOSITORY" ]] ||
  fail "IMAGE_REPOSITORY is not set here or in .env, e.g. ghcr.io/owner/whatsapp-notification-platform."

public_base_url="$(read_setting HTTP_PUBLIC_BASE_URL)"
# The hostname is written into the edge proxy's configuration, which serves
# other sites too, so it is held to what a hostname can actually contain.
if [[ ! "$public_base_url" =~ ^https://([a-z0-9]([a-z0-9.-]*[a-z0-9])?)/?$ ]]; then
  fail "HTTP_PUBLIC_BASE_URL in .env must be https://<hostname>, the address the dashboard is served on."
fi
readonly PUBLIC_HOSTNAME="${BASH_REMATCH[1]}"

# The workflow hands over a registry token that expires with its run, on
# standard input. It is used from a throwaway Docker configuration, so it never
# lands in the deploy user's own, and another project on this host logging out
# of the same registry cannot pull the rug from under this deploy.
if [[ -n "${REGISTRY_USER:-}" ]]; then
  DOCKER_CONFIG="$(mktemp -d)"
  export DOCKER_CONFIG
  trap 'rm -rf "$DOCKER_CONFIG"' EXIT
  if ! login_output="$(docker login "${IMAGE_REPOSITORY%%/*}" --username "$REGISTRY_USER" --password-stdin 2>&1)"; then
    fail "Could not log in to ${IMAGE_REPOSITORY%%/*}: ${login_output}"
  fi
fi

export IMAGE_REPOSITORY
export IMAGE_TAG="$TAG"

# What was live before this ran, so a failure can say where to go back to.
previous_tag="$(cat .deployed-tag 2>/dev/null || echo none)"
echo "Deployed now: ${previous_tag}"
echo "Deploying:    ${TAG}"

# ── Pull ─────────────────────────────────────────────────────────────────────
# Only this project's images. Postgres and the provider are pulled when they are
# missing and otherwise left alone: restarting the database or dropping the
# WhatsApp connection is not something shipping a feature should do by accident.
say "Pulling ${TAG}"
compose pull --quiet "${SERVICES_BUILT_HERE[@]}" ||
  fail "Could not pull ${TAG}. Nothing was changed; the running version is untouched."

# ── Migrate ──────────────────────────────────────────────────────────────────
# Awaited on its own before anything restarts, so a failed migration leaves the
# running version serving rather than half-replaced.
say "Applying migrations"
compose run --rm -T migrate </dev/null ||
  fail "Migrations failed. The running services were not restarted and no volume was touched."

# ── Start ────────────────────────────────────────────────────────────────────
say "Starting ${TAG}"
if ! compose up --detach --wait --wait-timeout 300 </dev/null; then
  fail "${TAG} did not become healthy, and nothing was rolled back automatically. To go back:

    IMAGE_REPOSITORY=${IMAGE_REPOSITORY} $0 ${previous_tag}

Logs: docker compose -f ${COMPOSE_FILE} logs --tail 200 api worker web"
fi

# ── Edge ─────────────────────────────────────────────────────────────────────
# Ports 80 and 443 belong to a proxy shared with other projects on this host. It
# imports one site file per project from EDGE_SITES_DIRECTORY and reaches each
# project's web container over the `edge` network; this is ours.
say "Publishing https://${PUBLIC_HOSTNAME} on the edge proxy"

site="$(mktemp)"
cat >"$site" <<SITE
# Written by whatsapp-notification-platform's tools/deploy/deploy.sh on every
# deploy; edit that, not this. TLS ends here, and everything behind it -- the
# dashboard and the API -- is served by the project's own web container.
${PUBLIC_HOSTNAME} {
	reverse_proxy whatsapp-notification-platform:8080
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
}
SITE

if cmp -s "$site" "$EDGE_SITE_FILE"; then
  rm -f "$site"
  echo "Unchanged."
else
  # Checked before it is installed. The proxy serves other sites as well, and a
  # file it cannot parse would stop it from starting the next time it restarts.
  if ! validation="$(docker run --rm --network none -v "${site}:/etc/caddy/Caddyfile:ro" \
    --entrypoint caddy "${IMAGE_REPOSITORY}-web:${TAG}" \
    validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
    rm -f "$site"
    fail "The site file for the edge proxy is not valid, so it was not installed: ${validation}"
  fi

  edge_proxy="$(docker ps --quiet --filter network=edge --filter publish=443 | head -n 1)"
  [[ -n "$edge_proxy" ]] ||
    fail "No proxy on the 'edge' network is publishing port 443, so there is nothing to serve the site."

  previous_site=""
  if [[ -f "$EDGE_SITE_FILE" ]]; then
    previous_site="$(mktemp)"
    cp "$EDGE_SITE_FILE" "$previous_site"
  fi
  install -m 644 "$site" "$EDGE_SITE_FILE"
  rm -f "$site"

  # A reload is atomic: if the proxy rejects the result it keeps serving what it
  # had, and the file is put back so its next restart does not fail either.
  if ! reload="$(docker exec "$edge_proxy" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
    if [[ -n "$previous_site" ]]; then
      install -m 644 "$previous_site" "$EDGE_SITE_FILE"
    fi
    if [[ -z "$previous_site" ]]; then
      rm -f "$EDGE_SITE_FILE"
    fi
    fail "The edge proxy refused the site and is still serving its previous configuration: ${reload}"
  fi
  rm -f "$previous_site"
  echo "Installed and reloaded."
fi

# ── Verify ───────────────────────────────────────────────────────────────────
# Through the front door: DNS, the certificate, the edge proxy, the dashboard
# origin and the API all have to agree for this to answer. The first deploy
# waits here while the certificate is issued.
say "Checking https://${PUBLIC_HOSTNAME}/health"
for _ in $(seq 1 30); do
  if curl --silent --fail --max-time 10 --output /dev/null "https://${PUBLIC_HOSTNAME}/health"; then
    echo "$TAG" >.deployed-tag

    # Keeps what is running and what a rollback would return to. Other
    # projects' images on this host are theirs to manage.
    for service in "${SERVICES_BUILT_HERE[@]}"; do
      docker image ls "${IMAGE_REPOSITORY}-${service}" --format '{{.Tag}}' | while read -r tag; do
        if [[ "$tag" == "$TAG" || "$tag" == "$previous_tag" ]]; then
          continue
        fi
        docker image rm "${IMAGE_REPOSITORY}-${service}:${tag}" >/dev/null 2>&1 || true
      done
    done

    say "Deployed ${TAG} (previous: ${previous_tag})"
    exit 0
  fi
  sleep 5
done

fail "https://${PUBLIC_HOSTNAME}/health never answered, although the containers are healthy.
Look at the edge proxy's logs for the certificate and the route. To go back:

    IMAGE_REPOSITORY=${IMAGE_REPOSITORY} $0 ${previous_tag}"
