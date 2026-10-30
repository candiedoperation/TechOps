#!/usr/bin/env bash
# Delete only this Compose project's backing volumes, keeping generated secrets.
set -euo pipefail
# shellcheck source=peopleportal/dev-stack/scripts/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_docker
load_env
case "${1:-}" in
  --yes) [[ $# -eq 1 ]] || die "Usage: $0 [--yes]" ;;
  '')
    [[ $# -eq 0 && -t 0 ]] || die "Reset deletes all local stack data. Use --yes for noninteractive reset."
    read -r -p "Delete ALL volumes for $COMPOSE_PROJECT_NAME? Type reset: " answer
    [[ $answer == reset ]] || die "Reset cancelled."
    ;;
  *) die "Usage: $0 [--yes]" ;;
esac
lock_stack
compose down --volumes --remove-orphans
rm -f -- "$STACK_DIR/.oidc" "$STACK_DIR/.gitea-token"
echo 'Volumes removed; .env and the server env were preserved. Run scripts/up.sh to bootstrap again.' >&2
echo 'The Gitea API token changes after reset. Replace it in the server env using the printed block.' >&2
