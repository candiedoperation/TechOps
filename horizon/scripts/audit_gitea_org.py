#!/usr/bin/env python3
"""Exhaustive contribution audit for a Gitea org.

Unlike ``test_live_gitea.py`` (which aggregates a bounded window into weekly
buckets for the rule engine), this script answers a simpler question: *what
was ever contributed to this org?*  It walks every repo, every branch, every
commit, every pull request and every review, dedupes, and prints per-repo and
per-contributor totals.

    PHI_GITEA_API_TOKEN=<token> .venv/bin/python scripts/audit_gitea_org.py --org Mitsubishi

Add ``--json audit.json`` to dump the raw normalised records.

Notes on the two traps this script exists to avoid:

* ``/repos/{owner}/{repo}/commits`` returns the **default branch only**.  Work
  that lived on feature branches is invisible unless each branch is walked
  explicitly via ``sha=<branch>``.
* Gitea echoes git's committer date verbatim, so timestamps carry the
  committer's local UTC offset.  Every timestamp here is normalised to UTC
  before it is bucketed or compared.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

try:
    import httpx
except ImportError:  # pragma: no cover
    sys.exit("httpx is required: pip install httpx")

GITEA_BASE = os.getenv("PHI_GITEA_URL", "https://git.appdevclub.com").rstrip("/") + "/api/v1"
PAGE_SIZE = 50
MAX_PAGES = 200


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Gitea:
    def __init__(self, token: str, timeout: float = 30.0) -> None:
        self._client = httpx.Client(
            timeout=timeout,
            headers={"Authorization": f"token {token}"},
            follow_redirects=True,
        )
        self.calls = 0

    def close(self) -> None:
        self._client.close()

    def get(self, path: str, **params: Any) -> Any:
        self.calls += 1
        resp = self._client.get(f"{GITEA_BASE}{path}", params=params)
        resp.raise_for_status()
        return resp.json()

    def pages(self, path: str, **params: Any) -> list[Any]:
        """Follow pagination until a short page, an empty page, or MAX_PAGES."""
        out: list[Any] = []
        for page in range(1, MAX_PAGES + 1):
            batch = self.get(path, page=page, limit=PAGE_SIZE, **params)
            if isinstance(batch, dict):
                batch = batch.get("data", [])
            if not batch:
                break
            out.extend(batch)
            if len(batch) < PAGE_SIZE:
                break
        return out

    def try_pages(self, path: str, **params: Any) -> list[Any]:
        try:
            return self.pages(path, **params)
        except Exception as exc:  # noqa: BLE001 - diagnostics, keep going
            print(f"   !  {path} failed: {type(exc).__name__}: {exc}", file=sys.stderr)
            return []


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def parse_ts(value: Any) -> datetime | None:
    """Parse a Gitea timestamp and normalise it to UTC."""
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
    dt = dt.astimezone(timezone.utc)
    return (dt - timedelta(days=dt.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


def fmt(dt: datetime | None) -> str:
    return dt.strftime("%Y-%m-%d %H:%M UTC") if dt else "—"


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

def actor(payload: dict[str, Any], *, fallback: dict[str, Any] | None = None) -> str:
    """Best available human identity for a commit or PR.

    Gitea only fills ``author.login`` when the commit email is linked to an
    account; unlinked commits keep their identity in the raw git header.
    """
    if isinstance(payload, dict):
        login = payload.get("login") or payload.get("username")
        if login:
            return str(login)
    if fallback:
        name = fallback.get("name")
        email = fallback.get("email")
        if name and email:
            return f"{name} <{email}>"
        if name:
            return str(name)
        if email:
            return str(email)
    return "(unknown)"


# ---------------------------------------------------------------------------
# Org discovery
# ---------------------------------------------------------------------------

def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def discover_orgs(api: Gitea) -> list[dict[str, Any]]:
    orgs: dict[str, dict[str, Any]] = {}
    for repo in api.try_pages("/repos/search"):
        owner = repo.get("owner") or {}
        login = owner.get("login")
        if not login or owner.get("source_id", 0) != 0:
            continue
        orgs.setdefault(login, {
            "login": login,
            "full_name": owner.get("full_name") or login,
            "repos": [],
        })["repos"].append(repo.get("name"))
    # Orgs the token belongs to but whose repos are not in the search index.
    for org in api.try_pages("/user/orgs"):
        login = org.get("username")
        if login:
            orgs.setdefault(login, {
                "login": login,
                "full_name": org.get("full_name") or login,
                "repos": [],
            })
    return list(orgs.values())


def resolve_org(api: Gitea, orgs: list[dict[str, Any]], wanted: str) -> list[dict[str, Any]]:
    exact = [o for o in orgs if o["login"] == wanted]
    if exact:
        return exact
    needle = _norm(wanted)
    fuzzy = [
        o for o in orgs
        if needle and (needle in _norm(o["login"]) or needle in _norm(o["full_name"]))
    ]
    if fuzzy:
        return fuzzy
    for candidate in {wanted, wanted.replace(" ", "")}:
        try:
            org = api.get(f"/orgs/{candidate}")
        except Exception:
            continue
        if org.get("username"):
            return [{"login": org["username"],
                     "full_name": org.get("full_name") or org["username"],
                     "repos": []}]
    return []


# ---------------------------------------------------------------------------
# Collection
# ---------------------------------------------------------------------------

def org_repos(api: Gitea, org: str, seeded: Iterable[str] = ()) -> list[dict[str, Any]]:
    repos = api.try_pages(f"/orgs/{org}/repos")
    if repos:
        return repos
    return [{"name": name, "default_branch": None, "empty": False} for name in seeded if name]


def collect_repo(
    api: Gitea, org: str, repo: str, *, all_branches: bool, with_reviews: bool
) -> dict[str, Any]:
    branches = [b.get("name") for b in api.try_pages(f"/repos/{org}/{repo}/branches")]
    branches = [b for b in branches if b]

    refs: list[str | None] = [None] + (branches if all_branches else [])
    commits: dict[str, dict[str, Any]] = {}
    branch_of: dict[str, set[str]] = defaultdict(set)

    for ref in refs:
        params = {"sha": ref} if ref else {}
        for raw in api.try_pages(f"/repos/{org}/{repo}/commits", **params):
            sha = raw.get("sha") or raw.get("id")
            if not sha:
                continue
            branch_of[sha].add(ref or "(default)")
            if sha in commits:
                continue
            body = raw.get("commit") or {}
            git_author = body.get("author") or {}
            git_committer = body.get("committer") or {}
            ts = parse_ts(git_committer.get("date") or git_author.get("date") or raw.get("created"))
            commits[sha] = {
                "sha": sha,
                "repo": repo,
                "when": ts,
                "author": actor(raw.get("author") or {}, fallback=git_author),
                "raw_author_email": git_author.get("email"),
                "message": (body.get("message") or "").strip().splitlines()[:1],
                "is_merge": len(raw.get("parents") or []) > 1,
            }
    for sha, refs_seen in branch_of.items():
        if sha in commits:
            commits[sha]["branches"] = sorted(refs_seen)

    prs: list[dict[str, Any]] = []
    for raw in api.try_pages(f"/repos/{org}/{repo}/pulls", state="all"):
        number = raw.get("number")
        record = {
            "repo": repo,
            "number": number,
            "title": raw.get("title"),
            "state": raw.get("state"),
            "author": actor(raw.get("user") or {}),
            "created": parse_ts(raw.get("created_at")),
            "merged": parse_ts(raw.get("merged_at")),
            "closed": parse_ts(raw.get("closed_at")),
            "merged_by": actor(raw.get("merged_by") or {}) if raw.get("merged_by") else None,
            "reviewers": [],
        }
        if with_reviews and number is not None:
            for review in api.try_pages(f"/repos/{org}/{repo}/pulls/{number}/reviews"):
                who = actor(review.get("user") or {})
                when = parse_ts(review.get("submitted_at") or review.get("created_at"))
                record["reviewers"].append({
                    "who": who,
                    "state": review.get("state"),
                    "when": when,
                })
        prs.append(record)

    return {
        "repo": repo,
        "branches": branches,
        "commits": sorted(commits.values(), key=lambda c: c["when"] or datetime.min.replace(tzinfo=timezone.utc)),
        "pulls": prs,
    }


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def report(org: dict[str, Any], repos: list[dict[str, Any]], *, show_weeks: bool) -> None:
    all_commits = [c for r in repos for c in r["commits"]]
    all_prs = [p for r in repos for p in r["pulls"]]
    dated = [c["when"] for c in all_commits if c["when"]]

    print(f"\n━━ {org['full_name']} ({org['login']})")
    print(f"   Repos: {len(repos)} · Commits: {len(all_commits)} "
          f"(merge commits: {sum(1 for c in all_commits if c['is_merge'])}) · PRs: {len(all_prs)}")
    print(f"   First commit: {fmt(min(dated) if dated else None)}")
    print(f"   Last  commit: {fmt(max(dated) if dated else None)}")

    print(f"\n   {'Repo':<28} {'Branches':>8} {'Commits':>8} {'PRs':>5} "
          f"{'Merged':>7} {'Open':>5}")
    for r in repos:
        merged = sum(1 for p in r["pulls"] if p["merged"])
        opened = sum(1 for p in r["pulls"] if p["state"] == "open")
        print(f"   {r['repo']:<28} {len(r['branches']):>8} {len(r['commits']):>8} "
              f"{len(r['pulls']):>5} {merged:>7} {opened:>5}")

    commit_counts = Counter(c["author"] for c in all_commits)
    pr_counts = Counter(p["author"] for p in all_prs)
    merge_counts = Counter(p["author"] for p in all_prs if p["merged"])
    review_counts = Counter(
        rv["who"] for p in all_prs for rv in p["reviewers"]
    )
    people = sorted(
        set(commit_counts) | set(pr_counts) | set(review_counts),
        key=lambda who: (-commit_counts[who], -pr_counts[who], who.lower()),
    )
    print(f"\n   {'Contributor':<44} {'Commits':>8} {'PRs':>5} {'Merged':>7} {'Reviews':>8}")
    for who in people:
        print(f"   {who[:44]:<44} {commit_counts[who]:>8} {pr_counts[who]:>5} "
              f"{merge_counts[who]:>7} {review_counts[who]:>8}")

    if show_weeks and dated:
        by_week_commits: Counter[datetime] = Counter()
        by_week_days: dict[datetime, set[str]] = defaultdict(set)
        for c in all_commits:
            if not c["when"]:
                continue
            wk = iso_week_start(c["when"])
            by_week_commits[wk] += 1
            by_week_days[wk].add(c["when"].strftime("%Y-%m-%d"))
        by_week_merged: Counter[datetime] = Counter()
        by_week_opened: Counter[datetime] = Counter()
        for p in all_prs:
            if p["created"]:
                by_week_opened[iso_week_start(p["created"])] += 1
            if p["merged"]:
                by_week_merged[iso_week_start(p["merged"])] += 1

        weeks = sorted(
            set(by_week_commits) | set(by_week_merged) | set(by_week_opened), reverse=True
        )
        print(f"\n   Weeks with activity ({len(weeks)} of "
              f"{((max(dated) - min(dated)).days // 7) + 1} elapsed):")
        print(f"   {'Week':<12} {'Commits':>8} {'ActiveDays':>11} {'PRsOpened':>10} {'PRsMerged':>10}")
        for wk in weeks:
            print(f"   {wk.strftime('%Y-%m-%d'):<12} {by_week_commits[wk]:>8} "
                  f"{len(by_week_days[wk]):>11} {by_week_opened[wk]:>10} {by_week_merged[wk]:>10}")


def jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [jsonable(v) for v in value]
    return value


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token", default=os.getenv("PHI_GITEA_API_TOKEN", ""))
    parser.add_argument("--org", default=None, help="Org login or a fuzzy fragment of its name")
    parser.add_argument("--repo", default=None, help="Limit to a single repo")
    parser.add_argument("--list-orgs", action="store_true")
    parser.add_argument("--default-branch-only", action="store_true",
                        help="Skip per-branch walks (matches the old, lossy behaviour)")
    parser.add_argument("--no-reviews", action="store_true",
                        help="Skip per-PR review fetch (one request per PR)")
    parser.add_argument("--no-weeks", action="store_true", help="Hide the weekly table")
    parser.add_argument("--json", dest="json_path", default=None,
                        help="Write the full normalised record set to this path")
    args = parser.parse_args()

    if not args.token:
        sys.exit("No token. Set PHI_GITEA_API_TOKEN or pass --token.")

    api = Gitea(args.token)
    try:
        print(f"Discovering orgs on {GITEA_BASE.rsplit('/api', 1)[0]} …")
        orgs = discover_orgs(api)

        if args.list_orgs:
            for o in sorted(orgs, key=lambda x: x["login"].lower()):
                print(f"   {o['login']:<40} {o['full_name']}")
            return

        if args.org:
            orgs = resolve_org(api, orgs, args.org)
            if not orgs:
                sys.exit(f"No org matched '{args.org}'. Try --list-orgs.")

        payload = []
        for org in orgs:
            repos = org_repos(api, org["login"], org.get("repos", []))
            names = [r["name"] for r in repos if not r.get("empty")]
            if args.repo:
                names = [n for n in names if n == args.repo]
            print(f"   {org['login']}: walking {len(names)} repo(s) …", flush=True)

            collected = [
                collect_repo(
                    api, org["login"], name,
                    all_branches=not args.default_branch_only,
                    with_reviews=not args.no_reviews,
                )
                for name in names
            ]
            report(org, collected, show_weeks=not args.no_weeks)
            payload.append({"org": org, "repos": collected})

        print(f"\n({api.calls} API requests)")

        if args.json_path:
            with open(args.json_path, "w", encoding="utf-8") as handle:
                json.dump(jsonable(payload), handle, indent=2)
            print(f"Wrote {args.json_path}")
    finally:
        api.close()


if __name__ == "__main__":
    main()
