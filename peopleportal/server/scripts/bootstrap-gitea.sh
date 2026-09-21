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
set -euo pipefail

GITEA_CT=${GITEA_CT:-gitea-z823m13gxlqdqg3vjgv8vvi9}
ADMIN_USER=${ADMIN_USER:-ppadmin}
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@appdev-git.iancoutinho.net}
TOKEN_NAME=${TOKEN_NAME:-peopleportal}
TOKEN_SCOPES=${TOKEN_SCOPES:-write:admin,write:organization,write:repository,write:user}
AUTH_NAME=${AUTH_NAME:-authentik}
AUTH_SCOPES=${AUTH_SCOPES:-openid,profile,email}
DISCOVERY_URL=${DISCOVERY_URL:-https://appdev-auth.iancoutinho.net/application/o/gitea/.well-known/openid-configuration}
TOKEN_OUT=${TOKEN_OUT:-/root/.gitea-app-token}

g() { docker exec -u git "$GITEA_CT" gitea "$@"; }

echo '==> waiting for gitea'
for i in $(seq 1 30); do g admin user list >/dev/null 2>&1 && break || sleep 2; done

echo '==> admin user'
if g admin user list 2>/dev/null | awk 'NR>1 {print $2}' | grep -qx "$ADMIN_USER"; then
  echo "    $ADMIN_USER exists"
else
  PW=$(openssl rand -hex 24)
  g admin user create --username "$ADMIN_USER" --password "$PW" \
     --email "$ADMIN_EMAIL" --admin --must-change-password=false >/dev/null
  umask 077; printf '%s' "$PW" > /root/.gitea-admin-pass
  echo "    created $ADMIN_USER (password in /root/.gitea-admin-pass)"
fi

echo '==> api token'
if g admin user generate-access-token --username "$ADMIN_USER" \
     --token-name "$TOKEN_NAME" --scopes "$TOKEN_SCOPES" --raw > /tmp/.tok 2>/dev/null; then
  umask 077; mv /tmp/.tok "$TOKEN_OUT"
  echo "    created token '$TOKEN_NAME' -> $TOKEN_OUT (set GITEA_TOKEN in Coolify to this)"
else
  rm -f /tmp/.tok
  echo "    token '$TOKEN_NAME' already exists, leaving it alone"
fi

echo '==> oidc auth source'
ID=$(g admin auth list 2>/dev/null | awk -v n="$AUTH_NAME" 'NR>1 && $2==n {print $1}')
if [ -n "$ID" ]; then
  g admin auth update-oauth --id "$ID" --scopes "$AUTH_SCOPES" >/dev/null
  echo "    updated source id $ID scopes=$AUTH_SCOPES"
elif [ -n "${OIDC_CLIENT_ID:-}" ] && [ -n "${OIDC_CLIENT_SECRET:-}" ]; then
  g admin auth add-oauth --name "$AUTH_NAME" --provider openidConnect \
     --key "$OIDC_CLIENT_ID" --secret "$OIDC_CLIENT_SECRET" \
     --auto-discover-url "$DISCOVERY_URL" --scopes "$AUTH_SCOPES" >/dev/null
  echo "    created auth source '$AUTH_NAME'"
else
  echo "    MISSING and cannot create: set OIDC_CLIENT_ID and OIDC_CLIENT_SECRET" >&2
  exit 1
fi

echo '==> done'
