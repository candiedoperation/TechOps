"""One-off repair: drop weekly snapshots judged on truncated Gitea history.

Until ``_header_has_more`` landed in ``backend.ingestion``, ``pages()`` decided
"last page" from ``len(page_items) >= page_size``. This Gitea caps pages at 50
while the readers ask for 100, so every commit-list fetch returned only the 50
newest commits on the default branch -- and Gitea ignores ``since``/``until``
entirely, so the client-side week filter then dropped nearly all of them. Any
week older than those 50 commits was judged as "No code activity this week".

``weekly_snapshots`` is immutable by design, so those verdicts are frozen and
every cumulative checkpoint built on them inherits the error. This script
deletes only the rows that provably disagree with the repository -- a cached
"no work" verdict for a week whose default branch really does carry commits --
plus their warning rows, so ``generate_llm_snapshot`` recomputes them.

Rows generated after the fix are left alone even when they read as quiet: those
are real judgments about trivial changes, not truncation artifacts.

Usage:
    .venv/bin/python scripts/purge_truncated_snapshots.py            # dry run
    .venv/bin/python scripts/purge_truncated_snapshots.py --apply
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import sqlite3
import sys
import urllib.parse
import urllib.request

# When _header_has_more landed. Snapshots generated at or after this instant
# saw complete history and are trustworthy.
PAGINATION_FIX_AT = dt.datetime(2026, 8, 21, 9, 23, 59, tzinfo=dt.timezone.utc)

# Cached verdicts that claim no substantive work happened.
QUIET_VOLUMES = {"none", "trivial"}

DB_PATH = "data/project_health_intelligence.db"
SIGNAL_VERSION = "llm-signal-v1"


def load_env(path: str = ".env") -> dict[str, str]:
    env: dict[str, str] = {}
    if os.path.exists(path):
        with open(path) as handle:
            for line in handle:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    env[key] = value
    env.setdefault("PHI_GITEA_URL", os.environ.get("PHI_GITEA_URL", ""))
    env.setdefault("PHI_GITEA_API_TOKEN", os.environ.get("PHI_GITEA_API_TOKEN", ""))
    return env


def gitea_get(base: str, token: str, path: str, params: dict | None = None):
    if params:
        path = f"{path}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(base + path, headers={"Authorization": f"token {token}"})
    with urllib.request.urlopen(request, timeout=60) as response:
        headers = {key.lower(): value for key, value in response.headers.items()}
        return json.load(response), headers


def week_start(value: dt.date) -> dt.date:
    return value - dt.timedelta(days=value.weekday())


def commit_counts(base: str, token: str, org: str, slug: str) -> collections.Counter:
    """Per-ISO-week commit counts on a repo's default branch, fully paginated."""
    counts: collections.Counter = collections.Counter()
    for page in range(1, 200):
        commits, headers = gitea_get(
            base, token, f"/api/v1/repos/{org}/{slug}/commits", {"page": page, "limit": 50}
        )
        for commit in commits:
            when = dt.date.fromisoformat(commit["commit"]["committer"]["date"][:10])
            counts[week_start(when)] += 1
        if str(headers.get("x-hasmore", "")).lower() != "true":
            break
    return counts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="actually delete (default: dry run)")
    parser.add_argument("--db", default=DB_PATH)
    args = parser.parse_args()

    env = load_env()
    base = env["PHI_GITEA_URL"].rstrip("/")
    token = env["PHI_GITEA_API_TOKEN"]
    if not base or not token:
        print("PHI_GITEA_URL / PHI_GITEA_API_TOKEN are required", file=sys.stderr)
        return 2

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row

    # Current boundary per project -> (org, repo slugs).
    bounds: dict[str, tuple[str, list[str]]] = {}
    for row in db.execute("select * from boundaries"):
        data = json.loads(row["data"])
        if data.get("effective_to"):
            continue
        bounds[row["project_id"]] = (
            data["root_authentik_team_id"],
            [ref["repo_slug"] for ref in data["primary_repos"]],
        )

    truth: dict[str, collections.Counter] = {}
    for project_id, (org, slugs) in sorted(bounds.items()):
        counter: collections.Counter = collections.Counter()
        for slug in slugs:
            counter.update(commit_counts(base, token, org, slug))
        truth[project_id] = counter
        print(f"  ground truth: {project_id:34} {sum(counter.values()):5} commits on default branches")

    doomed: list[tuple[str, str, str, int, str]] = []
    for row in db.execute(
        "select * from weekly_snapshots where rule_set_version = ?", (SIGNAL_VERSION,)
    ):
        data = json.loads(row["data"])
        generated = dt.datetime.fromisoformat(row["generated_at"].replace("Z", "+00:00"))
        if generated >= PAGINATION_FIX_AT:
            continue
        if (data.get("signal_work_volume") or "none") not in QUIET_VOLUMES:
            continue
        real = truth.get(row["project_id"], collections.Counter()).get(
            dt.date.fromisoformat(row["week_start"]), 0
        )
        if real < 1:
            continue
        doomed.append(
            (row["id"], row["project_id"], row["week_start"], real, data.get("signal_headline") or "")
        )

    print(f"\n{len(doomed)} snapshot(s) contradicted by the repository:\n")
    for _id, project_id, week, real, headline in sorted(doomed, key=lambda item: (item[1], item[2])):
        print(f"  {project_id:34} {week}  real_commits={real:3}  | {headline}")

    if not doomed:
        return 0

    ids = [item[0] for item in doomed]
    placeholders = ",".join("?" * len(ids))
    warning_count = db.execute(
        f"select count(*) from warnings where snapshot_id in ({placeholders})", ids
    ).fetchone()[0]
    print(f"\n  ...plus {warning_count} warning row(s) attached to them")

    if not args.apply:
        print("\nDry run. Re-run with --apply to delete.")
        return 0

    db.execute(f"delete from warnings where snapshot_id in ({placeholders})", ids)
    # weekly_snapshots carries DELETE/UPDATE immutability triggers. Dropping and
    # recreating them around a maintenance delete is the same pattern
    # SQLiteStore.clear() uses; the DDL below is copied verbatim from
    # backend.db._SCHEMA_SQL so the guarantee is restored exactly as it was.
    db.execute("DROP TRIGGER IF EXISTS trig_snapshots_no_delete")
    try:
        db.execute(f"delete from weekly_snapshots where id in ({placeholders})", ids)
    finally:
        db.execute(
            """CREATE TRIGGER IF NOT EXISTS trig_snapshots_no_delete
                   BEFORE DELETE ON weekly_snapshots
               BEGIN
                   SELECT RAISE(ABORT, 'weekly snapshots are immutable');
               END"""
        )
    db.commit()

    remaining = db.execute(
        f"select count(*) from weekly_snapshots where id in ({placeholders})", ids
    ).fetchone()[0]
    triggers = [
        row[0]
        for row in db.execute(
            "select name from sqlite_master where type='trigger' and name like 'trig_snapshots%'"
        )
    ]
    print(f"\nDeleted {len(ids)} snapshot(s) and {warning_count} warning(s).")
    print(f"  rows still matching: {remaining} (expected 0)")
    print(f"  immutability triggers restored: {sorted(triggers)}")
    print("Restart the API so it recomputes them on next request.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
