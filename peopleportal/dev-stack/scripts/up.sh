#!/usr/bin/env bash
# stdout: exact portal env block. Progress and verification go to stderr.
set -euo pipefail
# shellcheck source=peopleportal/dev-stack/scripts/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
write_env=false
case "${1:-}" in
  '') [[ $# -eq 0 ]] || die "Usage: $0 [--write-env]" ;;
  --write-env) [[ $# -eq 1 ]] || die "Usage: $0 [--write-env]"; write_env=true ;;
  --help|-h) echo "Usage: $0 [--write-env]"; exit 0 ;;
  *) die "Usage: $0 [--write-env]" ;;
esac
require_tools openssl python3
require_docker
cd -- "$STACK_DIR"
lock_stack
"$STACK_DIR/scripts/gen-env.sh"
load_env
compose config --quiet
print_ports
check_ports
echo 'Starting backing services (first pull and bootstrap can take several minutes)...' >&2
compose up -d --wait --wait-timeout 600 \
  postgres authentik-server authentik-worker gitea mongo redis mailpit gitea-oidc >&2
"$STACK_DIR/scripts/bootstrap-authentik.sh"
"$STACK_DIR/scripts/bootstrap-gitea.sh"
"$STACK_DIR/scripts/verify.sh" >&2
if [[ $write_env == true ]]; then
  "$STACK_DIR/scripts/portal-env.sh" --write-env
else
  "$STACK_DIR/scripts/portal-env.sh"
fi
