#!/usr/bin/env bash
# Shared helpers. No jq, GNU-only tools or global container names.
set -euo pipefail
umask 077
STACK_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
export STACK_DIR

die() { echo "ERROR: $*" >&2; exit 1; }
trap 'echo "ERROR: ${BASH_SOURCE[0]}:$LINENO: command failed; see the preceding output." >&2' ERR

require_tools() {
  local bin
  for bin in "$@"; do
    command -v "$bin" >/dev/null 2>&1 || die "Missing required command: $bin"
  done
}

require_docker() {
  require_tools docker curl
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 or later is required."
  docker info >/dev/null 2>&1 || die "Docker daemon is unavailable. Start Docker and check access."
}

# Parse data rather than execute .env. Only template keys and simple literals
# are accepted, making the same file safe for both Bash and Compose.
read_settings() {
  local file=$1 line key value seen='|'
  [[ ! -L $file ]] || die "Refusing symlink: $file"
  [[ -f $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    case "$line" in ''|\#*) continue ;; esac
    [[ $line =~ ^[A-Z][A-Z0-9_]*= ]] || die "Use KEY=value lines in $file."
    key=${line%%=*}
    grep -q "^${key}=" "$STACK_DIR/.env.example" || die "Unknown setting $key in $file."
    [[ $seen != *"|$key|"* ]] || die "Duplicate setting $key in $file."
    seen="$seen$key|"
    value=${line#*=}
    if [[ $value == \'*\' ]]; then value=${value:1:${#value}-2}; fi
    case "$value" in *[!a-zA-Z0-9_.,:/@%+=?-]*) die "Unsupported characters in $key; use simple literal values." ;; esac
    printf -v "$key" '%s' "$value"
    export "${key?}"
  done <"$file"
}

load_env() {
  cd -- "$STACK_DIR"
  [[ -f .env ]] || die "Run scripts/gen-env.sh first."
  read_settings "$STACK_DIR/.env"
}

compose() {
  docker compose --project-directory "$STACK_DIR" --env-file "$STACK_DIR/.env" \
    -f "$STACK_DIR/docker-compose.yml" "$@"
}

print_ports() {
  local key
  echo "Local ports for $COMPOSE_PROJECT_NAME (Docker bindings: 127.0.0.1):" >&2
  for key in PORTAL_PORT WEBUI_PORT MONGO_PORT REDIS_PORT AUTHENTIK_PORT GITEA_PORT GITEA_SSH_PORT MAILPIT_PORT SMTP_PORT; do
    printf '  %s=%s\n' "$key" "${!key}" >&2
  done
}

check_ports() {
  local ids containers='[]'
  ids=$(compose ps --status running --quiet)
  if [[ -n $ids ]]; then
    # Compose supplies container IDs, one per line. Inspect only this project.
    # shellcheck disable=SC2086
    containers=$(docker inspect $ids)
  fi
  python3 "$STACK_DIR/scripts/check-ports.py" <<<"$containers"
}

wait_url() {
  local url=$1 attempts=${2:-120} i
  for ((i = 0; i < attempts; i++)); do
    if curl --fail --silent --max-time 5 "$url" >/dev/null; then return 0; fi
    sleep 2
  done
  die "Timed out waiting for $url. Check docker compose ps and logs in $STACK_DIR."
}

private_file() {
  local target=$1 tmp
  [[ ! -L $target ]] || die "Refusing symlink: $target"
  tmp=$(mktemp "${target}.XXXXXX")
  if cat >"$tmp"; then
    chmod 600 "$tmp"
    mv -f -- "$tmp" "$target"
  else
    rm -f -- "$tmp"
    return 1
  fi
}

gitea_admin() {
  compose exec -T --user git gitea gitea --config /data/gitea/conf/app.ini admin "$@"
}

lock_stack() {
  mkdir "$STACK_DIR/.bootstrap.lock" 2>/dev/null || die "Another bootstrap/reset is running. Check before removing a stale .bootstrap.lock."
  trap 'rmdir "$STACK_DIR/.bootstrap.lock"' EXIT
}
