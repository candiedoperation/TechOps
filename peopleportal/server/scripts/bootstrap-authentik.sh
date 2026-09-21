#!/usr/bin/env bash
# Configures Authentik for People Portal. Idempotent: re-running updates the
# existing provider rather than creating a second one.
#
# Every step here is one we hit by hand first:
#   - the people_portal scope, because pk / is_superuser / attributes are not
#     standard OIDC claims but the app reads all three
#   - grant_types, without which /authorize answers "Invalid grant_type"
#   - a strict redirect_uri matching the app's own base URL
set -euo pipefail
cd "$(dirname "$0")"
. ./.env

AK=http://localhost:9000
BASE_URL="${1:-http://192.168.70.20:3000}"
AUTHZ="Authorization: Bearer ${AK_TOKEN}"
CT="Content-Type: application/json"

api() { curl -s -H "$AUTHZ" -H "$CT" "$@"; }
pick() { python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('results',[d]);print(r[0]['$1'] if r else '')"; }

AUTH_FLOW=$(api "$AK/api/v3/flows/instances/?slug=default-provider-authorization-implicit-consent" | pick pk)
INVAL_FLOW=$(api "$AK/api/v3/flows/instances/?slug=default-provider-invalidation-flow" | pick pk)
KEY=$(api "$AK/api/v3/crypto/certificatekeypairs/?has_key=true" | pick pk)

SCOPE=$(api "$AK/api/v3/propertymappings/provider/scope/?scope_name=people_portal" | pick pk)
if [ -z "$SCOPE" ]; then
  SCOPE=$(api -X POST "$AK/api/v3/propertymappings/provider/scope/" --data-binary @- <<'JSON' | pick pk
{"name":"People Portal Scope","scope_name":"people_portal",
 "description":"People Portal claims",
 "expression":"return {\n    \"pk\": request.user.pk,\n    \"is_superuser\": request.user.is_superuser,\n    \"attributes\": request.user.attributes\n}"}
JSON
)
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
    "redirect_uris": [{"matching_mode": "strict", "url": f"{base}/api/auth/redirect"}],
    "property_mappings": json.loads(std) + [scope],
}))
PY
)

PROV=$(api "$AK/api/v3/providers/oauth2/?name=people-portal" | pick pk)
if [ -z "$PROV" ]; then
  PROV=$(api -X POST "$AK/api/v3/providers/oauth2/" -d "$BODY" | pick pk)
  api -X POST "$AK/api/v3/core/applications/" \
      -d "{\"name\":\"People Portal\",\"slug\":\"people-portal\",\"provider\":$PROV}" >/dev/null
  echo "  created provider and application (pk $PROV)"
else
  api -X PATCH "$AK/api/v3/providers/oauth2/$PROV/" -d "$BODY" >/dev/null
  echo "  updated existing provider (pk $PROV)"
fi

api "$AK/api/v3/providers/oauth2/$PROV/" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('CLIENT_ID=' + d['client_id'])
print('CLIENT_SECRET=' + d['client_secret'])" > .oidc
chmod 600 .oidc
echo "  credentials written to .oidc"
