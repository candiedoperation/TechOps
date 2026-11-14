#!/usr/bin/env bash
# Shared helpers. No jq, GNU-only tools or global container names.
set -euo pipefail
umask 077
STACK_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
export STACK_DIR

# --- Slots ---------------------------------------------------------------
# STACK_SLOT unset/0 is the classic single stack (project "ppdev", state files in
# dev-stack/). Slots 1..99 are fully independent stacks: own Compose project,
# volumes, network, secrets, ports and hostname. Their state lives in slots/<N>/.
STACK_SLOT=${STACK_SLOT:-0}
[[ $STACK_SLOT =~ ^[0-9]+$ ]] && (( STACK_SLOT <= 99 )) || { echo "ERROR: STACK_SLOT must be 0-99." >&2; exit 1; }
STACK_SLOT=$((10#$STACK_SLOT))
if (( STACK_SLOT > 0 )); then
  STATE_DIR=$STACK_DIR/slots/$STACK_SLOT
  mkdir -p "$STATE_DIR"
else
  STATE_DIR=$STACK_DIR
fi
ENV_FILE=$STATE_DIR/.env
export STACK_SLOT STATE_DIR ENV_FILE

# Deterministic per-slot ports: 20000 + slot*20 + offset. Stays below the OS
# ephemeral ranges (macOS 49152+, Linux 32768+); 20 per slot leaves room to grow.
slot_ports() {
  local base=$((20000 + $1 * 20))
  PORTAL_PORT=$base WEBUI_PORT=$((base + 1)) MONGO_PORT=$((base + 2)) REDIS_PORT=$((base + 3))
  AUTHENTIK_PORT=$((base + 4)) GITEA_PORT=$((base + 5)) GITEA_SSH_PORT=$((base + 6))
  MAILPIT_PORT=$((base + 7)) SMTP_PORT=$((base + 8))
}

# Forced (not overridable by the caller's shell) so two slots can never collide.
# A distinct *.localhost name per slot keeps browser cookies apart: cookies ignore
# ports, so slots sharing "localhost" would overwrite each other's sessions.
apply_slot_defaults() {
  (( STACK_SLOT > 0 )) || return 0
  slot_ports "$STACK_SLOT"
  COMPOSE_PROJECT_NAME=ppdev-s$STACK_SLOT
  PUBLIC_HOST=pp$STACK_SLOT.localhost
  PORTAL_BASE_URL='' AUTHENTIK_URL='' GITEA_URL='' S3_CORS_ORIGINS=''
  export PORTAL_PORT WEBUI_PORT MONGO_PORT REDIS_PORT AUTHENTIK_PORT GITEA_PORT GITEA_SSH_PORT \
    MAILPIT_PORT SMTP_PORT COMPOSE_PROJECT_NAME PUBLIC_HOST PORTAL_BASE_URL AUTHENTIK_URL GITEA_URL S3_CORS_ORIGINS
}

# Resolve --slot N / --pr N style arguments shared by every entry point.
# PR numbers map to slots through slots/.prs ("<pr> <slot>" lines), allocating the
# lowest free slot on first use so the mapping is stable across runs.
pr_to_slot() {
  local pr=$1 slot used
  [[ $pr =~ ^[0-9]+$ ]] || die "PR number must be numeric."
  mkdir -p "$STACK_DIR/slots"
  touch "$STACK_DIR/slots/.prs"
  slot=$(awk -v pr="$pr" '$1 == pr {print $2}' "$STACK_DIR/slots/.prs")
  if [[ -z $slot ]]; then
    for ((slot = 1; slot <= 99; slot++)); do
      used=$(awk -v s="$slot" '$2 == s' "$STACK_DIR/slots/.prs")
      if [[ -z $used && ! -d $STACK_DIR/slots/$slot ]]; then break; fi
    done
    (( slot <= 99 )) || die "No free slots left; run slot.sh down --purge on an old one."
    echo "$pr $slot" >>"$STACK_DIR/slots/.prs"
  fi
  printf '%s\n' "$slot"
}
slot_to_pr() { awk -v s="$1" '$2 == s {print $1}' "$STACK_DIR/slots/.prs" 2>/dev/null || true; }

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
  [[ -f $ENV_FILE ]] || die "Run scripts/gen-env.sh first (or scripts/up.sh --slot N)."
  read_settings "$ENV_FILE"
}

compose() {
  docker compose --project-directory "$STACK_DIR" --env-file "$ENV_FILE" \
    -f "$STACK_DIR/docker-compose.yml" "$@"
}

print_ports() {
  local key
  echo "Local ports for $COMPOSE_PROJECT_NAME (slot $STACK_SLOT, Docker bindings: 127.0.0.1):" >&2
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
  mkdir "$STATE_DIR/.bootstrap.lock" 2>/dev/null || die "Another bootstrap/reset is running. Check before removing a stale $STATE_DIR/.bootstrap.lock."
  trap 'rmdir "$STATE_DIR/.bootstrap.lock"' EXIT
}
