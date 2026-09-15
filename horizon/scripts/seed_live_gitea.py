#!/usr/bin/env python3
"""Seed local Gitea with real project snapshots and ten weeks of activity.

In addition to commit history, this seeds real pull requests: each fixture
week opens a branch/PR, a self-review is submitted, and all but the most
recent two weeks are merged. Gitea's API cannot backdate PR/review timestamps
on creation, so after creation the same rows are backdated directly in
Gitea's sqlite database via `docker compose exec`, the same technique already
used for commit dates (`GIT_AUTHOR_DATE`). The data still flows through real
Gitea HTTP APIs when the pipeline pulls it; only the seeding step touches the
database directly.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import tempfile
import time as time_module
import urllib.error
import urllib.request
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any


REPOSITORIES = {
    "member-portal": "PeoplePortalUI",
    "member-portal-api": "PeoplePortalServer",
    "campus-events": "AppDev-CorpWiki",
    "design-system": "PeoplePortalUI",
    "design-tokens": None,
    "alumni-network": "AppDev-CorpWiki",
    "onboarding-refresh": "PeoplePortalServer",
    "mobile-lab": None,
    "winter-campaign": None,
}


def request_json(url: str, method: str = "GET", payload: Any = None, auth: str | None = None) -> Any:
    headers = {"Accept": "application/json"}
    if auth:
        headers["Authorization"] = auth
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode(errors="replace")
        if error.code in {409, 422}:
            return {"status": "exists", "detail": raw}
        raise RuntimeError(f"{method} {url} failed with {error.code}: {raw}") from error


def run(*args: str, cwd: Path, env: dict[str, str] | None = None) -> None:
    subprocess.run(args, cwd=cwd, env=env, check=True, stdout=subprocess.DEVNULL)


def request_json_retrying(url: str, method: str, payload: Any, auth: str, attempts: int = 6) -> Any:
    """Gitea processes a freshly pushed branch/PR asynchronously (indexing,
    mergeability), so a request immediately after can 404 or 405 with "try
    again later" before that catches up."""

    last_error: RuntimeError | None = None
    for attempt in range(attempts):
        try:
            return request_json(url, method, payload, auth)
        except RuntimeError as error:
            last_error = error
            message = str(error).lower()
            if "try again later" not in message and "failed with 404" not in message:
                raise
            time_module.sleep(1 + attempt)
    raise last_error  # type: ignore[misc]


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


def seed_pull_requests(
    repo: str,
    worktree: Path,
    auth_header: str,
    basic: str,
    url: str,
    organization: str,
    weeks: list[tuple[date, int]],
) -> list[dict[str, Any]]:
    """Open, self-review, and merge a real PR per active week; return backdate targets."""

    prs: list[dict[str, Any]] = []
    for week_index, (monday, active_days) in enumerate(weeks):
        if active_days == 0:
            continue
        branch = f"pr-week-{week_index + 1}"
        # Each branch must fork from the latest merged remote `main`, not the
        # stale local one, or two branches that append to the same file at
        # the same anchor point produce a genuine merge conflict.
        run("git", "-c", f"http.extraHeader=Authorization: Basic {auth_header}", "fetch", "origin", "main", cwd=worktree)
        run("git", "checkout", "main", cwd=worktree)
        run("git", "reset", "--hard", "origin/main", cwd=worktree)
        run("git", "checkout", "-b", branch, cwd=worktree)
        opened_at = datetime.combine(monday, time(9, 0), timezone.utc) + timedelta(days=1)
        note = worktree / "PULL_REQUESTS.md"
        with note.open("a") as handle:
            handle.write(f"- week {week_index + 1} change ({monday.isoformat()})\n")
        run("git", "add", ".", cwd=worktree)
        commit_env = {**os.environ, "GIT_AUTHOR_DATE": opened_at.isoformat(), "GIT_COMMITTER_DATE": opened_at.isoformat()}
        run("git", "commit", "-m", f"pr change {week_index + 1}", cwd=worktree, env=commit_env)
        run("git", "-c", f"http.extraHeader=Authorization: Basic {auth_header}", "push", "--force", "-u", "origin", branch, cwd=worktree)

        created = request_json_retrying(
            f"{url}/api/v1/repos/{organization}/{repo}/pulls",
            "POST",
            {"head": branch, "base": "main", "title": f"Week {week_index + 1} update"},
            basic,
        )
        pr_number = created.get("number")
        if pr_number is None:
            continue

        # Real reviews and merges: self-review is submitted as a COMMENT
        # (Gitea rejects self-APPROVE), and all but the two most recent weeks
        # are merged so `open_prs` reflects a realistic, currently-aging tail.
        request_json_retrying(
            f"{url}/api/v1/repos/{organization}/{repo}/pulls/{pr_number}/reviews",
            "POST",
            {"event": "COMMENT", "body": "Looks good."},
            basic,
        )
        review_at = opened_at + timedelta(hours=6 + week_index * 6)
        is_recent = week_index >= len(weeks) - 2
        merged_at = None
        if not is_recent:
            request_json_retrying(
                f"{url}/api/v1/repos/{organization}/{repo}/pulls/{pr_number}/merge",
                "POST",
                {"Do": "merge"},
                basic,
            )
            merged_at = review_at + timedelta(hours=4)

        prs.append(
            {
                "number": pr_number,
                "opened_at": opened_at,
                "review_at": review_at,
                "merged_at": merged_at,
            }
        )

    run("git", "checkout", "main", cwd=worktree)
    return prs


def backdate_pull_requests(compose_file: Path, repo: str, organization: str, prs: list[dict[str, Any]]) -> None:
    """Rewrite Gitea's sqlite timestamps so PRs/reviews land in their fixture week.

    Gitea's create/review/merge APIs always stamp `now`; there is no request
    parameter to backdate them. This mirrors the commit-date technique above
    (`GIT_AUTHOR_DATE`) at the database layer so history reads as if it
    happened across the ten fixture weeks instead of all today.
    """

    if not prs:
        return
    statements = []
    for pr in prs:
        number = pr["number"]
        opened_ts = int(pr["opened_at"].timestamp())
        review_ts = int(pr["review_at"].timestamp())
        merged_ts = int(pr["merged_at"].timestamp()) if pr["merged_at"] else None
        updated_ts = merged_ts or review_ts
        issue_scope = (
            f"(SELECT id FROM issue WHERE repo_id="
            f"(SELECT id FROM repository WHERE owner_name='{organization}' AND lower_name='{repo}') "
            f"AND `index`={number})"
        )
        statements.append(
            f"UPDATE issue SET created_unix={opened_ts}, updated_unix={updated_ts}"
            + (f", closed_unix={merged_ts}, is_closed=1" if merged_ts else "")
            + f" WHERE repo_id=(SELECT id FROM repository WHERE owner_name='{organization}' AND lower_name='{repo}') AND `index`={number};"
        )
        statements.append(f"UPDATE review SET created_unix={review_ts}, updated_unix={review_ts} WHERE issue_id={issue_scope};")
        if merged_ts:
            statements.append(f"UPDATE pull_request SET merged_unix={merged_ts} WHERE issue_id={issue_scope};")
    script = "PRAGMA busy_timeout=10000;\n" + "\n".join(statements)
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
            if b"database is locked" not in (error.stderr or b"") and "database is locked" not in str(error.stderr or ""):
                raise
            time_module.sleep(1 + attempt)
    raise last_error  # type: ignore[misc]


def seed_history(
    repo: str,
    source: Path | None,
    remote: str,
    auth_header: str,
    basic: str,
    url: str,
    organization: str,
    through: date,
    compose_file: Path,
) -> dict[str, int]:
    with tempfile.TemporaryDirectory(prefix=f"phi-{repo}-") as temporary:
        worktree = Path(temporary)
        add_source_snapshot(source, worktree, repo)
        run("git", "init", "-b", "main", cwd=worktree)
        run("git", "config", "user.name", "Project Health Seeder", cwd=worktree)
        run("git", "config", "user.email", "project-health@example.invalid", cwd=worktree)
        activity = worktree / ".project-health-activity.jsonl"
        latest_monday = through - timedelta(days=through.weekday())
        weeks = []
        for offset in reversed(range(10)):
            monday = latest_monday - timedelta(weeks=offset)
            active_days = 1 if offset == 0 and repo in {"member-portal", "design-system"} else 4
            if repo == "winter-campaign" and offset < 4:
                active_days = 0
            weeks.append((monday, active_days))

        commits = 0
        for week_index, (monday, active_days) in enumerate(weeks):
            for day_index in range(active_days):
                when = datetime.combine(monday + timedelta(days=day_index), time(14, 0), timezone.utc)
                with activity.open("a") as handle:
                    handle.write(json.dumps({"repo": repo, "week": monday.isoformat(), "day": day_index + 1}) + "\n")
                run("git", "add", ".", cwd=worktree)
                commit_env = {**os.environ, "GIT_AUTHOR_DATE": when.isoformat(), "GIT_COMMITTER_DATE": when.isoformat()}
                run("git", "commit", "-m", f"mock activity {week_index + 1}.{day_index + 1}", cwd=worktree, env=commit_env)
                commits += 1

        run("git", "remote", "add", "origin", remote, cwd=worktree)
        run("git", "-c", f"http.extraHeader=Authorization: Basic {auth_header}", "push", "--force", "-u", "origin", "main", cwd=worktree)

        prs = seed_pull_requests(repo, worktree, auth_header, basic, url, organization, weeks)
        backdate_pull_requests(compose_file, repo, organization, prs)
        merged = sum(1 for pr in prs if pr["merged_at"] is not None)
        return {"commits": commits, "pull_requests": len(prs), "merged": merged, "open": len(prs) - merged}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:10000")
    parser.add_argument("--username", default="phi-admin")
    parser.add_argument("--password", default="phi-local-admin-password")
    parser.add_argument("--organization", default="appdev")
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--token-file", type=Path, default=Path(__file__).resolve().parent.parent / ".live-test-token")
    parser.add_argument("--through", type=date.fromisoformat, default=date.today())
    parser.add_argument(
        "--compose-file",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "compose.live-test.yaml",
    )
    args = parser.parse_args()

    basic_bytes = base64.b64encode(f"{args.username}:{args.password}".encode()).decode()
    basic = f"Basic {basic_bytes}"
    request_json(
        f"{args.url}/api/v1/orgs",
        "POST",
        {"username": args.organization, "full_name": "App Dev Mock Portfolio", "visibility": "public"},
        basic,
    )

    tokens = request_json(f"{args.url}/api/v1/users/{args.username}/tokens", auth=basic)
    for token in tokens if isinstance(tokens, list) else []:
        if token.get("name") == "project-health-live-test":
            request_json(f"{args.url}/api/v1/users/{args.username}/tokens/{token['id']}", "DELETE", auth=basic)
    created = request_json(
        f"{args.url}/api/v1/users/{args.username}/tokens",
        "POST",
        {"name": "project-health-live-test", "scopes": ["read:repository", "read:organization"]},
        basic,
    )
    token = created.get("sha1") or created.get("token")
    if not token:
        raise RuntimeError(f"Gitea did not return an access token: {created}")
    args.token_file.write_text(str(token) + "\n")
    args.token_file.chmod(0o600)

    total_commits = 0
    total_prs = 0
    total_merged = 0
    for repo, source_name in REPOSITORIES.items():
        request_json(
            f"{args.url}/api/v1/orgs/{args.organization}/repos",
            "POST",
            {"name": repo, "description": "Project Health live-test fixture", "default_branch": "main", "private": False},
            basic,
        )
        source = args.workspace / source_name if source_name else None
        result = seed_history(
            repo,
            source if source and source.exists() else None,
            f"{args.url}/{args.organization}/{repo}.git",
            basic_bytes,
            basic,
            args.url,
            args.organization,
            args.through,
            args.compose_file,
        )
        total_commits += result["commits"]
        total_prs += result["pull_requests"]
        total_merged += result["merged"]

    print(
        json.dumps(
            {
                "status": "ok",
                "organization": args.organization,
                "repositories": len(REPOSITORIES),
                "commits": total_commits,
                "pull_requests": total_prs,
                "merged": total_merged,
                "open": total_prs - total_merged,
                "token_file": str(args.token_file),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
