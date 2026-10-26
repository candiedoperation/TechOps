#!/usr/bin/env bash
# Reconcile Gitea's admin, recoverable local API token and OIDC auth source.
set -euo pipefail
# shellcheck source=peopleportal/dev-stack/scripts/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_tools openssl
require_docker
load_env
[[ -s .oidc ]] || die "Run scripts/bootstrap-authentik.sh first."
# The blueprint uses the stable credentials in .env; .oidc records API verification.
url="http://127.0.0.1:$GITEA_PORT"
wait_url "$url/api/healthz"
users=$(gitea_admin user list)
if ! awk -v user="$GITEA_ADMIN_USER" '$2 == user { found=1 } END { exit !found }' <<<"$users"; then
  gitea_admin user create --username "$GITEA_ADMIN_USER" \
    --password "$GITEA_ADMIN_PASSWORD" --email "$GITEA_ADMIN_EMAIL" \
    --admin --must-change-password=false >&2
fi

token_valid=false
if [[ -s .gitea-token ]]; then
  token=$(<.gitea-token)
  if curl --fail --silent --max-time 10 -H "Authorization: token $token" "$url/api/v1/user" >/dev/null; then
    token_valid=true
  fi
fi
if [[ $token_valid == false ]]; then
  # Run JSON parsing inside authentik's image. HTTP failures must abort rather
  # than masquerade as "already exists". Only delete this stack's named token.
  token_id=$(compose exec -T authentik-worker python - "$GITEA_ADMIN_USER" "$GITEA_ADMIN_PASSWORD" <<'PY'
import base64, json, sys, urllib.request
user, password = sys.argv[1:]
request = urllib.request.Request(f'http://gitea:3000/api/v1/users/{user}/tokens')
request.add_header('Authorization', 'Basic ' + base64.b64encode(f'{user}:{password}'.encode()).decode())
with urllib.request.urlopen(request, timeout=10) as response:
    tokens = json.load(response)
print(next((t['id'] for t in tokens if t['name'] == 'people-portal-dev'), ''))
PY
)
  if [[ -n $token_id ]]; then
    curl --fail --silent --show-error --max-time 10 --request DELETE \
      --user "$GITEA_ADMIN_USER:$GITEA_ADMIN_PASSWORD" \
      "$url/api/v1/users/$GITEA_ADMIN_USER/tokens/$token_id" >/dev/null
  fi
  token=$(gitea_admin user generate-access-token --username "$GITEA_ADMIN_USER" \
    --token-name people-portal-dev --scopes all --raw)
  token=$(awk '/^[0-9a-fA-F]+$/ && length($0) == 40 {print}' <<<"$token")
  [[ $token =~ ^[0-9a-fA-F]{40}$ ]] || die "Gitea did not return a single raw token."
  private_file "$STACK_DIR/.gitea-token" <<<"$token"
fi
chmod 600 .gitea-token

sources=$(gitea_admin auth list)
source_id=$(awk '$2 == "authentik" {print $1}' <<<"$sources")
args=(--name authentik --provider openidConnect --key "$GITEA_OIDC_CLIENT_ID"
  --secret "$GITEA_OIDC_CLIENT_SECRET"
  --auto-discover-url "$AUTHENTIK_URL/application/o/gitea/.well-known/openid-configuration"
  --scopes openid --scopes email --scopes profile --scopes people_portal)
# OpenSSL is present on both supported hosts; avoid GNU sha256sum.
wanted=$(printf '%s\n' "${args[@]}" | openssl dgst -sha256 | awk '{print $NF}')
save_hash=false
if [[ -z $source_id ]]; then
  gitea_admin auth add-oauth "${args[@]}" >&2
  save_hash=true
else
  current=$(compose exec -T --user git gitea sh -c \
    'if [ -f /data/gitea/.portal-oidc-hash ]; then cat /data/gitea/.portal-oidc-hash; fi')
  if [[ $current != "$wanted" ]]; then
    gitea_admin auth update-oauth --id "$source_id" "${args[@]}" >&2
    save_hash=true
  fi
fi
if [[ $save_hash == true ]]; then
  printf '%s\n' "$wanted" | compose exec -T --user git gitea sh -c \
    'umask 077; cat > /data/gitea/.portal-oidc-hash'
fi
echo "Gitea admin, token and authentik OIDC source ready (.gitea-token mode 600)." >&2
