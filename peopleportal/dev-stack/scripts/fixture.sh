#!/usr/bin/env bash
# Snapshot and restore the complete state of a dev-stack slot.
#   fixture.sh list
#   fixture.sh save  <name> [--slot N]    snapshot Mongo + Authentik DB + Gitea data
#   fixture.sh load  <name> --slot N      restore into slot N (starts it if needed)
#   fixture.sh check [--slot N]           verify Mongo references against Authentik
# A fixture is either a snapshot directory (fixtures/<name>/*.gz etc., from `save`)
# or a recipe directory with seed.py (fixtures/default). Loading into slot 0, the
# classic "ppdev" stack, needs --slot 0 --force-default.
set -euo pipefail
export NODE_ENV=development
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit "${1:-2}"; }
action=${1:-}; [[ -n $action ]] && shift || usage
name='' slot=0 force_default=false
[[ $action == list || $action == check || $action == -h || $action == --help ]] || { name=${1:-}; [[ -n $name ]] || usage; shift; }
while (( $# )); do
  case $1 in
    --slot) slot=${2:?--slot needs a number}; shift ;;
    --force-default) force_default=true ;;
    *) usage ;;
  esac
  shift
done
[[ -z $name || $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "ERROR: bad fixture name." >&2; exit 1; }
export STACK_SLOT=$slot
# shellcheck source=peopleportal/dev-stack/scripts/common.sh
source "$here/scripts/common.sh"
fx=$here/fixtures/$name

wait_healthy() { compose up -d --wait --wait-timeout 300 "$@" >&2; }

# Stop host server/UI around a snapshot so nothing writes mid-dump; restart after.
apps_were_running=false
pause_apps() {
  (( STACK_SLOT > 0 )) || return 0
  if [[ -s $STATE_DIR/server.pid ]] && kill -0 "$(<"$STATE_DIR/server.pid")" 2>/dev/null; then apps_were_running=true; fi
  "$here/scripts/slot.sh" stop-apps "$STACK_SLOT"
}
resume_apps() {
  [[ $apps_were_running == true ]] || return 0
  local dir; dir=$(<"$STATE_DIR/app.dir")
  "$here/scripts/slot.sh" server "$STACK_SLOT" --dir "$dir"
  "$here/scripts/slot.sh" ui "$STACK_SLOT" --dir "$dir"
}

gitea_image() { docker inspect --format '{{.Config.Image}}' "$(compose ps -aq gitea | head -1)"; }
gitea_volume() { printf '%s_gitea' "$COMPOSE_PROJECT_NAME"; }

save() {
  [[ ! -f $fx/seed.py ]] || die "'$name' is a recipe fixture; choose another name."
  require_docker; load_env
  local tmp; tmp=$(mktemp -d "$here/fixtures/.tmp.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  pause_apps
  echo "Saving slot $STACK_SLOT ($COMPOSE_PROJECT_NAME) as fixture '$name'..." >&2
  compose exec -T mongo mongodump --quiet --db people-portal --archive --gzip >"$tmp/mongo.archive.gz"
  compose exec -T postgres pg_dump -U authentik -Fc --no-owner --no-acl authentik >"$tmp/authentik.pgdump"
  # Gitea keeps SQLite + repos on disk: dump the volume while the container is stopped.
  compose stop gitea-oidc gitea >&2
  docker run --rm -v "$(gitea_volume):/data:ro" --entrypoint tar "$(gitea_image)" czf - -C /data . >"$tmp/gitea-data.tar.gz"
  wait_healthy gitea gitea-oidc
  cat >"$tmp/meta.env" <<META
SOURCE_SLOT=$STACK_SLOT
SOURCE_PROJECT=$COMPOSE_PROJECT_NAME
SOURCE_PORTAL_PORT=$PORTAL_PORT
SOURCE_PUBLIC_HOST=$PUBLIC_HOST
CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
META
  rm -rf -- "$fx"; mv "$tmp" "$fx"; trap - EXIT
  resume_apps
  echo "Saved: $fx ($(du -sh "$fx" | cut -f1))" >&2
}

reconcile_authentik() {
  # The restored DB carries the source slot's akadmin password, API token and OIDC
  # redirect URIs. Make them match this slot's .env, then reapply the blueprint.
  compose exec -T authentik-worker ak shell -c "
import os
from authentik.core.models import Token, TokenIntents, User
admin = User.objects.get(username='akadmin')
admin.set_password(os.environ['AUTHENTIK_BOOTSTRAP_PASSWORD']); admin.save()
Token.objects.update_or_create(identifier='authentik-bootstrap-token', defaults={
    'user': admin, 'intent': TokenIntents.INTENT_API, 'expiring': False,
    'key': os.environ['AUTHENTIK_BOOTSTRAP_TOKEN']})
" >/dev/null
  "$here/scripts/bootstrap-authentik.sh"
}

load_snapshot() {
  [[ -f $fx/meta.env ]] || die "Fixture '$name' not found (see: fixture.sh list)."
  # shellcheck disable=SC1091
  source "$fx/meta.env"
  echo "Loading '$name' (from slot $SOURCE_SLOT, $CREATED) into slot $STACK_SLOT..." >&2
  echo "  MongoDB" >&2
  compose exec -T mongo mongorestore --quiet --drop --archive --gzip <"$fx/mongo.archive.gz"
  echo "  Authentik database" >&2
  compose stop authentik-server authentik-worker gitea-oidc >&2
  compose exec -T postgres psql -U authentik -d postgres -v ON_ERROR_STOP=1 -q \
    -c 'DROP DATABASE IF EXISTS authentik WITH (FORCE)' -c 'CREATE DATABASE authentik OWNER authentik' >&2
  compose exec -T postgres pg_restore -U authentik -d authentik --no-owner --no-acl <"$fx/authentik.pgdump"
  wait_healthy authentik-server authentik-worker
  reconcile_authentik
  echo "  Gitea data" >&2
  compose stop gitea >&2
  docker run --rm -i -v "$(gitea_volume):/data" --entrypoint sh "$(gitea_image)" \
    -c 'find /data -mindepth 1 -delete && tar xzf - -C /data' <"$fx/gitea-data.tar.gz"
  wait_healthy gitea gitea-oidc
  # Restored admin carries the source slot's password; align it so bootstrap can mint a token.
  gitea_admin user change-password --username "$GITEA_ADMIN_USER" --password "$GITEA_ADMIN_PASSWORD" \
    --must-change-password=false >&2 2>/dev/null || true
  rm -f -- "$STATE_DIR/.gitea-token"
  "$here/scripts/bootstrap-gitea.sh"
  if [[ $SOURCE_PORTAL_PORT != "$PORTAL_PORT" ]]; then
    STATE_DIR=$STATE_DIR GITEA_PORT=$GITEA_PORT python3 "$here/scripts/gitea-rehook.py" "$SOURCE_PORTAL_PORT" "$PORTAL_PORT"
  fi
  echo "  Redis (cache flush) and Mailpit (clear inbox)" >&2
  compose exec -T redis redis-cli FLUSHALL >/dev/null
  curl --silent --fail --max-time 10 -X DELETE "http://127.0.0.1:$MAILPIT_PORT/api/v1/messages" >/dev/null || true
}

load_recipe() {
  echo "Seeding recipe '$name' into slot $STACK_SLOT..." >&2
  python3 "$fx/seed.py"
  compose exec -T redis redis-cli FLUSHALL >/dev/null
}

check() { python3 "$here/scripts/fixture-check.py"; }

case $action in
  list)
    for d in "$here"/fixtures/*/; do
      [[ -d $d ]] || continue
      n=$(basename "$d")
      if [[ -f $d/seed.py ]]; then printf '%-20s recipe (seeds a running slot)\n' "$n"
      elif [[ -f $d/meta.env ]]; then printf '%-20s snapshot %s\n' "$n" "$(sed -n 's/^CREATED=//p' "$d/meta.env")"; fi
    done ;;
  save) save ;;
  load)
    (( STACK_SLOT > 0 )) || [[ $force_default == true ]] || die "Refusing to overwrite the default stack; pick --slot N or pass --slot 0 --force-default."
    [[ -f $fx/seed.py || -f $fx/meta.env ]] || die "Fixture '$name' not found (see: fixture.sh list)."
    if [[ ! -f $ENV_FILE ]]; then "$here/scripts/up.sh" --slot "$STACK_SLOT"; fi
    require_docker; load_env
    compose up -d --wait --wait-timeout 300 >&2
    pause_apps
    if [[ -f $fx/seed.py ]]; then load_recipe; else load_snapshot; fi
    check || echo "WARNING: fixture has dangling cross-service references." >&2
    resume_apps
    echo "Fixture '$name' loaded into slot $STACK_SLOT." >&2
    "$here/scripts/slot.sh" urls "$STACK_SLOT" >&2 || true ;;
  check) require_docker; load_env; check ;;
  *) usage ;;
esac
