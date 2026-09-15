#!/usr/bin/env python3
"""Run the official App Dev Horizon Gitea analytics and member-profile pipeline.

This entry point owns the collection and profile-build steps so the official platform
can be run from its own project directory. It adds safe env-file loading,
timestamped artifacts, and an atomic latest-artifact refresh for repeatable
club-wide runs.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.artifacts import atomic_write
from backend.people_portal import PeoplePortalApiError, PeoplePortalSdkClient


PIPELINE_ROOT = Path(__file__).resolve().parent
COLLECTOR = PIPELINE_ROOT / "scripts/member_analytics.py"
POSTGRES_LOADER = PIPELINE_ROOT / "load_postgres.py"
PROFILE_BUILDER = PIPELINE_ROOT / "build_member_profiles.py"
DEFAULT_ENV_FILE = PIPELINE_ROOT / ".env"
DEFAULT_OUTPUT_ROOT = PIPELINE_ROOT / "data/horizon"
VENV_PYTHON = PIPELINE_ROOT / ".venv/bin/python"


def interpreter() -> str:
    """Prefer the pipeline virtualenv so psycopg is importable in subprocesses.

    Running `python3 run_pipeline.py --load-postgres` from a system interpreter
    would otherwise hand the loader an environment without its dependencies.
    """
    if VENV_PYTHON.exists():
        return str(VENV_PYTHON)
    return sys.executable


def load_env_file(path: Path) -> None:
    """Load simple KEY=VALUE entries without printing or committing secrets."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        if not separator or not key.strip():
            continue
        value = value.strip()
        if value[:1] in {"'", '"'} and value[-1:] == value[:1]:
            try:
                value = shlex.split(value)[0]
            except (IndexError, ValueError):
                value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def prune_runs(output_root: Path, keep: int) -> list[str]:
    """Delete the oldest timestamped run directories, keeping the newest `keep`."""
    if keep <= 0:
        return []
    runs = sorted(
        (path for path in output_root.iterdir()
         if path.is_dir() and not path.is_symlink()
         and re.fullmatch(r"\d{8}T\d{6}(?:\d{6})?Z", path.name)
         and (path / "pipeline-manifest.json").exists()),
        key=lambda path: path.name,
    )
    removed = []
    for path in runs[:-keep]:
        if path.resolve() == (output_root / "latest").resolve():
            continue
        shutil.rmtree(path)
        removed.append(path.name)
    return removed


def find_peopleportal_zip(output_root: Path, requested: Path | None) -> Path | None:
    if requested is not None:
        return requested
    candidates = sorted(
        output_root.glob("horizon-peopleportal-*.zip"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def peopleportal_organizations_from_sdk() -> list[str]:
    """Return live team names for Gitea collection through the generated SDK."""

    base_url = os.getenv("PHI_PEOPLE_PORTAL_URL")
    token = os.getenv("PHI_PEOPLE_PORTAL_API_TOKEN")
    if not base_url or not token:
        return []
    try:
        client = PeoplePortalSdkClient(base_url=base_url, token=token)
        teams = client.list_team_hierarchy_sync()
    except PeoplePortalApiError as exc:
        print(f"People Portal SDK team discovery failed: {exc.path}", file=sys.stderr)
        return []
    return sorted(
        {
            str(team.get("name") or "").strip()
            for team in teams
            if isinstance(team, dict) and str(team.get("name") or "").strip()
        },
        key=str.casefold,
    )


def sync_api_run(analytics_path: Path, api_base: str, token: str) -> dict[str, Any]:
    """Ingest the completed run into the official Horizon API store."""

    payload = json.loads(analytics_path.read_text(encoding="utf-8"))
    body = json.dumps({"payload": payload, "run_id": payload.get("run_id")}).encode("utf-8")
    request = urllib.request.Request(
        f"{api_base.rstrip('/')}/admin/sync/member-analytics",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Admin-Sync-Token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"official API returned HTTP {exc.code}: {detail}") from exc


def sync_recruiting_source(source_path: Path, api_base: str, token: str) -> dict[str, Any]:
    """Ingest the regenerated People Portal/Gitea join into the API store."""

    payload = json.loads(source_path.read_text(encoding="utf-8"))
    ranking_path = source_path.parent / "recruiting-ranking.json"
    ranking = json.loads(ranking_path.read_text(encoding="utf-8")) if ranking_path.exists() else None
    body = json.dumps({
        "payload": payload,
        "source_run_id": payload.get("source_run_id"),
        "member_analytics_run_id": (payload.get("source") or {}).get("gitea_run_id"),
        "ranking": ranking,
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{api_base.rstrip('/')}/admin/sync/recruiting",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Admin-Sync-Token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"official API returned HTTP {exc.code}: {detail}") from exc


def sync_recruiting_from_people_portal_api(
    api_base: str,
    token: str,
    member_analytics_run_id: str,
) -> dict[str, Any]:
    """Ask Horizon's backend to pull the live People Portal Horizons API.

    When the service integration is configured, this path intentionally sends
    no local source artifact or tabular export. The backend owns the API pull,
    normalization, and reviewer-gated ranking run.
    """

    body = json.dumps({"member_analytics_run_id": member_analytics_run_id}).encode("utf-8")
    request = urllib.request.Request(
        f"{api_base.rstrip('/')}/admin/sync/recruiting",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Admin-Sync-Token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"official API returned HTTP {exc.code}: {detail}") from exc


def latest_ssh_probe_url(output_root: Path) -> str:
    analytics_path = output_root / "latest" / "analytics.json"
    if not analytics_path.exists():
        return ""
    try:
        payload = json.loads(analytics_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return ""
    for organization in payload.get("organizations") or []:
        for repository in organization.get("repositories") or []:
            ssh_url = str(repository.get("ssh_url") or "")
            if ssh_url.startswith(("git@", "ssh://")):
                return ssh_url
    return ""


def ssh_read_preflight(ssh_url: str) -> bool:
    """Check repository read access without allowing an interactive prompt."""

    if not ssh_url:
        return False
    environment = os.environ.copy()
    environment["GIT_TERMINAL_PROMPT"] = "0"
    command = [
        "git",
        "-c",
        (
            "core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=8 "
            "-o StrictHostKeyChecking=yes"
        ),
        "ls-remote",
        "--heads",
        ssh_url,
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file",
        type=Path,
        default=DEFAULT_ENV_FILE,
        help="Environment file containing PHI_GITEA_URL and PHI_GITEA_API_TOKEN",
    )
    parser.add_argument("--org", action="append", help="Explicit organization; repeat for multiple orgs")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_ROOT,
        help="Root directory for timestamped pipeline runs",
    )
    parser.add_argument("--raw-blame", action="store_true", help="Save combined native git blame output")
    parser.add_argument(
        "--keep-runs",
        type=int,
        default=0,
        help="Delete all but the newest N timestamped run directories; 0 keeps every run",
    )
    parser.add_argument("--default-branch-only", action="store_true", help="Exclude feature-branch activity")
    parser.add_argument(
        "--api-history",
        action="store_true",
        help="Collect all branches through the Gitea API instead of native SSH clones",
    )
    parser.add_argument("--no-blame", action="store_true", help="Skip native line ownership attribution")
    parser.add_argument("--load-postgres", action="store_true", help="Load the completed run into PostgreSQL")
    parser.add_argument(
        "--sync-api",
        action="store_true",
        help="Ingest the completed run into the official Horizon API database",
    )
    parser.add_argument(
        "--api-base",
        default=None,
        help="Official Horizon API base URL for --sync-api",
    )
    parser.add_argument(
        "--peopleportal-zip",
        type=Path,
        default=None,
        help="Build member profiles from this People Portal ZIP; defaults to the newest export in data/horizon/",
    )
    parser.add_argument(
        "--no-member-profiles",
        action="store_true",
        help="Skip the derived People Portal + Gitea member-profile artifact",
    )
    parser.add_argument(
        "--database-url",
        default=None,
        help="PostgreSQL DSN for --load-postgres; prefer GITEA_ANALYTICS_DATABASE_URL",
    )
    args = parser.parse_args()

    load_env_file(args.env_file)
    args.output_dir = args.output_dir.resolve()
    args.peopleportal_zip = args.peopleportal_zip.resolve() if args.peopleportal_zip else None
    args.api_base = args.api_base or os.getenv("PHI_API_BASE", "http://127.0.0.1:8000")
    if args.sync_api and not os.getenv("PHI_ADMIN_SYNC_TOKEN"):
        parser.error("--sync-api requires PHI_ADMIN_SYNC_TOKEN")
    if args.keep_runs < 0:
        parser.error("--keep-runs must be nonnegative")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    lock = (args.output_dir / ".pipeline.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        parser.error("another pipeline is already running in this output directory")
    try:
        return execute(args, parser)
    finally:
        lock.close()


def execute(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    if not os.getenv("PHI_GITEA_API_TOKEN"):
        parser.error("PHI_GITEA_API_TOKEN is not set; use --env-file or export it")
    if not COLLECTOR.exists():
        parser.error(f"collector not found: {COLLECTOR}")

    profile_zip = find_peopleportal_zip(args.output_dir, args.peopleportal_zip)
    portal_orgs = peopleportal_organizations_from_sdk()

    needs_native_ssh = (not args.default_branch_only and not args.api_history) or not args.no_blame
    if needs_native_ssh:
        probe_url = latest_ssh_probe_url(args.output_dir)
        if probe_url and not ssh_read_preflight(probe_url):
            print(
                "Native Git access is unavailable without interaction. Load the configured SSH key "
                "into the trusted agent/Keychain, or use --api-history --no-blame.",
                file=sys.stderr,
            )
            return 2

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    run_dir = args.output_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    python = interpreter()
    command = [
        python,
        str(COLLECTOR),
        "--json",
        str(run_dir / "analytics.json"),
        "--markdown",
        str(run_dir / "member-analytics.md"),
    ]
    if args.org:
        for org in args.org:
            command.extend(["--org", org])
    else:
        for org in portal_orgs:
            command.extend(["--org", org])
        command.append("--discover-project-orgs")
    if args.raw_blame:
        command.extend(["--raw-blame", str(run_dir / "raw-git-blame.txt")])
    if args.default_branch_only:
        command.append("--default-branch-only")
    elif not args.api_history:
        command.append("--native-history")
    if args.no_blame:
        command.append("--no-blame")
    else:
        command.append("--native-blame")
    collector_env = os.environ.copy()
    collector_env["GIT_TERMINAL_PROMPT"] = "0"
    collector_env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8"
    result = subprocess.run(command, cwd=PIPELINE_ROOT, check=False, env=collector_env)
    if result.returncode != 0:
        if not any(run_dir.iterdir()):
            run_dir.rmdir()
            print(f"Pipeline failed with exit code {result.returncode}; no artifacts were produced", file=sys.stderr)
        else:
            print(f"Pipeline failed with exit code {result.returncode}; partial files are in {run_dir}", file=sys.stderr)
        return result.returncode

    analytics_path = run_dir / "analytics.json"
    try:
        analytics_payload = json.loads(analytics_path.read_text(encoding="utf-8"))
        if not isinstance(analytics_payload.get("members"), list) or not analytics_payload.get("generated_at"):
            raise ValueError("collector did not produce a valid analytics envelope")
    except (ValueError, OSError) as exc:
        print(f"Invalid collector artifact: {exc}", file=sys.stderr)
        return 1
    analytics_payload["run_id"] = run_id
    atomic_write(analytics_path, json.dumps(analytics_payload, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
    warnings = analytics_payload.get("warnings") or []

    collected_organizations: list[str] = []
    if analytics_path.exists():
        try:
            collected_organizations = [
                str(row.get("organization"))
                for row in analytics_payload.get("organizations") or []
                if row.get("organization")
            ]
        except (json.JSONDecodeError, OSError):
            collected_organizations = []
    unavailable_organizations = sorted(
        {
            match.group(1)
            for warning in warnings
            if (match := re.search(r"/orgs/([^/]+)/members", str(warning)))
        },
        key=str.casefold,
    )

    manifest = {
        "schema": "horizon.collection-manifest.v2",
        "run_id": run_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "organization_selection": {
            "strategy": (
                "explicit"
                if args.org
                else "peopleportal teams plus discovered Gitea project organizations"
            ),
            "requested": sorted(set(args.org or portal_orgs), key=str.casefold),
            "reported": collected_organizations,
            "unavailable": unavailable_organizations,
        },
        "history_scope": "default branch and all discovered branches" if not args.default_branch_only else "default branch only",
        "analytics_schema": analytics_payload.get("schema"),
        "metric_semantics": analytics_payload.get("metric_semantics") or {},
        "coverage_summary": analytics_payload.get("coverage_summary") or {},
        "commit_stats_scope": analytics_payload.get("commit_stats_scope"),
        "blame": analytics_payload.get("blame") or {
            "status": "disabled" if args.no_blame else "unknown",
            "method": analytics_payload.get("blame_method"),
        },
        "warnings": warnings,
        "files": sorted(
            [str(path.relative_to(run_dir)) for path in run_dir.iterdir() if path.is_file()]
            + ["manifest.json"]
        ),
    }
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if not args.no_member_profiles:
        if profile_zip is not None:
            if not PROFILE_BUILDER.exists():
                print(f"Member profile builder not found: {PROFILE_BUILDER}", file=sys.stderr)
                return 1
            profile_result = subprocess.run(
                [
                    python,
                    str(PROFILE_BUILDER),
                    "--peopleportal-zip",
                    str(profile_zip),
                    "--gitea-analytics",
                    str(run_dir / "analytics.json"),
                    "--gitea-manifest",
                    str(run_dir / "manifest.json"),
                    "--output-dir",
                    str(run_dir),
                ],
                cwd=PIPELINE_ROOT,
                check=False,
            )
            if profile_result.returncode != 0:
                print("Member profile build failed; Gitea artifacts remain available", file=sys.stderr)
                return profile_result.returncode
        else:
            print("No People Portal ZIP found; skipped member profile build")
    if (run_dir / "member-profiles.json").exists():
        for export_command in (
            [python, str(PIPELINE_ROOT / "scripts/build_llm_ranking_export.py"), "--root", str(run_dir), "--output", str(run_dir / "llm-ranking-export")],
        ):
            export_result = subprocess.run(export_command, cwd=PIPELINE_ROOT, check=False)
            if export_result.returncode:
                print("Ranking export failed; previous published run remains current", file=sys.stderr)
                return export_result.returncode
    files = []
    for path in sorted(run_dir.rglob("*")):
        if path.is_file():
            files.append({"path": str(path.relative_to(run_dir)), "bytes": path.stat().st_size,
                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    atomic_write(run_dir / "pipeline-manifest.json", json.dumps({
        "schema": "horizon.pipeline-run.v2", "run_id": run_id,
        "generated_at": manifest["generated_at"], "status": "complete_with_warnings" if warnings else "complete",
        "human_review_required": True, "files": files,
    }, indent=2) + "\n")
    latest_dir = args.output_dir / "latest"
    # One-time migration from the old directory layout preserves the original.
    if latest_dir.exists() and not latest_dir.is_symlink():
        latest_dir.rename(args.output_dir / f".legacy-latest-{run_id}")
    pointer = args.output_dir / f".latest-{run_id}"
    pointer.symlink_to(run_dir.name, target_is_directory=True)
    os.replace(pointer, latest_dir)
    print(f"Pipeline complete: {run_dir}")
    for filename in manifest["files"]:
        print(f"  {run_dir / filename}")
    print(f"  dashboard data: {latest_dir}")
    pruned = prune_runs(args.output_dir, args.keep_runs)
    if pruned:
        print(f"  pruned {len(pruned)} older run(s): {', '.join(pruned)}")
    if args.sync_api:
        admin_token = os.getenv("PHI_ADMIN_SYNC_TOKEN")
        if not admin_token:
            print("--sync-api requires PHI_ADMIN_SYNC_TOKEN", file=sys.stderr)
            return 1
        try:
            sync_result = sync_api_run(run_dir / "analytics.json", args.api_base, admin_token)
        except (OSError, json.JSONDecodeError, RuntimeError) as exc:
            print(f"Official API sync failed: {exc}", file=sys.stderr)
            return 1
        print(
            "  official API sync: "
            f"{sync_result.get('members', 0)} members, "
            f"{sync_result.get('organizations', 0)} organizations, "
            f"{sync_result.get('repositories', 0)} repositories"
        )
        if os.getenv("PHI_PEOPLE_PORTAL_URL") and os.getenv("PHI_PEOPLE_PORTAL_API_TOKEN"):
            try:
                recruiting_result = sync_recruiting_from_people_portal_api(args.api_base, admin_token, run_id)
            except (OSError, json.JSONDecodeError, RuntimeError) as exc:
                print(f"Official People Portal API sync failed: {exc}", file=sys.stderr)
                return 1
            print(
                "  People Portal API sync: "
                f"{(recruiting_result.get('source') or {}).get('candidates', 0)} members, "
                f"ranking {(recruiting_result.get('run') or {}).get('run_id', 'not generated')}"
            )
        else:
            recruiting_source_path = run_dir / "recruiting-source.json"
            if recruiting_source_path.exists():
                try:
                    recruiting_result = sync_recruiting_source(recruiting_source_path, args.api_base, admin_token)
                except (OSError, json.JSONDecodeError, RuntimeError) as exc:
                    print(f"Official recruiting source sync failed: {exc}", file=sys.stderr)
                    return 1
                print(
                    "  recruiting source sync: "
                    f"{(recruiting_result.get('source') or {}).get('candidates', 0)} legacy artifact candidates, "
                    f"ranking {(recruiting_result.get('run') or {}).get('run_id', 'not generated')}"
                )
    if warnings:
        print(f"{len(warnings)} collection warning(s); affected data is missing from this run:", file=sys.stderr)
        for warning in warnings:
            print(f"  {warning}", file=sys.stderr)
    if args.load_postgres:
        if not POSTGRES_LOADER.exists():
            print(f"PostgreSQL loader not found: {POSTGRES_LOADER}", file=sys.stderr)
            return 1
        loader_env = os.environ.copy()
        if args.database_url:
            loader_env["GITEA_ANALYTICS_DATABASE_URL"] = args.database_url
        database_result = subprocess.run(
            [python, str(POSTGRES_LOADER), str(run_dir)],
            cwd=PIPELINE_ROOT,
            env=loader_env,
            check=False,
        )
        if database_result.returncode != 0:
            print("Analytics collection succeeded, but PostgreSQL loading failed.", file=sys.stderr)
            return database_result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
