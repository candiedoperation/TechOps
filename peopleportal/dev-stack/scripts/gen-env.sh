#!/usr/bin/env bash
# Fill missing/empty settings once. Existing nonempty values always win.
set -euo pipefail
# shellcheck source=peopleportal/dev-stack/scripts/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_tools openssl
cd -- "$STACK_DIR"
read_settings "$STACK_DIR/.env"

# Template defaults and exported overrides precede derived URLs and secrets.
while IFS= read -r line || [[ -n $line ]]; do
  case "$line" in ''|\#*) continue ;; esac
  key=${line%%=*}
  value=${!key:-${line#*=}}
  printf -v "$key" '%s' "$value"
  export "${key?}"
done <.env.example

[[ $PUBLIC_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || die "PUBLIC_HOST must be a hostname or IPv4 address, without scheme or port."
[[ $BIND_ADDRESS == 127.0.0.1 ]] || die "BIND_ADDRESS must be 127.0.0.1 to keep backing services local."
seen_ports='|'
for key in AUTHENTIK_PORT GITEA_PORT GITEA_SSH_PORT MONGO_PORT REDIS_PORT MAILPIT_PORT SMTP_PORT PORTAL_PORT WEBUI_PORT; do
  value=${!key}
  [[ $value =~ ^[1-9][0-9]*$ && ${#value} -le 5 ]] || die "Invalid port: $key"
  (( value <= 65535 )) || die "Port out of range: $key"
  [[ $seen_ports != *"|$value|"* ]] || die "$key=$value conflicts with another stack port; choose distinct ports."
  seen_ports="$seen_ports$value|"
done
[[ $AUTHENTIK_PORT != 3000 && $AUTHENTIK_PORT != 22 ]] || die "AUTHENTIK_PORT conflicts with Gitea's internal listener; set AUTHENTIK_PORT to another port."
: "${PORTAL_BASE_URL:=http://$PUBLIC_HOST:$PORTAL_PORT}"
: "${AUTHENTIK_URL:=http://$PUBLIC_HOST:$AUTHENTIK_PORT}"
: "${GITEA_URL:=http://$PUBLIC_HOST:$GITEA_PORT}"
: "${S3_ENDPOINT:=http://s3.example.invalid}"
: "${S3_CORS_ORIGINS:=$PORTAL_BASE_URL,http://$PUBLIC_HOST:$WEBUI_PORT,http://localhost:3000,http://localhost:5173}"
for key in POSTGRES_PASSWORD AUTHENTIK_SECRET_KEY AUTHENTIK_BOOTSTRAP_PASSWORD AUTHENTIK_BOOTSTRAP_TOKEN PORTAL_OIDC_CLIENT_SECRET PORTAL_TOKEN_SECRET GITEA_OIDC_CLIENT_SECRET GITEA_ADMIN_PASSWORD GITEA_WEBHOOK_SECRET; do
  if [[ -z ${!key} ]]; then
    size=32
    value=$(openssl rand -hex "$size")
    printf -v "$key" '%s' "$value"
  fi
done

# Validate exported overrides too before saving them as shell/Compose literals.
render_settings() {
  while IFS= read -r line || [[ -n $line ]]; do
    case "$line" in ''|\#*) printf '%s\n' "$line"; continue ;; esac
    key=${line%%=*}
    value=${!key}
    case "$value" in *[!a-zA-Z0-9_.,:/@%+=?-]*) die "Unsupported characters in $key; use simple literal values." ;; esac
    printf "%s='%s'\n" "$key" "$value"
  done <.env.example
}
settings=$(render_settings)
private_file "$STACK_DIR/.env" <<<"$settings"
echo "Local .env ready (mode 600); existing nonempty values preserved." >&2
