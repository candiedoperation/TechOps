#!/usr/bin/env python3
"""Load one analytics run into PostgreSQL.

The loader is idempotent for a run_id: rerunning it replaces that run's
normalized rows while preserving previous runs for historical comparison.
The complete normalized analytics payload is also stored as JSONB.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


PIPELINE_ROOT = Path(__file__).resolve().parent
DEFAULT_INPUT = PIPELINE_ROOT / "data/horizon/latest"
DEFAULT_SCHEMA = PIPELINE_ROOT / "schema.sql"
DEFAULT_DATABASE_URL = None
# Raw blame output can reach hundreds of megabytes. Store a bounded excerpt so a
# large artifact cannot bloat the row or approach PostgreSQL's 1 GB field limit;
# size_bytes and sha256 still describe the complete file on disk.
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024


from run_pipeline import load_env_file
from backend.gitea_evidence import METRIC_FIELDS, metric_snapshot


def parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def optional_int(value: Any) -> int | None:
    return None if value is None else int(value)


def resolve_input(path: Path) -> tuple[Path, Path, dict[str, Any]]:
    run_dir = path if path.is_dir() else path.parent
    analytics_path = path / "analytics.json" if path.is_dir() else path
    if not analytics_path.exists():
        raise FileNotFoundError(f"analytics.json not found at {analytics_path}")
    payload = json.loads(analytics_path.read_text(encoding="utf-8"))
    manifest_path = run_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    return run_dir, analytics_path, {"payload": payload, "manifest": manifest}


def artifact_rows(run_id: str, run_dir: Path) -> Iterable[tuple[Any, ...]]:
    for path in sorted(run_dir.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".json", ".jsonl", ".md", ".txt"}:
            continue
        size_bytes = path.stat().st_size
        digest = hashlib.sha256()
        excerpt = bytearray()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
                if len(excerpt) < MAX_ARTIFACT_BYTES:
                    excerpt.extend(chunk[: MAX_ARTIFACT_BYTES - len(excerpt)])
        content = bytes(excerpt).decode("utf-8", errors="replace")
        if size_bytes > MAX_ARTIFACT_BYTES:
            content += (
                f"\n[truncated: stored {MAX_ARTIFACT_BYTES} of {size_bytes} bytes; "
                f"the full artifact remains at {path}]\n"
            )
        yield (
            run_id,
            str(path.relative_to(run_dir)),
            content,
            size_bytes,
            digest.hexdigest(),
        )


def required_dependency() -> tuple[Any, Any]:
    try:
        import psycopg
        from psycopg.types.json import Jsonb
    except ImportError as exc:
        raise RuntimeError(
            "PostgreSQL loading requires psycopg; run `python3 -m pip install -r requirements.txt`"
        ) from exc
    return psycopg, Jsonb


def execute_many(connection: Any, statement: str, rows: Iterable[tuple[Any, ...]]) -> None:
    values = list(rows)
    if not values:
        return
    with connection.cursor() as cursor:
        cursor.executemany(statement, values)


def load_run(input_path: Path, database_url: str, schema_path: Path) -> dict[str, int | str]:
    if not database_url:
        raise ValueError("GITEA_ANALYTICS_DATABASE_URL is required")
    psycopg, Jsonb = required_dependency()
    run_dir, _, resolved = resolve_input(input_path)
    payload = resolved["payload"]
    manifest = resolved["manifest"]
    run_id = str(payload.get("run_id") or manifest.get("run_id") or "")
    if not run_id or run_id == ".":
        raise ValueError("Could not determine run_id from the input path or manifest")

    organizations = payload.get("organizations") or []
    members = [metric_snapshot(member) for member in payload.get("members") or []]
    repository_rows = [
        repo
        for organization in organizations
        for repo in organization.get("repositories") or []
    ]
    commit_rows = [
        (organization, repo, commit)
        for organization in organizations
        for repo in organization.get("repositories") or []
        for commit in repo.get("commits") or []
    ]
    pull_rows = [
        (organization, repo, pull)
        for organization in organizations
        for repo in organization.get("repositories") or []
        for pull in repo.get("pulls") or []
    ]
    issue_rows = [
        (organization, repo, issue)
        for organization in organizations
        for repo in organization.get("repositories") or []
        for issue in repo.get("issues") or []
    ]

    schema_sql = schema_path.read_text(encoding="utf-8")
    generated_at = parse_timestamp(payload.get("generated_at"))
    if generated_at is None:
        raise ValueError("analytics.json is missing generated_at")

    with psycopg.connect(database_url) as connection:
        connection.execute(schema_sql)
        connection.commit()
        with connection.transaction():
            # Serialize concurrent loads for this source version, then refuse
            # to rewrite historical source evidence under an existing ID.
            connection.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (run_id,))
            existing = connection.execute("SELECT payload FROM gitea_analytics.runs WHERE run_id = %s", (run_id,)).fetchone()
            if existing and existing[0] != payload:
                raise ValueError("run_id already exists with different content; use a new source version")
            connection.execute(
                """
                INSERT INTO gitea_analytics.runs
                    (run_id, generated_at, gitea_url, history_scope,
                     commit_stats_scope, blame_status, blame_method, api_calls, warnings, payload)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (run_id) DO UPDATE SET
                    generated_at = EXCLUDED.generated_at,
                    loaded_at = NOW(),
                    gitea_url = EXCLUDED.gitea_url,
                    history_scope = EXCLUDED.history_scope,
                    commit_stats_scope = EXCLUDED.commit_stats_scope,
                    blame_status = EXCLUDED.blame_status,
                    blame_method = EXCLUDED.blame_method,
                    api_calls = EXCLUDED.api_calls,
                    warnings = EXCLUDED.warnings,
                    payload = EXCLUDED.payload
                """,
                (
                    run_id,
                    generated_at,
                    payload.get("gitea_url") or "",
                    payload.get("history_scope") or "",
                    payload.get("commit_stats_scope"),
                    (payload.get("blame") or {}).get("status") or (
                        "unknown" if payload.get("blame_method") else "disabled"
                    ),
                    payload.get("blame_method"),
                    int(payload.get("api_calls") or 0),
                    Jsonb(payload.get("warnings") or []),
                    Jsonb(payload),
                ),
            )

            for table in (
                "run_artifacts",
                "issue_metrics",
                "pull_request_reviews",
                "pull_request_metrics",
                "commit_metrics",
                "repository_snapshots",
                "member_metrics",
                "organization_snapshots",
            ):
                connection.execute(
                    f"DELETE FROM gitea_analytics.{table} WHERE run_id = %s",
                    (run_id,),
                )

            execute_many(connection,
                """
                INSERT INTO gitea_analytics.organization_snapshots
                    (run_id, organization, member_count)
                VALUES (%s, %s, %s)
                """,
                [
                    (run_id, row.get("organization") or "", int(row.get("member_count") or 0))
                    for row in organizations
                ],
            )

            member_columns = ["run_id", "login", "name", "email", "identity_aliases", "organizations", "admin",
                "active_account", "roster_member", "service_or_admin", *METRIC_FIELDS,
                "repositories", "branches", "first_activity", "last_activity",
                "commit_stats_status", "file_stats_status", "availability", "observed_values"]
            member_values = []
            for member in members:
                record = {**member, "run_id": run_id,
                    "identity_aliases": Jsonb(member.get("identity_aliases") or []),
                    "availability": Jsonb(member.get("availability") or {}),
                    "observed_values": Jsonb(member.get("observed_values") or {}),
                    "admin": bool(member.get("admin")), "active_account": member.get("active_account", True),
                    "roster_member": member.get("roster_member", True), "service_or_admin": bool(member.get("service_or_admin")),
                    "first_activity": parse_timestamp(member.get("first_activity")),
                    "last_activity": parse_timestamp(member.get("last_activity"))}
                for field in ("organizations", "repositories", "branches"):
                    record[field] = member.get(field) or []
                member_values.append(tuple(record.get(field) for field in member_columns))
            execute_many(connection,
                f"INSERT INTO gitea_analytics.member_metrics ({', '.join(member_columns)}) VALUES ({', '.join(['%s'] * len(member_columns))})",
                member_values,
            )

            execute_many(connection,
                """
                INSERT INTO gitea_analytics.repository_snapshots
                    (run_id, organization, repository, default_branch, html_url,
                     clone_url, ssh_url, branches, issue_count)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        run_id, repo.get("organization") or organization.get("organization") or "",
                        repo.get("name") or "", repo.get("default_branch"), repo.get("html_url"),
                        repo.get("clone_url"), repo.get("ssh_url"), repo.get("branches") or [],
                        int(repo.get("issue_count") or 0),
                    )
                    for organization in organizations
                    for repo in organization.get("repositories") or []
                ],
            )

            execute_many(connection,
                """
                INSERT INTO gitea_analytics.commit_metrics
                    (run_id, organization, repository, sha, author_login,
                     committed_at, branches, total, additions, deletions)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        run_id, repo.get("organization") or organization.get("organization") or "",
                        repo.get("name") or "", commit.get("sha") or "",
                        str(commit.get("author") or "(unknown)"), parse_timestamp(commit.get("when")),
                        commit.get("branches") or [], optional_int((commit.get("stats") or {}).get("total")),
                        optional_int((commit.get("stats") or {}).get("additions")),
                        optional_int((commit.get("stats") or {}).get("deletions")),
                    )
                    for organization, repo, commit in commit_rows
                    if commit.get("sha")
                ],
            )

            execute_many(connection,
                """
                INSERT INTO gitea_analytics.pull_request_metrics
                    (run_id, organization, repository, number, title, author_login, state, merged)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        run_id, repo.get("organization") or organization.get("organization") or "",
                        repo.get("name") or "", int(pull.get("number")), pull.get("title"),
                        str(pull.get("author") or "(unknown)"), pull.get("state"), bool(pull.get("merged")),
                    )
                    for organization, repo, pull in pull_rows
                    if pull.get("number") is not None
                ],
            )

            review_values = []
            for organization, repo, pull in pull_rows:
                if pull.get("number") is None:
                    continue
                for review_index, review in enumerate(pull.get("reviewers") or []):
                    review_values.append(
                        (
                            run_id, repo.get("organization") or organization.get("organization") or "",
                            repo.get("name") or "", int(pull["number"]), review_index,
                            str(review.get("author") or "(unknown)"), review.get("state"),
                        )
                    )
            execute_many(connection,
                """
                INSERT INTO gitea_analytics.pull_request_reviews
                    (run_id, organization, repository, pull_number, review_index, reviewer_login, state)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                review_values,
            )

            execute_many(connection,
                """
                INSERT INTO gitea_analytics.issue_metrics
                    (run_id, organization, repository, number, title, author_login,
                     state, created_at, updated_at, closed_at, html_url)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    (
                        run_id, repo.get("organization") or organization.get("organization") or "",
                        repo.get("name") or "", int(issue.get("number")), issue.get("title"),
                        str(issue.get("author") or "(unknown)"), issue.get("state"),
                        parse_timestamp(issue.get("created_at")), parse_timestamp(issue.get("updated_at")),
                        parse_timestamp(issue.get("closed_at")), issue.get("html_url"),
                    )
                    for organization, repo, issue in issue_rows
                    if issue.get("number") is not None
                ],
            )

            execute_many(connection,
                """
                INSERT INTO gitea_analytics.run_artifacts
                    (run_id, artifact_name, content, size_bytes, sha256)
                VALUES (%s, %s, %s, %s, %s)
                """,
                artifact_rows(run_id, run_dir),
            )

    return {
        "run_id": run_id,
        "organizations": len(organizations),
        "members": len(members),
        "repositories": len(repository_rows),
        "commits": len(commit_rows),
        "pull_requests": len(pull_rows),
        "reviews": sum(len(pull.get("reviewers") or []) for _, _, pull in pull_rows),
        "issues": len(issue_rows),
        "artifacts": sum(1 for _ in artifact_rows(run_id, run_dir)),
    }


def main() -> int:
    load_env_file(PIPELINE_ROOT / ".env")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path, default=DEFAULT_INPUT)
    parser.add_argument(
        "--database-url",
        default=os.getenv("GITEA_ANALYTICS_DATABASE_URL", DEFAULT_DATABASE_URL),
        help="PostgreSQL DSN; prefer GITEA_ANALYTICS_DATABASE_URL",
    )
    parser.add_argument("--schema-file", type=Path, default=DEFAULT_SCHEMA)
    args = parser.parse_args()
    try:
        result = load_run(args.input, args.database_url, args.schema_file)
    except Exception as exc:  # noqa: BLE001 - convert setup/DB errors to one safe CLI message
        print(f"PostgreSQL load failed ({type(exc).__name__}); verify the source version and database configuration.", file=sys.stderr)
        return 1
    print("PostgreSQL load complete")
    for key, value in result.items():
        print(f"  {key}: {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
