#!/usr/bin/env bash
# stdout: exact portal env block (default stack). Progress and verification go to stderr.
#   up.sh [--write-env]            classic stack, project "ppdev", default ports
#   up.sh --slot N [--write-env]   independent stack N (1-99), see PARALLEL.md
#   up.sh --pr  N [--write-env]    same, with the slot allocated for PR N
# Slots always write slots/<slot>/portal.env + webui.env (--write-env is implied).
set -euo pipefail
export NODE_ENV=development
usage() { echo "Usage: $0 [--slot N | --pr N] [--write-env]" >&2; exit "${1:-2}"; }
write_env=false slot_arg='' pr_arg=''
while (( $# )); do
  case "$1" in
    --write-env) write_env=true ;;
    --slot) [[ $# -ge 2 ]] || usage; slot_arg=$2; shift ;;
    --pr) [[ $# -ge 2 ]] || usage; pr_arg=$2; shift ;;
    --help|-h) usage 0 ;;
    *) usage ;;
  esac
  shift
done
[[ -z $slot_arg || -z $pr_arg ]] || usage
[[ -z $slot_arg ]] || export STACK_SLOT=$slot_arg
# shellcheck source=peopleportal/dev-stack/scripts/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
if [[ -n $pr_arg ]]; then
  STACK_SLOT=$(pr_to_slot "$pr_arg")
  export STACK_SLOT
  if [[ $write_env == true ]]; then exec "$0" --slot "$STACK_SLOT" --write-env; fi
  exec "$0" --slot "$STACK_SLOT"
fi
require_tools openssl python3
require_docker
cd -- "$STACK_DIR"
lock_stack
"$STACK_DIR/scripts/gen-env.sh"
load_env
compose config --quiet
print_ports
check_ports
echo "Starting backing services for $COMPOSE_PROJECT_NAME (first pull and bootstrap can take several minutes)..." >&2
compose up -d --wait --wait-timeout 600 \
  postgres authentik-server authentik-worker gitea mongo redis mailpit gitea-oidc >&2
"$STACK_DIR/scripts/bootstrap-authentik.sh"
"$STACK_DIR/scripts/bootstrap-gitea.sh"
"$STACK_DIR/scripts/verify.sh" >&2
if (( STACK_SLOT > 0 )); then
  "$STACK_DIR/scripts/portal-env.sh" --write-env
  "$STACK_DIR/scripts/slot.sh" urls "$STACK_SLOT" >&2
elif [[ $write_env == true ]]; then
  "$STACK_DIR/scripts/portal-env.sh" --write-env
else
  "$STACK_DIR/scripts/portal-env.sh"
fi
