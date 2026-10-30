#!/usr/bin/env bash
# Configures Authentik for Gitea: a dedicated OAuth2/OpenID provider and
# application, separate from People Portal's own ("people-portal", managed
# by bootstrap-authentik.sh). Idempotent: re-running updates the existing
# provider rather than creating a second one.
#
#   AK_TOKEN=<authentik api token> ./bootstrap-gitea-authentik.sh [gitea-base-url]
#
# gitea-base-url is the origin Gitea is served from, and defaults to
# http://localhost:10000 for a local stack. Override AK_URL if Authentik is
# not on http://localhost:9000.
#
# AK_TOKEN may also be set in a .env file beside this script (gitignored),
# the same one bootstrap-authentik.sh reads.
#
# Run this before bootstrap-gitea.sh: it writes the client credentials to a
# gitignored .oidc-gitea, which bootstrap-gitea.sh reads to configure
# Gitea's OIDC auth source.
set -euo pipefail
cd "$(dirname "$0")"

# Optional: a local .env beside this script. Absent is fine; the environment
# is authoritative either way.
[ -f ./.env ] && . ./.env

AK="${AK_URL:-http://localhost:9000}"
BASE_URL="${1:-${GITEA_BASE_URL:-http://localhost:10000}}"

if [ -z "${AK_TOKEN:-}" ]; then
  echo "AK_TOKEN is not set. Create one in Authentik under Directory > Tokens," >&2
  echo "then re-run:  AK_TOKEN=<token> $0 [gitea-base-url]" >&2
  exit 1
fi

for bin in curl python3; do
  command -v "$bin" >/dev/null || { echo "missing required command: $bin" >&2; exit 1; }
done

AUTHZ="Authorization: Bearer ${AK_TOKEN}"
CT="Content-Type: application/json"

# -f makes curl exit non-zero on 4xx/5xx instead of silently returning the
# error body with exit 0 -- see bootstrap-authentik.sh for the orphaned-
# provider bug this avoids.
api() { curl -sf -H "$AUTHZ" -H "$CT" "$@"; }
pick() { python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('results',[d]);print(r[0]['$1'] if r else '')"; }

echo "==> authentik at $AK, gitea base url $BASE_URL"
api "$AK/api/v3/core/users/me/" >/dev/null 2>&1 || {
  echo "cannot reach Authentik at $AK, or AK_TOKEN is invalid" >&2; exit 1; }

AUTH_FLOW=$(api "$AK/api/v3/flows/instances/?slug=default-provider-authorization-implicit-consent" | pick pk)
# See bootstrap-authentik.sh for why this is default-invalidation-flow and
# not default-provider-invalidation-flow.
INVAL_FLOW=$(api "$AK/api/v3/flows/instances/?slug=default-invalidation-flow" | pick pk)
KEY=$(api "$AK/api/v3/crypto/certificatekeypairs/?has_key=true" | pick pk)

# Gitea only needs the standard claims -- no custom scope like People
# Portal's people_portal mapping.
STD=$(api "$AK/api/v3/propertymappings/provider/scope/?managed__isnull=false" | python3 -c "
import sys,json
want={'openid','email','profile'}
print(json.dumps([m['pk'] for m in json.load(sys.stdin)['results'] if m['scope_name'] in want]))")

BODY=$(python3 - "$AUTH_FLOW" "$INVAL_FLOW" "$KEY" "$STD" "$BASE_URL" <<'PY'
import json, sys
auth, inval, key, std, base = sys.argv[1:6]
print(json.dumps({
    "name": "gitea",
    "authorization_flow": auth,
    "invalidation_flow": inval,
    "client_type": "confidential",
    "signing_key": key,
    "grant_types": ["authorization_code", "refresh_token"],
    "sub_mode": "user_username",
    "redirect_uris": [
        {"matching_mode": "strict", "url": f"{base}/user/oauth2/authentik/callback",
         "redirect_uri_type": "authorization"},
    ],
    "property_mappings": json.loads(std),
}))
PY
)

# Look this up by the application's slug, not by filtering providers on
# name -- see bootstrap-authentik.sh for the orphaned-provider bug a
# `?name=` filter caused there. Same fix applied here up front.
APP=$(api "$AK/api/v3/core/applications/gitea/" 2>/dev/null) || APP=""
PROV=$(printf '%s' "$APP" | python3 -c "
import sys, json
try:
    print(json.load(sys.stdin)['provider'])
except Exception:
    pass
")
if [ -z "$PROV" ]; then
  PROV=$(api -X POST "$AK/api/v3/providers/oauth2/" -d "$BODY" | pick pk)
  api -X POST "$AK/api/v3/core/applications/" \
      -d "{\"name\":\"Gitea\",\"slug\":\"gitea\",\"provider\":$PROV}" >/dev/null
  echo "    created provider and application (pk $PROV)"
else
  api -X PATCH "$AK/api/v3/providers/oauth2/$PROV/" -d "$BODY" >/dev/null
  echo "    updated existing provider (pk $PROV)"
fi

api "$AK/api/v3/providers/oauth2/$PROV/" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('CLIENT_ID=' + d['client_id'])
print('CLIENT_SECRET=' + d['client_secret'])" > .oidc-gitea
chmod 600 .oidc-gitea
echo "==> credentials written to $(pwd)/.oidc-gitea (gitignored)"
