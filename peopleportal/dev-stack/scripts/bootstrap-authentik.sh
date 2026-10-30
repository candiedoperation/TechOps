#!/usr/bin/env bash
# Reapply the worker blueprint after default flows and signing keys are ready.
set -euo pipefail
# shellcheck source=peopleportal/dev-stack/scripts/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_docker
load_env
wait_url "http://127.0.0.1:$AUTHENTIK_PORT/-/health/ready/"
# Python comes from the pinned authentik image, never from the host.
credentials=$(compose exec -T authentik-worker python - <"$STACK_DIR/scripts/authentik-bootstrap.py")
[[ $credentials == *PORTAL_OIDC_CLIENT_SECRET=* && $credentials == *GITEA_OIDC_CLIENT_SECRET=* ]] || die "Authentik returned incomplete credentials."
private_file "$STACK_DIR/.oidc" <<<"$credentials"
echo "Authentik applications verified; credentials saved in .oidc (mode 600)." >&2
