#!/usr/bin/env python3
"""Reconstruct the project catalog from Gitea and People Portal directly.

The supported source for ``projects`` and ``boundaries`` is People Portal's
``/api/projects/catalog`` endpoint.  That route is not deployed on every
People Portal instance; where it is missing, the catalog fold writes nothing,
``projects`` stays empty, and ``generate_weekly_snapshots`` -- which iterates
``projects`` -- produces no snapshots at all.  A portfolio in that state has
boundaries and repository activity but renders entirely empty.

This script is the documented fallback for that case.  It derives the same two
collections from the upstreams that remain reachable:

* **Gitea** supplies the organization/repository mapping, via
  ``backend.ingestion.discover_gitea_orgs`` -- which exists for exactly this
  shape of instance, one org per team.
* **People Portal** supplies the team identity that the catalog would
  otherwise carry: the Authentik team PK, the friendly display name, the
  description, and the team's start date.  A Gitea organization is matched to
  a team by exact (case-insensitive) name.

Records written here are marked ``created_by='upstream-catalog-fallback'`` and
``catalog_revision=None`` so a later real catalog sync can tell them apart
from catalog-derived records.  Nothing is invented: an organization with no
repositories is skipped, and an organization with no matching People Portal
team keeps its Gitea name as the display name rather than being given one.

Re-running is safe -- an existing project or boundary is left alone.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.config import get_settings  # noqa: E402
from backend.db import close_db, get_active_repository, init_db  # noqa: E402
from backend.ingestion import discover_gitea_orgs  # noqa: E402
from backend.models import BoundaryDocument, ProjectDocument, RepositoryRef  # noqa: E402
from backend.people_portal import PeoplePortalApiError, PeoplePortalSdkClient  # noqa: E402

CREATED_BY = "upstream-catalog-fallback"


def _project_id(org_name: str) -> str:
    """Derive a slug matching the project_id pattern shared by both models."""

    slug = re.sub(r"[^a-z0-9]+", "-", org_name.casefold()).strip("-")
    return slug or "unnamed-project"


def _as_date(value: Any) -> date | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None


async def _people_portal_teams(settings: Any) -> dict[str, dict[str, Any]]:
    """Index People Portal PROJECT teams by lowercased team name.

    A failure here is not fatal: the Gitea mapping alone still produces a
    working portfolio, just without friendly names or Authentik identity.
    """

    if not settings.people_portal_url or not settings.people_portal_api_token:
        return {}
    client = PeoplePortalSdkClient(
        base_url=settings.people_portal_url,
        token=settings.people_portal_api_token,
    )
    rows = await asyncio.to_thread(client.list_team_hierarchy_sync)
    indexed: dict[str, dict[str, Any]] = {}
    for row in rows:
        name = str(row.get("name") or "").strip()
        # Only root PROJECT teams map to a portfolio project; subteams carry
        # teamType on their nested attributes and must not become projects.
        if not name or row.get("teamType") != "PROJECT":
            continue
        indexed[name.casefold()] = row
    return indexed


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    settings = get_settings()
    if not settings.gitea_url or not settings.gitea_api_token:
        return {"status": "not_configured", "problems": ["PHI_GITEA_URL and PHI_GITEA_API_TOKEN must both be set"]}

    await init_db(settings)
    database = get_active_repository()
    try:
        existing_projects = {str(getattr(p, "project_id", "")) for p in await database.list("projects")}
        existing_boundaries = {str(getattr(b, "project_id", "")) for b in await database.list("boundaries")}

        try:
            teams = await _people_portal_teams(settings)
            teams_error = None
        except (PeoplePortalApiError, Exception) as exc:  # noqa: BLE001 - reported, not raised
            teams = {}
            teams_error = f"{type(exc).__name__}: {exc}"

        discovered = await asyncio.to_thread(
            discover_gitea_orgs,
            base_url=settings.gitea_url,
            token=settings.gitea_api_token,
        )

        written: list[dict[str, Any]] = []
        skipped_empty: list[str] = []
        unmatched: list[str] = []

        for entry in discovered:
            org_name = str(entry.get("org") or "").strip()
            repos = entry.get("repos") or []
            if not org_name:
                continue
            if not repos:
                skipped_empty.append(org_name)
                continue

            project_id = _project_id(org_name)
            team = teams.get(org_name.casefold())
            if team is None:
                unmatched.append(org_name)

            display_name = str((team or {}).get("friendlyName") or "").strip() or org_name
            team_pk = str((team or {}).get("pk") or "").strip() or None
            effective_from = (
                args.effective_from
                or _as_date((team or {}).get("teamStartDate"))
                or date(date.today().year, 1, 1)
            )

            record: dict[str, Any] = {
                "project_id": project_id,
                "display_name": display_name,
                "gitea_org": org_name,
                "repos": len(repos),
                "matched_people_portal_team": team_pk is not None,
                "effective_from": effective_from.isoformat(),
            }

            if project_id not in existing_projects:
                project = ProjectDocument(
                    project_id=project_id,
                    display_name=display_name,
                    owning_authentik_team_id=team_pk,
                    owning_shared_resource_id=org_name,
                    owning_team_display_name=display_name,
                    gitea_organization=org_name,
                )
                if not args.dry_run:
                    await database.add("projects", project)
                    existing_projects.add(project_id)
                record["project"] = "written"
            else:
                record["project"] = "already present"

            if project_id not in existing_boundaries:
                boundary = BoundaryDocument(
                    project_id=project_id,
                    # Prefer the real Authentik PK; fall back to the org name,
                    # the legacy form _gitea_adapters already resolves.
                    root_authentik_team_id=team_pk or org_name,
                    root_team_display_name=display_name,
                    gitea_organization=org_name,
                    primary_repos=[
                        RepositoryRef(
                            gitea_repo_id=str(repo.get("id") or repo.get("name")),
                            repo_slug=str(repo.get("name")),
                        )
                        for repo in repos
                        if repo.get("name")
                    ],
                    effective_from=effective_from,
                    created_by=CREATED_BY,
                )
                if not args.dry_run:
                    await database.add("boundaries", boundary)
                    existing_boundaries.add(project_id)
                record["boundary"] = "written"
            else:
                record["boundary"] = "already present"

            written.append(record)

        return {
            "status": "ok",
            "job": "seed_catalog_from_upstreams",
            "dry_run": args.dry_run,
            "people_portal_teams_indexed": len(teams),
            "people_portal_error": teams_error,
            "orgs_discovered": len(discovered),
            "records": written,
            "skipped_no_repositories": skipped_empty,
            "unmatched_in_people_portal": unmatched,
        }
    finally:
        await close_db()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--effective-from",
        type=date.fromisoformat,
        default=None,
        help="override the boundary effective_from for every project (default: the People "
             "Portal team start date, else January 1 of the current year)",
    )
    parser.add_argument("--dry-run", action="store_true", help="report what would be written and exit")
    args = parser.parse_args()

    report = asyncio.run(_run(args))
    print(json.dumps(report, indent=2, default=str))
    return 0 if report.get("status") == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
