"""Boundary and team-size resolvers for the pull-only ingestion adapters.

``GiteaRepoActivityAdapter`` deliberately takes both of these as injected
seams rather than reading the database itself.  Without them every repository
is unmapped and the aggregation floor can never be satisfied, so the whole
portfolio renders as ``insufficient_data``.  The builders below close that
seam from the versioned boundary records and the Authentik team staging rows.

Neither resolver returns, stores, or derives a contributor identity.  A team
size is an aggregate count that Authentik already publishes, and it is used
only as the floor gate before contributor counts are retained.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date
from typing import Any

from .ingestion import AUTHENTIK_TEAMS_COLLECTION, PEOPLE_PORTAL_TEAMS_COLLECTION


def _repo_keys(repo: Any) -> list[str]:
    """Return the identifiers a boundary may use to name one repository."""

    keys: list[str] = []
    for attribute in ("repo_slug", "gitea_repo_id"):
        value = getattr(repo, attribute, None)
        if value is None and isinstance(repo, Mapping):
            value = repo.get(attribute)
        if value not in (None, ""):
            keys.append(str(value))
    if not keys and isinstance(repo, str):
        keys.append(repo)
    return keys


def _boundary_repo_refs(boundary: Any) -> list[Any]:
    refs: list[Any] = []
    for field in ("primary_repos", "shared_repos"):
        value = getattr(boundary, field, None)
        if value is None and isinstance(boundary, Mapping):
            value = boundary.get(field)
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            refs.extend(value)
    return refs


def _excluded_slugs(boundary: Any) -> set[str]:
    value = getattr(boundary, "excluded_repos", None)
    if value is None and isinstance(boundary, Mapping):
        value = boundary.get("excluded_repos")
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return {str(item) for item in value if item not in (None, "")}
    return set()


def _effective_at(boundary: Any, at: date) -> bool:
    """Honour the boundary's own point-in-time check when it exposes one."""

    checker = getattr(boundary, "is_effective_at", None)
    if callable(checker):
        try:
            return bool(checker(at))
        except (TypeError, ValueError):
            pass
    start = getattr(boundary, "effective_from", None)
    end = getattr(boundary, "effective_to", None)
    if isinstance(boundary, Mapping):
        start = boundary.get("effective_from", start)
        end = boundary.get("effective_to", end)
    if isinstance(start, date) and at < start:
        return False
    if isinstance(end, date) and at > end:
        return False
    return True


async def build_boundary_resolver(
    database: Any,
    *,
    at: date | None = None,
) -> dict[str, list[str]]:
    """Map every in-boundary repository key to its owning project ids.

    The result is a plain mapping so the synchronous adapter can consume it
    without reaching back into an async repository mid-sync.  ``at`` selects
    the boundary version in force for the window being ingested, which keeps a
    historical backfill aligned with the boundaries of that period rather than
    with today's.
    """

    as_of = at or date.today()
    mapping: dict[str, set[str]] = {}
    for boundary in await database.list("boundaries"):
        if not _effective_at(boundary, as_of):
            continue
        project_id = getattr(boundary, "project_id", None)
        if project_id is None and isinstance(boundary, Mapping):
            project_id = boundary.get("project_id")
        if project_id in (None, ""):
            continue
        excluded = _excluded_slugs(boundary)
        for ref in _boundary_repo_refs(boundary):
            for key in _repo_keys(ref):
                if key in excluded:
                    continue
                mapping.setdefault(key, set()).add(str(project_id))
    return {key: sorted(values) for key, values in mapping.items()}


async def build_team_size_resolver(
    staging: Any,
    *,
    at: date | None = None,
    boundaries: Any | None = None,
) -> dict[str, int]:
    """Map repository keys and project ids to their aggregate team size.

    Sizes come from the Authentik team staging rows, which only carry a
    ``team_size`` when the team already cleared the aggregation floor during
    ingestion.  A project's size is the size of its root team; subteams are
    not summed, because a member may belong to several and no identity is
    available to de-duplicate them.
    """

    sizes: dict[str, int] = {}
    for collection in (AUTHENTIK_TEAMS_COLLECTION, PEOPLE_PORTAL_TEAMS_COLLECTION):
        for row in await _list_staging(staging, collection):
            team_id = row.get("team_id") if isinstance(row, Mapping) else None
            team_size = row.get("team_size") if isinstance(row, Mapping) else None
            if team_id in (None, "") or not isinstance(team_size, int):
                continue
            # Staging is append-only, so the newest row for a team wins.
            sizes[str(team_id)] = team_size

    as_of = at or date.today()
    resolved: dict[str, int] = {}
    boundary_store = boundaries or staging
    for boundary in await boundary_store.list("boundaries"):
        if not _effective_at(boundary, as_of):
            continue
        project_id = getattr(boundary, "project_id", None)
        root_team = getattr(boundary, "root_authentik_team_id", None)
        if isinstance(boundary, Mapping):
            project_id = boundary.get("project_id", project_id)
            root_team = boundary.get("root_authentik_team_id", root_team)
        if project_id in (None, "") or root_team in (None, ""):
            continue
        team_size = sizes.get(str(root_team))
        if team_size is None:
            continue
        resolved[str(project_id)] = team_size
        for ref in _boundary_repo_refs(boundary):
            for key in _repo_keys(ref):
                # A shared repository takes the largest owning team, so the
                # floor gate stays conservative in only one direction.
                resolved[key] = max(resolved.get(key, 0), team_size)
    return resolved


async def _list_staging(database: Any, collection: str) -> list[Mapping[str, Any]]:
    """Read a raw staging collection via its ``list_staging`` method."""

    return list(await database.list_staging(collection))


__all__ = ["build_boundary_resolver", "build_team_size_resolver"]
