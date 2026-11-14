#!/usr/bin/env bash
# Manage independent dev-stack slots (see ../PARALLEL.md).
#   slot.sh list
#   slot.sh urls   <slot|pr:N>
#   slot.sh server <slot|pr:N> [--dir <peopleportal dir>]   start portal server on the slot's ports
#   slot.sh ui     <slot|pr:N> [--dir <peopleportal dir>]   start Vite UI on the slot's ports
#   slot.sh stop-apps <slot|pr:N>                           stop host server + UI only
#   slot.sh down   <slot|pr:N> [--purge]                    stop containers (keep data) / delete everything
set -euo pipefail
export NODE_ENV=development   # the Mac shell exports NODE_ENV=production; never inherit it
cmd=${1:-}
[[ -n $cmd ]] && shift || true
usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit "${1:-2}"; }
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

# Resolve "3" or "pr:123" to a slot number before common.sh fixes STATE_DIR.
resolve_slot() {
  local ref=${1:-}
  [[ -n $ref ]] || usage
  if [[ $ref == pr:* ]]; then
    STACK_SLOT=0 source "$here/scripts/common.sh"
    local s
    s=$(awk -v pr="${ref#pr:}" '$1 == pr {print $2}' "$here/slots/.prs" 2>/dev/null)
    [[ -n $s ]] || { echo "ERROR: no slot recorded for PR ${ref#pr:}." >&2; exit 1; }
    printf '%s\n' "$s"
  else
    printf '%s\n' "$ref"
  fi
}

pid_alive() { [[ -s $1 ]] && kill -0 "$(<"$1")" 2>/dev/null; }
tree_pids() { # pid -> pid and all descendants
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do tree_pids "$child"; done
  printf '%s\n' "$pid"
}
kill_tree() { # Terminate, then wait so the ports are free before the caller continues.
  local pids i
  pids=$(tree_pids "$1")
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for ((i = 0; i < 50; i++)); do
    # shellcheck disable=SC2086
    kill -0 $pids 2>/dev/null || return 0
    sleep 0.2
  done
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
}
stop_app() { # pidfile
  if pid_alive "$1"; then kill_tree "$(<"$1")"; fi
  rm -f -- "$1"
}
wait_http() { # url attempts -- any HTTP status counts as up
  local i
  for ((i = 0; i < ${2:-90}; i++)); do
    curl --silent --max-time 3 --output /dev/null "$1" && return 0
    sleep 2
  done
  return 1
}

setting() { # file key -> value of KEY='value'
  sed -n "s/^$2='\{0,1\}\([^']*\)'\{0,1\}$/\1/p" "$1" | head -1
}

case $cmd in
  list)
    # shellcheck source=peopleportal/dev-stack/scripts/common.sh
    STACK_SLOT=0 source "$here/scripts/common.sh"
    printf '%-5s %-5s %-14s %-9s %-24s %-7s %-6s\n' SLOT PR PROJECT CONTAINERS 'UI URL' SERVER UI
    for dir in "$here" "$here"/slots/[0-9]*; do
      [[ -f $dir/.env ]] || continue
      if [[ $dir == "$here" ]]; then n=0; else n=${dir##*/}; fi
      proj=$(setting "$dir/.env" COMPOSE_PROJECT_NAME)
      host=$(setting "$dir/.env" PUBLIC_HOST); ui=$(setting "$dir/.env" WEBUI_PORT)
      running=$(docker ps --filter "label=com.docker.compose.project=$proj" --format '{{.ID}}' 2>/dev/null | wc -l | tr -d ' ')
      s=down u=down
      pid_alive "$dir/server.pid" && s=up; pid_alive "$dir/ui.pid" && u=up
      if [[ $n == 0 ]]; then s=- u=-; fi
      printf '%-5s %-5s %-14s %-9s %-24s %-7s %-6s\n' "$n" "$(slot_to_pr "$n")" "$proj" "$running/8" "http://$host:$ui" "$s" "$u"
    done
    ;;
  urls)
    STACK_SLOT=$(resolve_slot "${1:-}"); export STACK_SLOT
    # shellcheck source=peopleportal/dev-stack/scripts/common.sh
    source "$here/scripts/common.sh"
    load_env
    h=$PUBLIC_HOST
    cat <<URLS
Slot $STACK_SLOT (${COMPOSE_PROJECT_NAME})
  People Portal UI   http://$h:$WEBUI_PORT      (Vite; log in here)
  Portal backend     http://$h:$PORTAL_PORT
  Authentik          $AUTHENTIK_URL           akadmin / see $ENV_FILE (AUTHENTIK_BOOTSTRAP_PASSWORD)
  Gitea              $GITEA_URL            $GITEA_ADMIN_USER / GITEA_ADMIN_PASSWORD in $ENV_FILE
  Mailpit            http://$h:$MAILPIT_PORT
  MongoDB            mongodb://127.0.0.1:$MONGO_PORT/people-portal
  Redis              redis://127.0.0.1:$REDIS_PORT
  SMTP               127.0.0.1:$SMTP_PORT      Gitea SSH 127.0.0.1:$GITEA_SSH_PORT
URLS
    ;;
  server|ui)
    STACK_SLOT=$(resolve_slot "${1:-}"); export STACK_SLOT; shift
    pp_dir=$here/..
    while (( $# )); do
      case $1 in --dir) pp_dir=${2:?--dir needs a path}; shift ;; *) usage ;; esac
      shift
    done
    pp_dir=$(cd -- "$pp_dir" && pwd)
    # shellcheck source=peopleportal/dev-stack/scripts/common.sh
    source "$here/scripts/common.sh"
    load_env
    mkdir -p "$STATE_DIR/logs"
    [[ -f $STATE_DIR/portal.env ]] || die "Run scripts/up.sh --slot $STACK_SLOT first."
    if [[ $cmd == server ]]; then
      stop_app "$STATE_DIR/server.pid"
      # Process env beats server/.env*, so a checkout's own .env.development cannot leak ports in.
      nohup bash -c "cd '$pp_dir/server' && set -a && . '$STATE_DIR/portal.env' && set +a && export NODE_ENV=development && npx --no-install tsoa spec-and-routes >/dev/null && exec npx --no-install nodemon src/app.ts" \
        >"$STATE_DIR/logs/server.log" 2>&1 &
      echo $! >"$STATE_DIR/server.pid"
      printf '%s\n' "$pp_dir" >"$STATE_DIR/app.dir"
      echo "Waiting for the server on :$PORTAL_PORT (log: $STATE_DIR/logs/server.log)..." >&2
      wait_http "http://127.0.0.1:$PORTAL_PORT/" 120 || die "Server did not come up; tail $STATE_DIR/logs/server.log"
      echo "Server up: http://$PUBLIC_HOST:$PORTAL_PORT" >&2
    else
      stop_app "$STATE_DIR/ui.pid"
      # 127.0.0.1: *.localhost names resolve to IPv4 only, but Vite's "localhost" may bind ::1.
      nohup bash -c "cd '$pp_dir/webui' && set -a && . '$STATE_DIR/webui.env' && set +a && export NODE_ENV=development && exec npx --no-install vite --host 127.0.0.1 --port $WEBUI_PORT --strictPort" \
        >"$STATE_DIR/logs/ui.log" 2>&1 &
      echo $! >"$STATE_DIR/ui.pid"
      printf '%s\n' "$pp_dir" >"$STATE_DIR/app.dir"
      wait_http "http://127.0.0.1:$WEBUI_PORT/" 60 || die "UI did not come up; tail $STATE_DIR/logs/ui.log"
      echo "UI up: http://$PUBLIC_HOST:$WEBUI_PORT" >&2
    fi
    ;;
  stop-apps)
    STACK_SLOT=$(resolve_slot "${1:-}"); export STACK_SLOT
    # shellcheck source=peopleportal/dev-stack/scripts/common.sh
    source "$here/scripts/common.sh"
    (( STACK_SLOT > 0 )) || die "stop-apps only manages slots 1-99."
    stop_app "$STATE_DIR/server.pid"; stop_app "$STATE_DIR/ui.pid"
    ;;
  down)
    ref=${1:-}; shift || true
    purge=false
    case "${1:-}" in --purge) purge=true ;; '') ;; *) usage ;; esac
    STACK_SLOT=$(resolve_slot "$ref"); export STACK_SLOT
    # shellcheck source=peopleportal/dev-stack/scripts/common.sh
    source "$here/scripts/common.sh"
    (( STACK_SLOT > 0 )) || die "Refusing to touch the default stack; use docker compose stop / scripts/reset.sh for it."
    require_docker
    stop_app "$STATE_DIR/server.pid"; stop_app "$STATE_DIR/ui.pid"
    if [[ -f $ENV_FILE ]]; then
      load_env
      if [[ $purge == true ]]; then
        compose down --volumes --remove-orphans >&2
        echo "Slot $STACK_SLOT purged: containers, volumes and network of $COMPOSE_PROJECT_NAME removed." >&2
      else
        compose down --remove-orphans >&2
        echo "Slot $STACK_SLOT stopped (volumes kept). Bring back with: scripts/up.sh --slot $STACK_SLOT" >&2
      fi
    fi
    if [[ $purge == true ]]; then
      rm -rf -- "${STATE_DIR:?}"
      if [[ -f $here/slots/.prs ]]; then
        grep -v " $STACK_SLOT\$" "$here/slots/.prs" >"$here/slots/.prs.tmp" || true
        mv -f "$here/slots/.prs.tmp" "$here/slots/.prs"
      fi
    fi
    ;;
  -h|--help|help) usage 0 ;;
  *) usage ;;
esac
