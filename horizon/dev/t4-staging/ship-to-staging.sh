#!/usr/bin/env bash
# From your Mac: copy a branch's horizon/ folder to the staging box and run
# Track 4 there. The branch does not need to be pushed.
#
#   bash horizon/dev/t4-staging/ship-to-staging.sh [BRANCH] [-- run-on-staging.sh options]
#
#   BRANCH   default t4/7c-staging-runner (Michael's T4.1-T4.4 plus T4.5/T4.6
#            and this harness); any branch that contains dev/t4-staging works.
#   Options after -- go to run-on-staging.sh: --tests, --ui, --down.
#
# Needs `ssh appdev-staging` to work (see claude/horizon-staging.md). On the box
# it writes only /opt/horizon-t4/<branch> and the horizon-t4-* containers.
set -euo pipefail

BRANCH="${1:-t4/7c-staging-runner}"
shift || true
[ "${1:-}" = "--" ] && shift
HOST="${STAGING_HOST:-appdev-staging}"
# One shared connection for the upload, the run and the report, so a key
# passphrase is asked for once.
MUX=(-o ControlMaster=auto -o "ControlPath=/tmp/ship-t4-%C" -o ControlPersist=120)
REPO="$(git rev-parse --show-toplevel)"
DEST="/opt/horizon-t4/$(echo "$BRANCH" | tr '/' '-')"

git -C "$REPO" rev-parse --verify --quiet "$BRANCH^{commit}" >/dev/null \
  || { echo "No branch $BRANCH in $REPO." >&2; exit 1; }
git -C "$REPO" cat-file -e "$BRANCH:horizon/dev/t4-staging/run-on-staging.sh" 2>/dev/null \
  || { echo "$BRANCH has no horizon/dev/t4-staging; use a branch from the Track 4 stack." >&2; exit 1; }

COMMIT="$(git -C "$REPO" rev-parse --short "$BRANCH")"
echo "Shipping $BRANCH ($COMMIT) to $HOST:$DEST"
# Only committed files travel: no .env, no .venv, no local edits.
git -C "$REPO" archive --format=tar "$BRANCH" horizon \
  | ssh "${MUX[@]}" "$HOST" "rm -rf '$DEST' && mkdir -p '$DEST' && tar -x -C '$DEST' && echo '$COMMIT' > '$DEST/COMMIT'"

# ANTHROPIC_API_KEY is deliberately not forwarded: staging uses fallbacks.
ssh -t "${MUX[@]}" "$HOST" "cd '$DEST/horizon' && bash dev/t4-staging/run-on-staging.sh $*"

if [ "${1:-}" != "--down" ]; then
  OUT="$REPO/horizon/dev/t4-staging"
  mkdir -p "$OUT"
  if ssh "${MUX[@]}" "$HOST" "tar -C '$DEST/horizon/dev/t4-staging' -cf - out" | tar -xf - -C "$OUT"; then
    echo "Copied the v1 vs v2 compare report to horizon/dev/t4-staging/out/."
  else
    echo "Could not copy the report back; it is on $HOST in $DEST/horizon/dev/t4-staging/out/." >&2
  fi
fi
ssh "${MUX[@]}" -O exit "$HOST" 2>/dev/null || true
