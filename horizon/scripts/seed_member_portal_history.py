#!/usr/bin/env python3
"""Replace member-portal / member-portal-api with a volatile 3-month history.

Run this after `seed_live_gitea.py` (which seeds the rest of the portfolio
with a uniform 10-week pattern). This script deletes and recreates just the
two Member Portal repos with thirteen weeks (~3 months) of irregular,
realistic activity: sprint weeks, a post-launch lull, a holiday week, a
vacation week with zero commits, multiple named contributors, and pull
requests that are merged, abandoned (closed unmerged), or left open and
aging — instead of one steady trend line.

Every commit, PR, review, and merge is a real object created through Gitea's
HTTP API (or `git push`), exactly like `seed_live_gitea.py`. Gitea cannot
backdate any of these on creation, so timestamps are rewritten afterward
directly in its sqlite database, the same technique `seed_live_gitea.py`
already uses for commit dates via `GIT_AUTHOR_DATE`.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time as time_module
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from seed_live_gitea import request_json, request_json_retrying, run  # noqa: E402


REPOS = {
    "member-portal": "PeoplePortalUI",
    "member-portal-api": "PeoplePortalServer",
}

CONTRIBUTORS = [
    {"username": "priya-n", "name": "Priya N", "email": "priya.n@example.invalid"},
    {"username": "alex-r", "name": "Alex Rivera", "email": "alex.rivera@example.invalid"},
    {"username": "sam-d", "name": "Sam Delgado", "email": "sam.delgado@example.invalid"},
    {"username": "jordan-k", "name": "Jordan Kim", "email": "jordan.kim@example.invalid"},
]
CONTRIBUTOR_PASSWORD = "LocalMock!2026"

# 13 weeks, oldest first. `contributors` are indexes into CONTRIBUTORS.
# `prs` outcomes: "merged", "abandoned" (closed unmerged), "open" (left
# unresolved -- realistic for the two most recent weeks).
WEEK_STORY: list[dict[str, Any]] = [
    {"active_days": 4, "contributors": [0, 1], "prs": [{"latency": 8, "outcome": "merged"}]},
    {"active_days": 3, "contributors": [0, 2], "prs": [{"latency": 14, "outcome": "merged"}]},
    {  # launch crunch
        "active_days": 5,
        "contributors": [0, 1, 2, 3],
        "prs": [
            {"latency": 4, "outcome": "merged"},
            {"latency": 6, "outcome": "merged"},
            {"latency": 5, "outcome": "merged"},
        ],
    },
    {"active_days": 2, "contributors": [1], "prs": []},  # post-launch lull
    {"active_days": 3, "contributors": [0, 2], "prs": [{"latency": 20, "outcome": "merged"}]},
    {
        "active_days": 4,
        "contributors": [0, 1, 3],
        "prs": [{"latency": 9, "outcome": "merged"}, {"latency": 11, "outcome": "merged"}],
    },
    {"active_days": 1, "contributors": [2], "prs": []},  # holiday week
    {"active_days": 3, "contributors": [1, 2], "prs": [{"latency": 36, "outcome": "abandoned"}]},
    {
        "active_days": 4,
        "contributors": [0, 1, 2],
        "prs": [{"latency": 10, "outcome": "merged"}, {"latency": 7, "outcome": "merged"}],
    },
    {"active_days": 0, "contributors": [], "prs": []},  # team vacation week
    {  # catch-up crunch, backlog reviews slow
        "active_days": 5,
        "contributors": [0, 1, 2, 3],
        "prs": [
            {"latency": 24, "outcome": "merged"},
            {"latency": 30, "outcome": "merged"},
            {"latency": 18, "outcome": "merged"},
        ],
    },
    {"active_days": 4, "contributors": [0, 3], "prs": [{"latency": 6, "outcome": "merged"}]},
    {  # current week: aging, unresolved
        "active_days": 3,
        "contributors": [0, 1],
        "prs": [{"latency": 5, "outcome": "open"}, {"latency": 9, "outcome": "open"}],
    },
]

COMMIT_HOURS = [9, 11, 14, 16]


def ensure_contributors(url: str, admin_basic: str) -> None:
    for contributor in CONTRIBUTORS:
        request_json(
            f"{url}/api/v1/admin/users",
            "POST",
            {
                "username": contributor["username"],
                "email": contributor["email"],
                "password": CONTRIBUTOR_PASSWORD,
                "must_change_password": False,
            },
            admin_basic,
        )


def recreate_repo(repo: str, url: str, organization: str, admin_basic: str) -> None:
    request_json(f"{url}/api/v1/repos/{organization}/{repo}", "DELETE", None, admin_basic)
    request_json(
        f"{url}/api/v1/orgs/{organization}/repos",
        "POST",
        {"name": repo, "description": "Project Health live-test fixture", "default_branch": "main", "private": False},
        admin_basic,
    )
    for contributor in CONTRIBUTORS:
        request_json(
            f"{url}/api/v1/repos/{organization}/{repo}/collaborators/{contributor['username']}",
            "PUT",
            {"permission": "write"},
            admin_basic,
        )


def add_source_snapshot(source: Path | None, destination: Path, repo: str) -> None:
    if source and (source / ".git").exists():
        archive = subprocess.Popen(["git", "archive", "HEAD"], cwd=source, stdout=subprocess.PIPE)
        subprocess.run(["tar", "-x", "-C", str(destination)], stdin=archive.stdout, check=True)
        if archive.stdout:
            archive.stdout.close()
        if archive.wait() != 0:
            raise RuntimeError(f"could not archive {source}")
    else:
        (destination / "README.md").write_text(
            f"# {repo}\n\nSynthetic repository used by the Project Health live-stack test.\n"
        )


def seed_commits(worktree: Path, weeks: list[tuple[date, dict[str, Any]]]) -> int:
    commits = 0
    for week_index, (monday, week) in enumerate(weeks):
        active_days = week["active_days"]
        contributor_indexes = week["contributors"] or [None]
        for day_index in range(active_days):
            contributor = CONTRIBUTORS[contributor_indexes[day_index % len(contributor_indexes)]] if week["contributors"] else None
            hour = COMMIT_HOURS[day_index % len(COMMIT_HOURS)]
            when = datetime.combine(monday + timedelta(days=day_index), time(hour, 0), timezone.utc)
            note = worktree / ".project-health-activity.jsonl"
            with note.open("a") as handle:
                handle.write(f'{{"week": "{monday.isoformat()}", "day": {day_index + 1}}}\n')
            run("git", "add", ".", cwd=worktree)
            author_name = contributor["name"] if contributor else "Project Health Seeder"
            author_email = contributor["email"] if contributor else "project-health@example.invalid"
            commit_env = {
                **os.environ,
                "GIT_AUTHOR_NAME": author_name,
                "GIT_AUTHOR_EMAIL": author_email,
                "GIT_AUTHOR_DATE": when.isoformat(),
                "GIT_COMMITTER_NAME": author_name,
                "GIT_COMMITTER_EMAIL": author_email,
                "GIT_COMMITTER_DATE": when.isoformat(),
            }
            run("git", "commit", "-m", f"week {week_index + 1} change {day_index + 1}", cwd=worktree, env=commit_env)
            commits += 1
    return commits


def seed_pull_requests(
    repo: str,
    worktree: Path,
    url: str,
    organization: str,
    admin_basic: str,
    weeks: list[tuple[date, dict[str, Any]]],
) -> list[dict[str, Any]]:
    prs: list[dict[str, Any]] = []
    for week_index, (monday, week) in enumerate(weeks):
        contributor_indexes = week["contributors"]
        for pr_index, pr_spec in enumerate(week["prs"]):
            author = CONTRIBUTORS[contributor_indexes[pr_index % len(contributor_indexes)]]
            author_basic = "Basic " + base64.b64encode(f"{author['username']}:{CONTRIBUTOR_PASSWORD}".encode()).decode()
            branch = f"feature/week-{week_index + 1}-{pr_index + 1}"
            run("git", "checkout", "main", cwd=worktree)
            run("git", "fetch", "origin", "main", cwd=worktree)
            run("git", "reset", "--hard", "origin/main", cwd=worktree)
            run("git", "checkout", "-b", branch, cwd=worktree)
            opened_at = datetime.combine(monday, time(10, 0), timezone.utc) + timedelta(days=min(week["active_days"], 4) or 1)
            note = worktree / "PULL_REQUESTS.md"
            with note.open("a") as handle:
                handle.write(f"- week {week_index + 1} PR {pr_index + 1} by {author['name']} ({monday.isoformat()})\n")
            run("git", "add", ".", cwd=worktree)
            commit_env = {
                **os.environ,
                "GIT_AUTHOR_NAME": author["name"],
                "GIT_AUTHOR_EMAIL": author["email"],
                "GIT_AUTHOR_DATE": opened_at.isoformat(),
                "GIT_COMMITTER_NAME": author["name"],
                "GIT_COMMITTER_EMAIL": author["email"],
                "GIT_COMMITTER_DATE": opened_at.isoformat(),
            }
            run("git", "commit", "-m", f"week {week_index + 1} PR {pr_index + 1}", cwd=worktree, env=commit_env)
            author_auth_header = base64.b64encode(f"{author['username']}:{CONTRIBUTOR_PASSWORD}".encode()).decode()
            run(
                "git",
                "-c",
                f"http.extraHeader=Authorization: Basic {author_auth_header}",
                "push",
                "--force",
                "-u",
                "origin",
                branch,
                cwd=worktree,
            )

            created = request_json_retrying(
                f"{url}/api/v1/repos/{organization}/{repo}/pulls",
                "POST",
                {"head": branch, "base": "main", "title": f"Week {week_index + 1} update ({author['name']})"},
                author_basic,
            )
            pr_number = created.get("number")
            if pr_number is None:
                continue

            request_json_retrying(
                f"{url}/api/v1/repos/{organization}/{repo}/pulls/{pr_number}/reviews",
                "POST",
                {"event": "APPROVE", "body": "Looks good."},
                admin_basic,
            )
            review_at = opened_at + timedelta(hours=pr_spec["latency"])
            outcome = pr_spec["outcome"]
            merged_at = None
            closed_at = None
            if outcome == "merged":
                request_json_retrying(
                    f"{url}/api/v1/repos/{organization}/{repo}/pulls/{pr_number}/merge",
                    "POST",
                    {"Do": "merge"},
                    admin_basic,
                )
                merged_at = review_at + timedelta(hours=4)
            elif outcome == "abandoned":
                request_json_retrying(
                    f"{url}/api/v1/repos/{organization}/{repo}/issues/{pr_number}",
                    "PATCH",
                    {"state": "closed"},
                    admin_basic,
                )
                closed_at = review_at + timedelta(hours=2)

            prs.append(
                {
                    "number": pr_number,
                    "opened_at": opened_at,
                    "review_at": review_at,
                    "merged_at": merged_at,
                    "closed_at": closed_at,
                }
            )
    run("git", "checkout", "main", cwd=worktree)
    return prs


def backdate(compose_file: Path, repo: str, organization: str, prs: list[dict[str, Any]]) -> None:
    if not prs:
        return
    statements = ["PRAGMA busy_timeout=10000;"]
    for pr in prs:
        number = pr["number"]
        opened_ts = int(pr["opened_at"].timestamp())
        review_ts = int(pr["review_at"].timestamp())
        merged_ts = int(pr["merged_at"].timestamp()) if pr["merged_at"] else None
        closed_ts = int(pr["closed_at"].timestamp()) if pr["closed_at"] else None
        resolved_ts = merged_ts or closed_ts
        issue_where = (
            f"repo_id=(SELECT id FROM repository WHERE owner_name='{organization}' AND lower_name='{repo}') "
            f"AND `index`={number}"
        )
        issue_scope = f"(SELECT id FROM issue WHERE {issue_where})"
        set_clause = f"created_unix={opened_ts}, updated_unix={resolved_ts or review_ts}"
        if resolved_ts:
            set_clause += f", closed_unix={resolved_ts}, is_closed=1"
        statements.append(f"UPDATE issue SET {set_clause} WHERE {issue_where};")
        statements.append(f"UPDATE review SET created_unix={review_ts}, updated_unix={review_ts} WHERE issue_id={issue_scope};")
        if merged_ts:
            statements.append(f"UPDATE pull_request SET merged_unix={merged_ts} WHERE issue_id={issue_scope};")
    script = "\n".join(statements)
    last_error: subprocess.CalledProcessError | None = None
    for attempt in range(5):
        try:
            subprocess.run(
                ["docker", "compose", "-f", str(compose_file), "exec", "-T", "gitea", "sqlite3", "/data/gitea/gitea.db"],
                input=script,
                text=True,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            return
        except subprocess.CalledProcessError as error:
            last_error = error
            if "database is locked" not in str(error.stderr or ""):
                raise
            time_module.sleep(1 + attempt)
    raise last_error  # type: ignore[misc]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:10000")
    parser.add_argument("--admin-username", default="phi-admin")
    parser.add_argument("--admin-password", default="phi-local-admin-password")
    parser.add_argument("--organization", default="appdev")
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--through", type=date.fromisoformat, default=date.today())
    parser.add_argument(
        "--compose-file",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "compose.live-test.yaml",
    )
    args = parser.parse_args()

    admin_basic = "Basic " + base64.b64encode(f"{args.admin_username}:{args.admin_password}".encode()).decode()
    ensure_contributors(args.url, admin_basic)

    latest_monday = args.through - timedelta(days=args.through.weekday())
    weeks = [(latest_monday - timedelta(weeks=(12 - index)), story) for index, story in enumerate(WEEK_STORY)]

    total_commits = 0
    total_prs = 0
    total_merged = 0
    total_abandoned = 0
    for repo, source_name in REPOS.items():
        recreate_repo(repo, args.url, args.organization, admin_basic)
        source = args.workspace / source_name if source_name else None
        with tempfile.TemporaryDirectory(prefix=f"phi-{repo}-") as temporary:
            worktree = Path(temporary)
            add_source_snapshot(source if source and source.exists() else None, worktree, repo)
            run("git", "init", "-b", "main", cwd=worktree)
            run("git", "config", "user.name", "Project Health Seeder", cwd=worktree)
            run("git", "config", "user.email", "project-health@example.invalid", cwd=worktree)

            total_commits += seed_commits(worktree, weeks)

            remote = f"{args.url}/{args.organization}/{repo}.git"
            run("git", "remote", "add", "origin", remote, cwd=worktree)
            admin_auth_header = base64.b64encode(f"{args.admin_username}:{args.admin_password}".encode()).decode()
            run(
                "git",
                "-c",
                f"http.extraHeader=Authorization: Basic {admin_auth_header}",
                "push",
                "--force",
                "-u",
                "origin",
                "main",
                cwd=worktree,
            )

            prs = seed_pull_requests(repo, worktree, args.url, args.organization, admin_basic, weeks)
            backdate(args.compose_file, repo, args.organization, prs)
            total_prs += len(prs)
            total_merged += sum(1 for pr in prs if pr["merged_at"] is not None)
            total_abandoned += sum(1 for pr in prs if pr["closed_at"] is not None)

    print(
        json.dumps(
            {
                "status": "ok",
                "repositories": list(REPOS),
                "weeks": len(WEEK_STORY),
                "commits": total_commits,
                "pull_requests": total_prs,
                "merged": total_merged,
                "abandoned": total_abandoned,
                "open": total_prs - total_merged - total_abandoned,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
