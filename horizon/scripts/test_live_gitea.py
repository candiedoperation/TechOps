#!/usr/bin/env python3
"""Live Gitea health-signal test.

Pulls real commit and PR activity from git.appdevclub.com for every team org
visible to the supplied token, constructs weekly aggregates for the past N
weeks, runs the MVP rule engine, and prints the resulting health signals.

Run from the repo root with the existing venv:

    PHI_GITEA_API_TOKEN=<token> .venv/bin/python scripts/test_live_gitea.py

Or pass the token directly:

    .venv/bin/python scripts/test_live_gitea.py --token <token>

No MongoDB or API server required — this script is entirely standalone.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

# ---------------------------------------------------------------------------
# Gitea API client (no external deps beyond httpx, which is in the venv)
# ---------------------------------------------------------------------------

ROOT = __file__
sys.path.insert(0, str(__import__("pathlib").Path(ROOT).resolve().parents[1]))

try:
    import httpx
except ImportError:
    sys.exit("httpx is required: pip install httpx")

GITEA_BASE = "https://git.appdevclub.com/api/v1"


def gitea(path: str, token: str, **params: Any) -> Any:
    url = f"{GITEA_BASE}{path}"
    headers = {"Authorization": f"token {token}"}
    with httpx.Client(timeout=15.0) as client:
        resp = client.get(url, headers=headers, params=params)
        resp.raise_for_status()
        return resp.json()


def paginate(path: str, token: str, **params: Any) -> list[Any]:
    results = []
    page = 1
    while True:
        batch = gitea(path, token, page=page, limit=50, **params)
        if not batch:
            break
        results.extend(batch)
        if len(batch) < 50:
            break
        page += 1
    return results


# ---------------------------------------------------------------------------
# Discover all team orgs
# ---------------------------------------------------------------------------

def search_all_repos(token: str) -> list[dict[str, Any]]:
    """Every repo the token can see, following pagination (search caps at 50/page)."""
    repos: list[dict[str, Any]] = []
    page = 1
    while page <= 40:
        data = gitea("/repos/search", token, page=page, limit=50)
        batch = data.get("data", []) if isinstance(data, dict) else (data or [])
        if not batch:
            break
        repos.extend(batch)
        if len(batch) < 50:
            break
        page += 1
    return repos


def list_team_orgs(token: str) -> list[dict[str, Any]]:
    """Return all orgs visible to the token that look like team orgs."""
    orgs: dict[str, dict[str, Any]] = {}
    for repo in search_all_repos(token):
        owner = repo.get("owner") or {}
        login = owner.get("login")
        if not login:
            continue
        # Skip personal accounts (no capital letters typical of team slugs)
        if owner.get("source_id", 0) != 0:
            continue
        if login not in orgs:
            orgs[login] = {
                "login": login,
                "full_name": owner.get("full_name", login),
                "website": owner.get("website", ""),
                "repos": [],
            }
        orgs[login]["repos"].append(repo["name"])
    return list(orgs.values())


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def select_orgs(orgs: list[dict[str, Any]], wanted: str, token: str) -> list[dict[str, Any]]:
    """Resolve --org against discovered orgs: exact login, then fuzzy name match."""
    exact = [o for o in orgs if o["login"] == wanted]
    if exact:
        return exact

    needle = _norm(wanted)
    fuzzy = [
        o for o in orgs
        if needle and (needle in _norm(o["login"]) or needle in _norm(o.get("full_name", "")))
    ]
    if fuzzy:
        return fuzzy

    # Not in the search index (private/unindexed repos) — try the org endpoint directly.
    for candidate in {wanted, wanted.replace(" ", "")}:
        try:
            org = gitea(f"/orgs/{candidate}", token)
        except Exception:
            continue
        if org and org.get("username"):
            return [{
                "login": org["username"],
                "full_name": org.get("full_name") or org["username"],
                "website": org.get("website", ""),
                "repos": [],
            }]
    return []


def list_repo_branches(org: str, repo: str, token: str) -> list[str]:
    try:
        return [b["name"] for b in paginate(f"/repos/{org}/{repo}/branches", token)]
    except Exception:
        return []


def fetch_repo_commits(
    org: str,
    repo: str,
    token: str,
    *,
    since: datetime | None = None,
    all_branches: bool = True,
) -> list[dict[str, Any]]:
    """Every commit in a repo, deduped by SHA.

    ``/repos/{org}/{repo}/commits`` walks the default branch only.  Passing
    ``sha=<branch>`` walks that branch instead, so the union over all branches
    is what "everything that was ever contributed" actually means.
    """

    refs: list[str | None] = [None]
    if all_branches:
        refs += [b for b in list_repo_branches(org, repo, token)]

    seen: dict[str, dict[str, Any]] = {}
    for ref in refs:
        params: dict[str, Any] = {}
        if since is not None:
            params["since"] = since.astimezone(timezone.utc).isoformat()
        if ref is not None:
            params["sha"] = ref
        try:
            batch = paginate(f"/repos/{org}/{repo}/commits", token, **params)
        except Exception:
            continue
        for commit in batch:
            sha = commit.get("sha") or commit.get("id")
            if sha and sha not in seen:
                seen[sha] = commit
    return list(seen.values())


def list_org_repos(org: str, token: str) -> list[str]:
    try:
        repos = paginate(f"/orgs/{org}/repos", token)
        return [r["name"] for r in repos if not r.get("empty", False)]
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Build weekly activity buckets
# ---------------------------------------------------------------------------

def parse_ts(value: Any) -> datetime | None:
    """Parse a Gitea timestamp and normalise it to UTC.

    Gitea echoes git's own committer date, which carries the committer's local
    UTC offset (e.g. ``2026-03-05T10:14:00-07:00``).  Bucketing such a value
    without converting first produces a week key of ``Mon 00:00-07:00``, which
    is a *different* dict key from the ``Mon 00:00+00:00`` keys the report is
    assembled from, so the activity silently disappears.
    """

    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def iso_week_start(dt: datetime) -> datetime:
    """Return the Monday (UTC) of the ISO week containing dt."""
    dt = dt.astimezone(timezone.utc)
    return (dt - timedelta(days=dt.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


def fetch_org_activity(
    org: str, repos: list[str], token: str, weeks: int = 6, all_time: bool = False
) -> list[dict[str, Any]]:
    """Return a list of weekly aggregate dicts for the org, newest first."""
    now = datetime.now(timezone.utc)
    since = None if all_time else now - timedelta(weeks=weeks + 1)

    # Buckets keyed by ISO week start (Monday midnight UTC)
    commits_by_week: dict[datetime, int] = defaultdict(int)
    active_days_by_week: dict[datetime, set[str]] = defaultdict(set)
    pr_created_by_week: dict[datetime, list[datetime]] = defaultdict(list)
    pr_merged_by_week: dict[datetime, int] = defaultdict(int)
    pr_review_latency_by_week: dict[datetime, list[float]] = defaultdict(list)
    open_prs_by_week: dict[datetime, int] = defaultdict(int)
    oldest_open_pr_by_week: dict[datetime, float] = defaultdict(float)
    pr_records: list[dict[str, Any]] = []

    for repo in repos:
        # Commits — every branch, deduped by SHA.  The bare /commits endpoint
        # walks the default branch only, so work that lived on feature
        # branches (or was rebased/force-pushed) never appears.
        for c in fetch_repo_commits(org, repo, token, since=since):
            ts = parse_ts(
                c.get("commit", {}).get("committer", {}).get("date")
                or c.get("commit", {}).get("author", {}).get("date")
                or c.get("created")
            )
            if ts is None:
                continue
            wk = iso_week_start(ts)
            commits_by_week[wk] += 1
            active_days_by_week[wk].add(ts.strftime("%Y-%m-%d"))

        # Pull requests.  state=all in one pass; "closed" alone would miss
        # open PRs and two passes double-count nothing but cost twice as much.
        try:
            prs = paginate(f"/repos/{org}/{repo}/pulls", token, state="all")
        except Exception:
            prs = []
        for pr in prs:
            created = parse_ts(pr.get("created_at"))
            merged = parse_ts(pr.get("merged_at"))
            closed = parse_ts(pr.get("closed_at")) or merged
            if created is None:
                continue

            pr_records.append({"created": created, "merged": merged, "closed": closed})
            pr_created_by_week[iso_week_start(created)].append(created)

            if merged is not None:
                # A merge belongs to the week it merged in, not the week the
                # PR was opened.
                mwk = iso_week_start(merged)
                pr_merged_by_week[mwk] += 1
                latency = (merged - created).total_seconds() / 86_400
                pr_review_latency_by_week[mwk].append(latency)

    # Assemble weekly records, newest first
    week_starts = sorted(
        {iso_week_start(now - timedelta(weeks=i)) for i in range(weeks + 1)},
        reverse=True,
    )

    # A PR that is still open counts as open in *every* week between the week
    # it was opened and the week it closed (or now).  Attributing it only to
    # its creation week made the stale-PR signal blind to the weeks where the
    # PR was actually sitting there unreviewed.
    for wk in week_starts:
        week_end = min(wk + timedelta(days=7), now)
        outstanding = [
            record for record in pr_records
            if record["created"] <= week_end
            and (record["closed"] is None or record["closed"] > week_end)
        ]
        open_prs_by_week[wk] = len(outstanding)
        oldest_open_pr_by_week[wk] = max(
            ((week_end - record["created"]).total_seconds() / 86_400 for record in outstanding),
            default=0.0,
        )
    records = []
    for wk in week_starts:
        active = active_days_by_week.get(wk, set())
        latencies = pr_review_latency_by_week.get(wk, [])
        records.append({
            "week_start": wk.strftime("%Y-%m-%d"),
            "active_days": len(active),
            "commits": commits_by_week.get(wk, 0),
            "merged_count": pr_merged_by_week.get(wk, 0),
            "open_prs": open_prs_by_week.get(wk, 0),
            "oldest_open_pr_days": round(oldest_open_pr_by_week.get(wk, 0.0), 1),
            "review_latency_days": (
                round(sum(latencies) / len(latencies), 1) if latencies else 0.0
            ),
            "days_since_activity": (
                (now - max(
                    (parse_ts(d + "T00:00:00+00:00") for d in active),
                    default=now - timedelta(days=99),
                )).days
                if active else 99
            ),
            # Contributor counts require per-person data — omitted by design
            "active_contributors": None,
            "team_size": None,
        })
    return records


# ---------------------------------------------------------------------------
# Run the rule engine
# ---------------------------------------------------------------------------

def run_rules(history: list[dict[str, Any]]) -> dict[str, Any]:
    from backend.rules import evaluate_mvp_rules
    # Pass newest-first list; rules expect newest last internally — they handle both
    return evaluate_mvp_rules(history)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token", default=os.getenv("PHI_GITEA_API_TOKEN", ""))
    parser.add_argument("--weeks", type=int, default=6, help="Weeks of history to pull")
    parser.add_argument("--org", default=None, help="Limit to one org (default: all)")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")
    parser.add_argument("--all-time", action="store_true",
                        help="Pull the full commit history, not just the report window")
    parser.add_argument("--list-orgs", action="store_true",
                        help="List every discovered org and exit")
    args = parser.parse_args()

    if not args.token:
        sys.exit("No token. Set PHI_GITEA_API_TOKEN or pass --token.")

    print("Discovering team orgs on git.appdevclub.com …")
    orgs = list_team_orgs(args.token)

    if args.list_orgs:
        if not orgs:
            sys.exit("No orgs visible to this token.")
        print(f"Found {len(orgs)} org(s):\n")
        for o in sorted(orgs, key=lambda x: x["login"].lower()):
            print(f"   {o['login']:<40} {o['full_name']}")
            print(f"   {'':<40} repos: {', '.join(sorted(o['repos'])) or '(none indexed)'}")
        return

    if args.org:
        matched = select_orgs(orgs, args.org, args.token)
        if not matched:
            print(f"No org matched '{args.org}'. Visible orgs:", file=sys.stderr)
            for o in sorted(orgs, key=lambda x: x["login"].lower()):
                print(f"   {o['login']}  ({o['full_name']})", file=sys.stderr)
            sys.exit(1)
        orgs = matched
    if not orgs:
        sys.exit("No orgs found.")

    print(f"Found {len(orgs)} org(s): {', '.join(o['login'] for o in orgs)}\n")

    all_results: list[dict[str, Any]] = []

    for org in orgs:
        login = org["login"]
        repos = list_org_repos(login, args.token) or org["repos"]
        print(f"━━ {org['full_name']} ({login})")
        print(f"   Repos: {', '.join(repos)}")
        print(f"   Pulling {args.weeks} weeks of activity …", end=" ", flush=True)

        history = fetch_org_activity(
            login, repos, args.token, weeks=args.weeks, all_time=args.all_time
        )
        print("done")

        # Summary table
        print(f"   {'Week':<12} {'Commits':>7} {'ActiveDays':>10} "
              f"{'MergedPRs':>9} {'OpenPRs':>7} {'OldestPR(d)':>11}")
        for rec in history:
            print(f"   {rec['week_start']:<12} {rec['commits']:>7} "
                  f"{rec['active_days']:>10} {rec['merged_count']:>9} "
                  f"{rec['open_prs']:>7} {rec['oldest_open_pr_days']:>11.1f}")

        # Run rule engine (skip contributor rules — no identity data)
        try:
            signals = run_rules(list(reversed(history)))  # oldest-first for rules
            triggered = {
                k: v for k, v in signals.items()
                if v.get("evidence") is not None
            }
            insufficient = {
                k: v for k, v in signals.items()
                if not v.get("meets_minimum_data", True)
            }

            print("\n   Health signals:")
            if not triggered and not insufficient:
                print("   ✓  All signals CLEAR")
            for rule_id, result in triggered.items():
                ev = result["evidence"]
                print(f"   ⚠  {rule_id}: current={result.get('value')} "
                      f"baseline={round(result.get('baseline', 0), 1)} "
                      f"→ {ev.get('title', rule_id)}")
            if insufficient:
                print(f"   ℹ  Insufficient data for: "
                      f"{', '.join(insufficient.keys())} "
                      f"(need ≥4 prior weeks)")
        except Exception as exc:
            print(f"   Rule engine error: {exc}")
            signals = {}

        result_entry = {
            "org": login,
            "full_name": org["full_name"],
            "repos": repos,
            "history": history,
            "signals": signals if "signals" in dir() else {},
        }
        all_results.append(result_entry)
        print()

    if args.json:
        print(json.dumps(all_results, indent=2, default=str))


if __name__ == "__main__":
    main()
