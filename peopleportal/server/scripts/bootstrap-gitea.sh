#!/usr/bin/env bash
# Reconcile the Gitea state that the REST API cannot reach.
#
#   ./bootstrap-gitea.sh
#
# Idempotent: every step checks before it writes, so re-running changes
# nothing once the instance is in the desired state. Safe to run on every
# boot, after a volume loss, or by hand.
#
# Covers the four things that live only inside Gitea's database and are
# invisible to a bearer token: the admin user, its API token, the OIDC auth
# source, and that source's scopes. Webhooks are NOT here: the app already
# reconciles those itself at startup via GiteaClient/hooksetup.ts.
#
# The Gitea container is auto-detected. Override anything below by exporting
# it first, e.g.  GITEA_CT=my-gitea ./bootstrap-gitea.sh
#
# Creating the OIDC auth source needs the client credentials from Authentik.
# bootstrap-authentik.sh writes them next door as .oidc, which is sourced
# automatically when present.
set -euo pipefail
cd "$(dirname "$0")"

[ -f ./.oidc ] && . ./.oidc
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
AK_URL=${AK_URL:-http://localhost:9000}
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
  g admin auth update-oauth --id "$ID" --scopes "$AUTH_SCOPES" >/dev/null
  echo "    updated source id $ID scopes=$AUTH_SCOPES"
elif [ -n "$OIDC_CLIENT_ID" ] && [ -n "$OIDC_CLIENT_SECRET" ]; then
  g admin auth add-oauth --name "$AUTH_NAME" --provider openidConnect \
     --key "$OIDC_CLIENT_ID" --secret "$OIDC_CLIENT_SECRET" \
     --auto-discover-url "$DISCOVERY_URL" --scopes "$AUTH_SCOPES" >/dev/null
  echo "    created auth source '$AUTH_NAME'"
else
  echo "    MISSING and cannot create: run bootstrap-authentik.sh first, or set" >&2
  echo "    OIDC_CLIENT_ID and OIDC_CLIENT_SECRET" >&2
  exit 1
fi

echo '==> done'
