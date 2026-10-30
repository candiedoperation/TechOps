#!/usr/bin/env bash
# Reconcile the Gitea state that the REST API cannot reach.
#
#   ./bootstrap-gitea.sh
#
# Idempotent: every step checks before it writes, so re-running changes
# nothing once the instance is in the desired state. Safe to run on every
# boot, after a volume loss, or by hand.
#
# Restarts the Gitea container whenever the oidc auth source is created or
# updated. Gitea loads its auth sources into memory once at startup and does
# not notice DB changes made via this CLI, so skipping the restart leaves
# the running server silently using stale OIDC credentials/discovery URLs
# indefinitely, even though `gitea admin auth list` and the database agree
# on the new (correct) values.
#
# Covers the four things that live only inside Gitea's database and are
# invisible to a bearer token: the admin user, its API token, the OIDC auth
# source, and that source's scopes. Webhooks are NOT here: the app already
# reconciles those itself at startup via GiteaClient/hooksetup.ts.
#
# The Gitea container is auto-detected. Override anything below by exporting
# it first, e.g.  GITEA_CT=my-gitea ./bootstrap-gitea.sh
#
# Run bootstrap-gitea-authentik.sh first (it needs AK_TOKEN and creates
# Gitea's dedicated Authentik application/provider). bootstrap-authentik.sh
# (People Portal's own app/provider) is unrelated and does not need to run
# before this one.
#
# Creating the OIDC auth source needs Gitea's own dedicated client
# credentials from Authentik (a separate application/provider from People
# Portal's -- see bootstrap-gitea-authentik.sh). It writes them next door as
# .oidc-gitea, which is sourced automatically when present.
set -euo pipefail
cd "$(dirname "$0")"

[ -f ./.oidc-gitea ] && . ./.oidc-gitea
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-${CLIENT_ID:-}}"
OIDC_CLIENT_SECRET="${OIDC_CLIENT_SECRET:-${CLIENT_SECRET:-}}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

# Find the Gitea container rather than hardcoding a name: local stacks call it
# "gitea", compose prefixes it, and Coolify appends a service uuid.
if [ -z "${GITEA_CT:-}" ]; then
  GITEA_CT=$(docker ps --filter ancestor=gitea/gitea --format '{{.Names}}' | head -1)
  [ -n "$GITEA_CT" ] || GITEA_CT=$(docker ps --format '{{.Names}}' | grep -i gitea | head -1 || true)
fi
[ -n "${GITEA_CT:-}" ] || { echo "no running Gitea container found; set GITEA_CT" >&2; exit 1; }

ADMIN_USER=${ADMIN_USER:-ppadmin}
ADMIN_EMAIL=${ADMIN_EMAIL:-ppadmin@example.invalid}
TOKEN_NAME=${TOKEN_NAME:-peopleportal}
TOKEN_SCOPES=${TOKEN_SCOPES:-write:admin,write:organization,write:repository,write:user}
AUTH_NAME=${AUTH_NAME:-authentik}
AUTH_SCOPES=${AUTH_SCOPES:-openid,profile,email}
# This URL is fetched by `gitea` running *inside* the Gitea container (see
# g() below, which shells out via `docker exec`), not by this host script.
# localhost there means the Gitea container itself, so it must point at the
# host via host.docker.internal rather than localhost.
AK_URL=${AK_URL:-http://host.docker.internal:9000}
# Slug "gitea" matches Gitea's own dedicated Authentik application, created
# by bootstrap-gitea-authentik.sh (separate from People Portal's
# "people-portal" app/provider). Using the wrong slug here returns a
# discovery doc for a different application/issuer, and Gitea's authorize
# request gets rejected with a client ID / redirect_uri mismatch.
DISCOVERY_URL=${DISCOVERY_URL:-$AK_URL/application/o/gitea/.well-known/openid-configuration}
# Secrets land beside this script, not in /root, so this works unprivileged.
TOKEN_OUT=${TOKEN_OUT:-./.gitea-app-token}
PASS_OUT=${PASS_OUT:-./.gitea-admin-pass}

g() { docker exec -u git "$GITEA_CT" gitea "$@"; }

echo "==> gitea container: $GITEA_CT"
for i in $(seq 1 30); do g admin user list >/dev/null 2>&1 && break || sleep 2; done
g admin user list >/dev/null 2>&1 || { echo "gitea not responding in $GITEA_CT" >&2; exit 1; }

echo '==> admin user'
if g admin user list 2>/dev/null | awk 'NR>1 {print $2}' | grep -qx "$ADMIN_USER"; then
  echo "    $ADMIN_USER exists"
else
  PW=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  g admin user create --username "$ADMIN_USER" --password "$PW" \
     --email "$ADMIN_EMAIL" --admin --must-change-password=false >/dev/null
  (umask 077; printf '%s' "$PW" > "$PASS_OUT")
  echo "    created $ADMIN_USER (password in $PASS_OUT)"
fi

echo '==> api token'
if g admin user generate-access-token --username "$ADMIN_USER" \
     --token-name "$TOKEN_NAME" --scopes "$TOKEN_SCOPES" --raw > .tok.tmp 2>/dev/null; then
  (umask 077; mv .tok.tmp "$TOKEN_OUT")
  echo "    created token '$TOKEN_NAME' -> $TOKEN_OUT (set GITEA_TOKEN to this)"
else
  rm -f .tok.tmp
  echo "    token '$TOKEN_NAME' already exists, leaving it alone"
fi

echo '==> oidc auth source'
ID=$(g admin auth list 2>/dev/null | awk -v n="$AUTH_NAME" 'NR>1 && $2==n {print $1}')
if [ -n "$ID" ]; then
  # Re-send --auto-discover-url (and --key/--secret, when we have fresh ones)
  # too: Gitea keeps whatever was passed at creation time until told
  # otherwise, so a stale value (e.g. the discovery URL from a run before
  # AK_URL pointed at host.docker.internal, or a client_id/secret from an
  # Authentik provider that got recreated under a new pk) keeps failing
  # forever unless we overwrite it here on every run.
  EXTRA_ARGS=()
  if [ -n "$OIDC_CLIENT_ID" ] && [ -n "$OIDC_CLIENT_SECRET" ]; then
    EXTRA_ARGS+=(--key "$OIDC_CLIENT_ID" --secret "$OIDC_CLIENT_SECRET")
  fi
  g admin auth update-oauth --id "$ID" --scopes "$AUTH_SCOPES" \
     --auto-discover-url "$DISCOVERY_URL" "${EXTRA_ARGS[@]}" >/dev/null
  echo "    updated source id $ID scopes=$AUTH_SCOPES"
  AUTH_SOURCE_TOUCHED=1
elif [ -n "$OIDC_CLIENT_ID" ] && [ -n "$OIDC_CLIENT_SECRET" ]; then
  g admin auth add-oauth --name "$AUTH_NAME" --provider openidConnect \
     --key "$OIDC_CLIENT_ID" --secret "$OIDC_CLIENT_SECRET" \
     --auto-discover-url "$DISCOVERY_URL" --scopes "$AUTH_SCOPES" >/dev/null
  echo "    created auth source '$AUTH_NAME'"
  AUTH_SOURCE_TOUCHED=1
else
  echo "    MISSING and cannot create: run bootstrap-authentik.sh first, or set" >&2
  echo "    OIDC_CLIENT_ID and OIDC_CLIENT_SECRET" >&2
  exit 1
fi

# `gitea admin auth update-oauth`/`add-oauth` write straight to the database,
# but the already-running web process caches loaded auth sources in memory
# and never re-reads them. Without a restart here, login keeps silently
# using whatever client_id/secret/discovery-url was in effect when the
# process started, no matter how many times this script "fixes" the DB --
# which is exactly the "Client ID" authorize error this cost us hours to
# debug: the DB was correct, the running server just never noticed.
if [ "${AUTH_SOURCE_TOUCHED:-0}" = 1 ]; then
  echo "==> restarting $GITEA_CT so it picks up the oidc auth source change"
  docker restart "$GITEA_CT" >/dev/null
  for i in $(seq 1 30); do g admin user list >/dev/null 2>&1 && break || sleep 2; done
  g admin user list >/dev/null 2>&1 || { echo "gitea did not come back up after restart" >&2; exit 1; }
fi

echo '==> done'
