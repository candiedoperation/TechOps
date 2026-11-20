#!/usr/bin/env bash
# One-terminal dev: backing services (up.sh) then portal server + UI through Nx.
# Ctrl-C stops the host apps only; stop containers with `docker compose stop` in dev-stack/.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "$HERE/../../.." && pwd)"

node -e 'process.exit(+process.versions.node.split(".")[0] < 22)' || {
  echo "Node 22+ required (found: $(node -v 2>/dev/null || echo none))." >&2; exit 1; }

# up.sh checks Docker/openssl/python3. Its stdout is the secret env block, so discard it;
# --write-env saves it to server/.env.development only if that file is absent.
"$HERE/up.sh" --write-env >/dev/null

# shortcut: inotify misses edits on WSL's /mnt/c mount, so poll there; other setups keep native watching.
[[ $REPO == /mnt/* ]] && export CHOKIDAR_USEPOLLING=1

cd "$REPO"
exec ./nx run-many -t serve -p pplserver pplui
