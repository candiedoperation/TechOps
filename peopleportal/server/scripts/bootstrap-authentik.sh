#!/usr/bin/env bash
# Configures Authentik for People Portal. Idempotent: re-running updates the
# existing provider rather than creating a second one.
#
#   AK_TOKEN=<authentik api token> ./bootstrap-authentik.sh [base-url]
#
# base-url is the origin People Portal is served from, and defaults to
# http://localhost:3000 for a local stack. Override AK_URL if Authentik is not
# on http://localhost:9000.
#
# AK_TOKEN may also be set in a .env file beside this script (gitignored).
#
# Every step here is one we hit by hand first:
#   - the people_portal scope, because pk / is_superuser / attributes are not
#     standard OIDC claims but the app reads all three
#   - grant_types, without which /authorize answers "Invalid grant_type"
#   - a strict redirect_uri matching the app's own base URL
set -euo pipefail
cd "$(dirname "$0")"

# Optional: a local .env beside this script. Absent is fine; the environment
# is authoritative either way. The old version sourced this unconditionally
# and died with a confusing "No such file" on any machine that lacked it.
[ -f ./.env ] && . ./.env

AK="${AK_URL:-http://localhost:9000}"
BASE_URL="${1:-${PEOPLEPORTAL_BASE_URL:-http://localhost:3000}}"

if [ -z "${AK_TOKEN:-}" ]; then
  echo "AK_TOKEN is not set. Create one in Authentik under Directory > Tokens," >&2
  echo "then re-run:  AK_TOKEN=<token> $0 [base-url]" >&2
  exit 1
fi

for bin in curl python3; do
  command -v "$bin" >/dev/null || { echo "missing required command: $bin" >&2; exit 1; }
done

AUTHZ="Authorization: Bearer ${AK_TOKEN}"
CT="Content-Type: application/json"

api() { curl -s -H "$AUTHZ" -H "$CT" "$@"; }
pick() { python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('results',[d]);print(r[0]['$1'] if r else '')"; }

echo "==> authentik at $AK, app base url $BASE_URL"
api "$AK/api/v3/core/users/me/" >/dev/null 2>&1 || {
  echo "cannot reach Authentik at $AK, or AK_TOKEN is invalid" >&2; exit 1; }

AUTH_FLOW=$(api "$AK/api/v3/flows/instances/?slug=default-provider-authorization-implicit-consent" | pick pk)
# default-invalidation-flow, NOT default-provider-invalidation-flow. The
# provider variant ships with zero stages: it ends the application session and
# leaves the Authentik session untouched, so end-session returns cleanly, the
# next authorize completes silently against the still-live session, and the
# user lands straight back where they started. The non-provider flow carries
# the user-logout stage that actually ends the Authentik session.
INVAL_FLOW=$(api "$AK/api/v3/flows/instances/?slug=default-invalidation-flow" | pick pk)
KEY=$(api "$AK/api/v3/crypto/certificatekeypairs/?has_key=true" | pick pk)

SCOPE=$(api "$AK/api/v3/propertymappings/provider/scope/?scope_name=people_portal" | pick pk)
if [ -z "$SCOPE" ]; then
  SCOPE=$(api -X POST "$AK/api/v3/propertymappings/provider/scope/" --data-binary @- <<'JSON' | pick pk
{"name":"People Portal Scope","scope_name":"people_portal",
 "description":"People Portal claims",
 "expression":"return {\n    \"pk\": request.user.pk,\n    \"is_superuser\": request.user.is_superuser,\n    \"attributes\": request.user.attributes\n}"}
JSON
)
  echo "    created people_portal scope mapping"
fi

STD=$(api "$AK/api/v3/propertymappings/provider/scope/?managed__isnull=false" | python3 -c "
import sys,json
want={'openid','email','profile','offline_access'}
print(json.dumps([m['pk'] for m in json.load(sys.stdin)['results'] if m['scope_name'] in want]))")

BODY=$(python3 - "$AUTH_FLOW" "$INVAL_FLOW" "$KEY" "$STD" "$SCOPE" "$BASE_URL" <<'PY'
import json, sys
auth, inval, key, std, scope, base = sys.argv[1:7]
print(json.dumps({
    "name": "people-portal",
    "authorization_flow": auth,
    "invalidation_flow": inval,
    "client_type": "confidential",
    "signing_key": key,
    "grant_types": ["authorization_code", "refresh_token"],
    "sub_mode": "user_username",
    # Two entries, and the types are not interchangeable. Authentik tags each
    # redirect uri as "authorization" or "logout" and checks
    # post_logout_redirect_uri only against the logout ones. Registering the
    # landing page with the default "authorization" type is accepted by the
    # API and then fails at logout with a bare "Bad Request / The request is
    # otherwise malformed", which names neither the uri nor the type.
    "redirect_uris": [
        {"matching_mode": "strict", "url": f"{base}/api/auth/redirect",
         "redirect_uri_type": "authorization"},
        {"matching_mode": "strict", "url": f"{base}/",
         "redirect_uri_type": "logout"},
    ],
    "property_mappings": json.loads(std) + [scope],
}))
PY
)

PROV=$(api "$AK/api/v3/providers/oauth2/?name=people-portal" | pick pk)
if [ -z "$PROV" ]; then
  PROV=$(api -X POST "$AK/api/v3/providers/oauth2/" -d "$BODY" | pick pk)
  api -X POST "$AK/api/v3/core/applications/" \
      -d "{\"name\":\"People Portal\",\"slug\":\"people-portal\",\"provider\":$PROV}" >/dev/null
  echo "    created provider and application (pk $PROV)"
else
  api -X PATCH "$AK/api/v3/providers/oauth2/$PROV/" -d "$BODY" >/dev/null
  echo "    updated existing provider (pk $PROV)"
fi

api "$AK/api/v3/providers/oauth2/$PROV/" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('CLIENT_ID=' + d['client_id'])
print('CLIENT_SECRET=' + d['client_secret'])" > .oidc
chmod 600 .oidc
echo "==> credentials written to $(pwd)/.oidc (gitignored)"
