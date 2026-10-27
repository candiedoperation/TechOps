#!/usr/bin/env bash
# Read-only checks for every included backing service.
set -euo pipefail
# shellcheck source=peopleportal/dev-stack/scripts/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_docker
load_env
print_ports
failures=0
check() {
  local label=$1
  shift
  if "$@"; then
    echo "PASS: $label"
  else
    echo "FAIL: $label" >&2
    failures=$((failures + 1))
  fi
}

healthy() {
  local id state
  id=$(compose ps --all --quiet "$1") || return 1
  [[ -n $id ]] || return 1
  state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id") || return 1
  [[ $state == 'running healthy' ]]
}

http_200() {
  local code
  code=$(curl --silent --show-error --fail --max-time 10 --output /dev/null --write-out '%{http_code}' "$1") || return 1
  [[ $code == 200 ]]
}

discovery_scope() {
  curl --silent --show-error --fail --max-time 10 \
    "http://127.0.0.1:$AUTHENTIK_PORT/application/o/people-portal/.well-known/openid-configuration" | \
    compose exec -T authentik-worker python -c \
      'import json,sys; sys.exit(0 if "people_portal" in json.load(sys.stdin)["scopes_supported"] else 1)'
}

gitea_source() {
  local sources
  sources=$(gitea_admin auth list) || return 1
  awk '$2 == "authentik" {found=1} END {exit !found}' <<<"$sources"
}

gitea_discovery() {
  # Exercises the network namespace bridge and public URL, not just its health.
  compose exec -T gitea wget -q --spider \
    "$AUTHENTIK_URL/application/o/gitea/.well-known/openid-configuration"
}

redis_ping() {
  local response
  response=$(compose exec -T redis redis-cli ping) || return 1
  [[ $response == PONG ]]
}

for service in postgres authentik-server authentik-worker gitea gitea-oidc mongo redis mailpit; do
  check "container $service healthy" healthy "$service"
done
check 'authentik discovery HTTP 200' http_200 "http://127.0.0.1:$AUTHENTIK_PORT/application/o/people-portal/.well-known/openid-configuration"
check 'authentik discovery includes people_portal scope' discovery_scope
check 'Gitea API version HTTP 200' http_200 "http://127.0.0.1:$GITEA_PORT/api/v1/version"
check 'Gitea authentik auth source exists' gitea_source
check 'Gitea can discover authentik via public OIDC URL' gitea_discovery
check 'MongoDB ping' compose exec -T mongo mongosh --quiet --eval "quit(db.adminCommand('ping').ok ? 0 : 1)"
check 'MongoDB writable replica set' compose exec -T mongo mongosh --quiet --eval "const h = db.hello(); quit(h.setName === 'ppdev' && h.isWritablePrimary ? 0 : 1)"
check 'Redis PONG' redis_ping
check 'Mailpit API HTTP 200' http_200 "http://127.0.0.1:$MAILPIT_PORT/api/v1/messages"
if (( failures > 0 )); then die "$failures smoke check(s) failed."; fi
echo 'NOTE: S3 object storage is not included in this environment yet; resume/avatar uploads will fail until a local S3 option is added.'
echo 'All included-service smoke checks passed.'
