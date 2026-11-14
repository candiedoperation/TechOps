#!/usr/bin/env bash
# Run a GitHub pull request on its own dev-stack slot (see ../PARALLEL.md).
#   pr.sh <pr> [--fixture NAME] [--no-start]   fetch the PR into a worktree, install deps,
#                                              start its slot, load a fixture (default:
#                                              "default"), start the server and UI
#   pr.sh <pr> --down [--purge]                stop the slot; --purge also deletes the slot's
#                                              data and removes the worktree
# Worktrees live in ${PP_PR_DIR:-$HOME/pp-pr}/<pr>, detached at the PR head. Scripts always
# run from THIS checkout; only the application code comes from the worktree. Re-running is
# safe: a clean worktree is moved to the new head, a dirty one is kept with a warning.
set -euo pipefail
export NODE_ENV=development   # the shell may export production; never inherit it
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit "${1:-2}"; }

pr=${1:-}
case $pr in -h|--help|help) usage 0 ;; esac
[[ $pr =~ ^[0-9]+$ ]] || usage
shift
fixture=default start=true down=false purge=false
while (( $# )); do
  case $1 in
    --fixture) fixture=${2:?--fixture needs a name}; shift ;;
    --no-start) start=false ;;
    --down) down=true ;;
    --purge) purge=true ;;
    -h|--help) usage 0 ;;
    *) usage ;;
  esac
  shift
done
[[ $purge == false || $down == true ]] || usage
[[ $fixture =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "ERROR: bad fixture name." >&2; exit 1; }

# shellcheck source=peopleportal/dev-stack/scripts/common.sh
STACK_SLOT=0 source "$here/scripts/common.sh"   # helpers only; child scripts pick the slot
require_tools git
repo=$(git -C "$here" rev-parse --show-toplevel)
pr_root=${PP_PR_DIR:-$HOME/pp-pr}
wt=$pr_root/$pr

recorded_slot() { awk -v pr="$pr" '$1 == pr {print $2}' "$here/slots/.prs" 2>/dev/null || true; }
is_worktree() { git -C "$repo" worktree list --porcelain | grep -qx "worktree $1"; }
dirty() { [[ -n $(git -C "$1" status --porcelain --untracked-files=normal) ]]; }

# --- down ------------------------------------------------------------------------
if [[ $down == true ]]; then
  slot=$(recorded_slot)
  if [[ -n $slot ]]; then
    if [[ $purge == true ]]; then "$here/scripts/slot.sh" down "$slot" --purge
    else "$here/scripts/slot.sh" down "$slot"; fi
  else
    echo "No slot recorded for PR #$pr (nothing to stop)." >&2
  fi
  if [[ $purge == true && -d $wt ]]; then
    wt=$(cd -- "$wt" && pwd -P)
    if ! is_worktree "$wt"; then
      echo "WARNING: $wt is not a worktree of $repo; leaving it alone." >&2
    elif dirty "$wt"; then
      echo "WARNING: $wt has local changes; kept. Remove it yourself with: git -C '$repo' worktree remove --force '$wt'" >&2
    else
      git -C "$repo" worktree remove "$wt"
      echo "Removed worktree $wt." >&2
    fi
    git -C "$repo" worktree prune
  fi
  exit 0
fi

# --- worktree --------------------------------------------------------------------
require_tools npm node python3
echo "Fetching PR #$pr from origin..." >&2
git -C "$repo" fetch --quiet origin "pull/$pr/head" || die "Could not fetch pull/$pr/head; is #$pr a pull request on origin?"
sha=$(git -C "$repo" rev-parse FETCH_HEAD)
short=${sha:0:8}
mkdir -p -- "$pr_root"
pr_root=$(cd -- "$pr_root" && pwd -P)
wt=$pr_root/$pr
if [[ -e $wt ]]; then
  is_worktree "$wt" || die "$wt exists but is not a worktree of $repo; move it away or set PP_PR_DIR."
  current=$(git -C "$wt" rev-parse HEAD)
  if [[ $current == "$sha" ]]; then
    echo "Worktree $wt already at $short." >&2
  elif dirty "$wt"; then
    echo "WARNING: $wt has local changes; keeping it at ${current:0:8} (PR head is $short)." >&2
  else
    git -C "$wt" checkout --quiet --detach "$sha"
    echo "Worktree $wt moved to $short." >&2
  fi
else
  git -C "$repo" worktree prune
  git -C "$repo" worktree add --quiet --detach "$wt" "$sha"
  echo "Worktree $wt created at $short." >&2
fi
[[ -d $wt/peopleportal/server && -d $wt/peopleportal/webui ]] || die "PR #$pr has no peopleportal/server + webui; nothing to run."
if ! grep -q PP_DEV_PORTAL_PORT "$wt/peopleportal/webui/vite.config.ts" 2>/dev/null; then
  echo "WARNING: this PR predates the Vite PP_DEV_* overrides (#105): its UI will proxy /api to localhost:3000, not to this slot's server." >&2
fi

# --- dependencies ----------------------------------------------------------------
# npm ci is skipped when node_modules already matches the lockfile (stamp = blob hash).
install_deps() { # dir
  local dir=$1 stamp=$1/node_modules/.pr-sh.lock want
  want=$(git -C "$dir" hash-object package-lock.json 2>/dev/null || echo none)
  if [[ -d $dir/node_modules && -f $stamp && $(<"$stamp") == "$want" ]]; then
    echo "Dependencies up to date: $dir" >&2
    return 0
  fi
  echo "Installing dependencies: $dir" >&2
  if ! (cd -- "$dir" && npm ci --no-audit --no-fund >&2); then
    echo "WARNING: npm ci failed in $dir (lockfile out of sync with package.json?); falling back to npm install --no-package-lock." >&2
    (cd -- "$dir" && npm install --no-audit --no-fund --no-package-lock >&2) || die "npm install failed in $dir"
  fi
  printf '%s\n' "$want" >"$stamp"
}
install_deps "$wt/peopleportal/server"
install_deps "$wt/peopleportal/webui"
# Safety net: nothing above may leave a lockfile modified in the worktree.
if git -C "$wt" ls-files --error-unmatch -- '*package-lock.json' >/dev/null 2>&1; then
  git -C "$wt" checkout --quiet -- '*package-lock.json'
fi

# --- stack, fixture, apps --------------------------------------------------------
slot=$(pr_to_slot "$pr")
echo "PR #$pr -> slot $slot" >&2
if [[ -f $here/slots/$slot/.env ]]; then "$here/scripts/slot.sh" stop-apps "$slot"; fi   # up.sh wants the host ports free
"$here/scripts/up.sh" --pr "$pr" >&2
"$here/scripts/fixture.sh" load "$fixture" --slot "$slot"
if [[ $start == true ]]; then
  "$here/scripts/slot.sh" server "pr:$pr" --dir "$wt/peopleportal"
  "$here/scripts/slot.sh" ui "pr:$pr" --dir "$wt/peopleportal"
fi

echo >&2
echo "PR #$pr ($short) is on slot $slot; code in $wt" >&2
"$here/scripts/slot.sh" urls "$slot" >&2
seed=$here/fixtures/$fixture/seed.py
if [[ -f $seed ]]; then
  password=$(sed -n 's/^PASSWORD = "\(.*\)"$/\1/p' "$seed")
  users=$(sed -n 's/^    ("\([A-Za-z0-9_-]*\)", .*/\1/p' "$seed" | tr '\n' ' ')
  echo "Seeded logins ($fixture): ${users}(password: $password)" >&2
else
  echo "Logins: the accounts stored in snapshot '$fixture'" >&2
fi
echo "Admin: akadmin / AUTHENTIK_BOOTSTRAP_PASSWORD in $here/slots/$slot/.env" >&2
if [[ $start == true ]]; then
  echo "Logs: $here/slots/$slot/logs/{server,ui}.log   Stop: scripts/pr.sh $pr --down [--purge]" >&2
else
  echo "Apps not started (--no-start). Start with: scripts/slot.sh server pr:$pr --dir $wt/peopleportal; scripts/slot.sh ui pr:$pr --dir $wt/peopleportal" >&2
fi
