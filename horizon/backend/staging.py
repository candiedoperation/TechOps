"""Synchronous staging writes and the fold into modelled activity rows.

The pull-only adapters in ``backend.ingestion`` write synchronously: their
``sync()`` methods are plain functions and ``_insert`` never awaits.  The
in-memory staging store is a natural fit because ingestion runs as a batch
job outside the async request loop.

Raw staging rows keep their source shape -- ``open_prs`` is a list of
de-identified pull requests, and the scalars live under ``metrics`` -- so they
stay inspectable and metrics can be recomputed without re-pulling Gitea.
``fold_staging_activity`` validates them into the ``RepoActivityDocument``
shape the rules and snapshot layers read.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date, datetime, timezone
from typing import Any

from .config import Settings
from .models import new_id
from .ingestion import (
    AUTHENTIK_TEAMS_COLLECTION,
    GITEA_REPOS_COLLECTION,
    PEOPLE_PORTAL_PROJECTS_COLLECTION,
    PEOPLE_PORTAL_TEAMS_COLLECTION,
    REPO_ACTIVITY_EVIDENCE_COLLECTION,
)
from .models import (
    BoundaryDocument,
    CatalogIdentityIssue,
    CatalogLeadReference,
    LifecycleState,
    ProjectDocument,
    RepoActivityDocument,
    RepositoryRef,
)

#: Raw Gitea rows land here; the modelled collection stays ``repo_activity``.
REPO_ACTIVITY_STAGING_COLLECTION = "repo_activity_staging"

STAGING_COLLECTIONS = (
    REPO_ACTIVITY_STAGING_COLLECTION,
    REPO_ACTIVITY_EVIDENCE_COLLECTION,
    AUTHENTIK_TEAMS_COLLECTION,
    PEOPLE_PORTAL_TEAMS_COLLECTION,
    PEOPLE_PORTAL_PROJECTS_COLLECTION,
    GITEA_REPOS_COLLECTION,
)


class InMemoryStagingStore:
    """Append-only staging buffer used when no Mongo URI is configured."""

    def __init__(self) -> None:
        self._collections: dict[str, list[dict[str, Any]]] = {}

    def __getitem__(self, name: str) -> "_InMemoryCollection":
        return _InMemoryCollection(self._collections.setdefault(name, []))

    async def list_staging(self, collection: str) -> list[dict[str, Any]]:
        return list(self._collections.get(collection, []))

    def clear(self) -> None:
        self._collections.clear()

    def close(self) -> None:  # pragma: no cover
        return None


class _InMemoryCollection:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def insert_one(self, document: Mapping[str, Any]) -> None:
        self._rows.append(dict(document))

    def find(self, _filter: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        return list(self._rows)


def open_staging_store(settings: Settings | None = None) -> Any:
    """Return the process-wide in-memory staging store."""
    return _local_staging_store


#: Local mode keeps one process-wide buffer so a sync and a later fold in the
#: same process observe the same rows.
_local_staging_store = InMemoryStagingStore()


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value:
        text = value.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(text).date()
        except ValueError:
            try:
                return date.fromisoformat(text[:10])
            except ValueError:
                return None
    return None


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(0, int(value))


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(0.0, float(value))


def _build_activity_document(fields: Mapping[str, Any]) -> RepoActivityDocument:
    """Build and validate a RepoActivityDocument from raw staging fields."""

    payload = dict(fields)
    payload.setdefault("id", new_id())
    return RepoActivityDocument.model_validate(payload)


def _activity_key(project_id: str, repo_slug: str, window_start: date) -> tuple[str, str, str]:
    return (project_id, repo_slug, window_start.isoformat())


def _existing_by_key(rows: Iterable[Any]) -> dict[tuple[str, str, str], Any]:
    existing: dict[tuple[str, str, str], Any] = {}
    for row in rows:
        project_id = getattr(row, "project_id", None)
        repo_slug = getattr(row, "repo_slug", None)
        window_start = getattr(row, "window_start", None)
        if project_id in (None, "") or repo_slug in (None, "") or window_start is None:
            continue
        parsed = _as_date(window_start)
        if parsed is not None:
            existing[_activity_key(str(project_id), str(repo_slug), parsed)] = row
    return existing


def _documents_for_row(row: Mapping[str, Any]) -> list[RepoActivityDocument]:
    """Validate one raw staging row into one document per owning project."""

    window_start = _as_date(row.get("window_start"))
    window_end = _as_date(row.get("window_end"))
    repo_slug = row.get("repo_slug")
    if window_start is None or window_end is None or not repo_slug:
        # A row without a bounded window cannot take part in a weekly
        # baseline, and is left in staging rather than guessed at.
        return []

    metrics = row.get("metrics")
    metrics = dict(metrics) if isinstance(metrics, Mapping) else {}
    synced_at = _as_datetime(row.get("synced_at")) or datetime.now(timezone.utc)
    last_sync_at = _as_datetime(row.get("last_sync_at")) or synced_at

    raw_contributors = row.get("contributors")
    contributors: list[str] = (
        [str(c) for c in raw_contributors if c]
        if isinstance(raw_contributors, (list, tuple))
        else []
    )

    fields: dict[str, Any] = {
        "gitea_repo_id": str(row.get("gitea_repo_id") or repo_slug),
        "repo_slug": str(repo_slug),
        "window_start": window_start,
        "window_end": window_end,
        "synced_at": synced_at,
        "last_sync_at": last_sync_at,
        "active_days": _as_int(metrics.get("active_days")),
        "days_since_activity": _as_int(metrics.get("days_since_activity")),
        "open_prs": _as_int(metrics.get("open_prs")),
        "oldest_open_pr_days": _as_float(metrics.get("oldest_open_pr_days")),
        "review_latency_days": _as_float(metrics.get("review_latency_days")),
        "merged_count": _as_int(metrics.get("merged_count")),
        "branches_ahead": _as_int(metrics.get("branches_ahead")),
        "open_issues": _as_int(metrics.get("open_issues")),
        "aggregation_floor": _as_int(row.get("aggregation_floor")),
        "data_completeness_pct": _as_float(row.get("data_completeness_pct")),
        "contributors": contributors,
    }

    # Always store contributor count and team size when available.
    active_contributors = _as_int(metrics.get("active_contributors"))
    if active_contributors is not None and row.get("aggregation_eligible") is not False:
        fields["active_contributors"] = active_contributors
    if row.get("aggregation_eligible") is False:
        fields["contributors"] = []
    if isinstance(row.get("team_size"), int):
        fields["team_size"] = int(row["team_size"])

    project_ids = row.get("project_ids")
    if not isinstance(project_ids, (list, tuple)) or not project_ids:
        return []
    return [
        _build_activity_document({"project_id": str(project_id), **fields})
        for project_id in project_ids
        if str(project_id).strip()
    ]


async def fold_staging_activity(
    database: Any,
    staging: Any,
    *,
    staging_collection: str = REPO_ACTIVITY_STAGING_COLLECTION,
) -> dict[str, Any]:
    """Materialize one activity document per project, repo, and week.

    ``repo_activity`` is a derived projection, not the archive: the raw
    staging collection is the append-only record.  That distinction matters
    for the in-progress week, whose totals change with every nightly run --
    the existing row for a window is refreshed from the newest staging row
    rather than duplicated, because ``_history_by_project`` sums additively
    across the rows in a bucket and duplicates would inflate the week.
    """

    lister = getattr(staging, "list_staging", None)
    raw_rows = list(await lister(staging_collection)) if callable(lister) else []
    # Oldest first, so the newest observation of a window wins the write.
    raw_rows.sort(key=lambda item: str(item.get("synced_at") or "") if isinstance(item, Mapping) else "")
    existing = _existing_by_key(await database.list("repo_activity"))

    written = 0
    refreshed = 0
    invalid = 0
    for row in raw_rows:
        if not isinstance(row, Mapping):
            invalid += 1
            continue
        try:
            documents = _documents_for_row(row)
        except (TypeError, ValueError):
            invalid += 1
            continue
        if not documents:
            invalid += 1
            continue
        for document in documents:
            key = _activity_key(
                str(document.project_id),
                document.repo_slug,
                document.window_start,
            )
            previous = existing.get(key)
            if previous is None:
                await database.add("repo_activity", document)
                existing[key] = document
                written += 1
                continue
            previous_sync = _as_datetime(getattr(previous, "synced_at", None))
            if previous_sync is not None and document.synced_at <= previous_sync:
                continue
            # Reuse the stored identity so this is an in-place refresh of the
            # projection rather than a second row for the same week.
            document.id = getattr(previous, "id", None)
            await database.replace(document)
            existing[key] = document
            refreshed += 1

    return {
        "status": "ok",
        "job": "fold_staging_activity",
        "staging_rows_read": len(raw_rows),
        "activity_rows_written": written,
        "activity_rows_refreshed": refreshed,
        "unusable_rows": invalid,
    }


async def fold_people_portal_catalog(database: Any, staging: Any) -> dict[str, Any]:
    """Upsert the project catalog and versioned boundaries exported by People Portal."""

    lister = getattr(staging, "list_staging", None)
    rows = list(await lister(PEOPLE_PORTAL_PROJECTS_COLLECTION)) if callable(lister) else []
    latest: dict[str, Mapping[str, Any]] = {}
    for row in rows:
        if isinstance(row, Mapping) and row.get("project_id"):
            latest[str(row["project_id"])] = row

    existing_projects = {str(item.project_id): item for item in await database.list("projects")}
    existing_boundaries = {
        (str(item.project_id), item.effective_from): item
        for item in await database.list("boundaries")
    }
    projects_written = projects_refreshed = boundaries_written = boundaries_refreshed = invalid = 0

    for project_id, row in latest.items():
        effective_from = _as_date(row.get("effective_from"))
        repositories = row.get("repositories")
        if effective_from is None or not isinstance(repositories, list) or not repositories:
            invalid += 1
            continue
        try:
            lifecycle = LifecycleState(str(row.get("lifecycle_state") or "new"))
        except ValueError:
            lifecycle = LifecycleState.NEW
        owner = row.get("data_owner_user_id") or None
        project = ProjectDocument.model_construct(
            id=getattr(existing_projects.get(project_id), "id", None) or new_id(),
            project_id=project_id,
            display_name=str(row.get("display_name") or project_id),
            lifecycle_state=lifecycle,
            data_owner_user_id=str(owner) if owner else None,
            owning_authentik_team_id=str(row.get("root_team_id")) if row.get("root_team_id") else None,
            owning_shared_resource_id=str(row.get("root_shared_resource_id")) if row.get("root_shared_resource_id") else None,
            owning_team_display_name=str(row.get("root_team_display_name")) if row.get("root_team_display_name") else None,
            gitea_organization=str(row.get("gitea_organization")) if row.get("gitea_organization") else None,
            gitea_repository_snapshot=str(row.get("gitea_repository_snapshot")) if row.get("gitea_repository_snapshot") else None,
            gitea_member_snapshot=str(row.get("gitea_member_snapshot")) if row.get("gitea_member_snapshot") else None,
            catalog_leads=[CatalogLeadReference.model_validate(item) for item in row.get("catalog_leads", []) if isinstance(item, Mapping)],
            catalog_identity_issues=[CatalogIdentityIssue.model_validate(item) for item in row.get("catalog_identity_issues", []) if isinstance(item, Mapping)],
            catalog_revision=str(row.get("catalog_revision")) if row.get("catalog_revision") else None,
            catalog_observed_at=_as_datetime(row.get("catalog_observed_at")),
            non_goals_ack=True,
        )
        if project_id in existing_projects:
            await database.replace(project)
            projects_refreshed += 1
        else:
            await database.add("projects", project)
            projects_written += 1
        existing_projects[project_id] = project

        refs = [
            RepositoryRef(
                gitea_repo_id=str(repo.get("gitea_repo_id") or repo.get("repo_slug")),
                repo_slug=str(repo.get("repo_slug")),
            )
            for repo in repositories
            if isinstance(repo, Mapping) and repo.get("repo_slug")
        ]
        boundary_key = (project_id, effective_from)
        existing_boundary = existing_boundaries.get(boundary_key)
        boundary = BoundaryDocument.model_construct(
            id=getattr(existing_boundary, "id", None) or new_id(),
            project_id=project_id,
            root_authentik_team_id=str(row.get("root_team_id")),
            included_subteam_ids=[str(item) for item in row.get("included_subteam_ids", [])],
            primary_repos=refs,
            shared_repos=[],
            excluded_repos=[],
            effective_from=effective_from,
            effective_to=_as_date(row.get("effective_to")),
            data_owner_user_id=str(owner) if owner else None,
            root_shared_resource_id=str(row.get("root_shared_resource_id")) if row.get("root_shared_resource_id") else None,
            root_team_display_name=str(row.get("root_team_display_name")) if row.get("root_team_display_name") else None,
            gitea_organization=str(row.get("gitea_organization")) if row.get("gitea_organization") else None,
            gitea_repository_snapshot=str(row.get("gitea_repository_snapshot")) if row.get("gitea_repository_snapshot") else None,
            gitea_member_snapshot=str(row.get("gitea_member_snapshot")) if row.get("gitea_member_snapshot") else None,
            catalog_leads=[CatalogLeadReference.model_validate(item) for item in row.get("catalog_leads", []) if isinstance(item, Mapping)],
            catalog_identity_issues=[CatalogIdentityIssue.model_validate(item) for item in row.get("catalog_identity_issues", []) if isinstance(item, Mapping)],
            catalog_revision=str(row.get("catalog_revision")) if row.get("catalog_revision") else None,
            created_by="people-portal-sync",
        )
        if existing_boundary is not None:
            await database.replace(boundary)
            boundaries_refreshed += 1
        else:
            await database.add("boundaries", boundary)
            boundaries_written += 1
        existing_boundaries[boundary_key] = boundary

    return {
        "status": "ok" if not invalid else "partial",
        "job": "fold_people_portal_catalog",
        "source_rows": len(rows),
        "projects_written": projects_written,
        "projects_refreshed": projects_refreshed,
        "boundaries_written": boundaries_written,
        "boundaries_refreshed": boundaries_refreshed,
        "invalid_rows": invalid,
    }


__all__ = [
    "REPO_ACTIVITY_STAGING_COLLECTION",
    "STAGING_COLLECTIONS",
    "InMemoryStagingStore",
    "open_staging_store",
    "fold_staging_activity",
    "fold_people_portal_catalog",
]
