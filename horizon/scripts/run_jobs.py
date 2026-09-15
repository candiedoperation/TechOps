#!/usr/bin/env python3
"""Operator entrypoint for the pull-only ingestion and snapshot jobs.

The service deliberately starts no scheduler of its own, so these commands are
the supported way to drive the pipeline from cron, a systemd timer, or a
Kubernetes CronJob.  A first live deployment runs ``backfill`` once to seed
baselines, then ``nightly`` and ``weekly`` on a schedule.

    scripts/run_jobs.py backfill --weeks 10
    scripts/run_jobs.py nightly
    scripts/run_jobs.py weekly

Every command is append-oriented and emits a JSON run report on stdout.  No
command sends an outbound notification.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.config import get_settings  # noqa: E402
from backend.db import close_db, get_active_repository, init_db  # noqa: E402
from backend.jobs import (  # noqa: E402
    run_nightly_sync,
    run_weekly_backfill,
    run_weekly_snapshot_job,
)


def _parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"expected an ISO date, got {value!r}") from error


async def _preflight(settings: Any, database: Any) -> list[str]:
    """Report configuration that would make a live run silently do nothing."""

    problems: list[str] = []
    if not settings.gitea_url:
        problems.append("PHI_GITEA_URL is not set")
    if not settings.gitea_api_token:
        problems.append("PHI_GITEA_API_TOKEN is not set")
    if not settings.gitea_org:
        # An unset PHI_GITEA_ORG is only a problem when the People Portal
        # catalog has not supplied an explicit Gitea organization namespace.
        boundaries = await database.list("boundaries")
        if not any(
            getattr(boundary, "gitea_organization", None)
            or getattr(boundary, "root_shared_resource_id", None)
            or getattr(boundary, "root_authentik_team_id", None)
            for boundary in boundaries
        ):
            problems.append(
                "PHI_GITEA_ORG is not set and no boundary records an org to sync "
                "(set PHI_GITEA_ORG, or run a People Portal catalog sync first)"
            )
    if not settings.people_portal_url and not settings.authentik_url:
        problems.append("PHI_PEOPLE_PORTAL_URL or PHI_AUTHENTIK_URL is required for team sizes")
    if settings.sqlite_path == ":memory:":
        problems.append("PHI_SQLITE_PATH is ':memory:'; results will be lost when this process exits")
    return problems


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    settings = get_settings()
    await init_db(settings)
    database = get_active_repository()

    problems = await _preflight(settings, database)
    if problems and not args.allow_incomplete:
        await close_db()
        return {
            "status": "not_configured",
            "problems": problems,
            "hint": "fix the settings above, or pass --allow-incomplete to run anyway",
        }

    try:
        if args.command == "backfill":
            result = await run_weekly_backfill(
                settings=settings,
                database=database,
                weeks=args.weeks,
                through=args.through,
                generate_snapshots=not args.no_snapshots,
            )
        elif args.command == "nightly":
            result = await run_nightly_sync(
                settings=settings,
                database=database,
                lookback_days=args.lookback_days,
            )
        else:
            result = await run_weekly_snapshot_job(
                settings=settings,
                database=database,
                week_start=args.week_start,
            )
    finally:
        await close_db()

    if problems:
        result = {**result, "configuration_warnings": problems}
    return result


def build_parser() -> argparse.ArgumentParser:
    # Shared flags are declared on a parent so they are accepted either
    # before or after the subcommand.
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument(
        "--allow-incomplete",
        action="store_true",
        help="run even when the upstream configuration is incomplete",
    )

    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        parents=[shared],
    )
    commands = parser.add_subparsers(dest="command", required=True)

    backfill = commands.add_parser(
        "backfill",
        parents=[shared],
        help="replay Gitea history one week at a time and snapshot each week",
    )
    backfill.add_argument(
        "--weeks",
        type=int,
        default=10,
        help="weeks of history to replay (default: 10; the rules need at least 5 to open the minimum-data gate)",
    )
    backfill.add_argument("--through", type=_parse_date, default=None, help="last week to replay, as an ISO date")
    backfill.add_argument("--no-snapshots", action="store_true", help="stage and fold activity without scoring it")

    nightly = commands.add_parser("nightly", parents=[shared], help="pull recent whole weeks and refresh the current one")
    nightly.add_argument("--lookback-days", type=int, default=14, help="days of recent history to refresh (default: 14)")

    weekly = commands.add_parser("weekly", parents=[shared], help="generate the latest completed week's immutable snapshots")
    weekly.add_argument("--week-start", type=_parse_date, default=None, help="ISO date of the week to score")

    return parser


def main() -> int:
    args = build_parser().parse_args()
    result = asyncio.run(_run(args))
    result.setdefault("completed_at", datetime.now(timezone.utc).isoformat())
    json.dump(result, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")
    return 0 if result.get("status") in {"ok", "partial"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
