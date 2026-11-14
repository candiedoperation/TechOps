"""Public reads from Track 5 publications and the pending-override projection."""

import json
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
from typing import Annotated, Generic, TypeVar
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import AwareDatetime, JsonValue

from .cache import PublicationCache, get_cache
from .db import ReadDatabase
from .errors import PublicationNotFound, ReadUnavailable
from .models import ApiError, Model
from .query import Season

router = APIRouter(prefix="/api/v1/projects")
REVALIDATE = "public, no-cache"
CURRENT = "public, max-age=30, stale-while-revalidate=300"
IMMUTABLE = "public, max-age=31536000, immutable"
DOCUMENT_VERSION = "projects-v1"
RunQuery = Annotated[str, Query(max_length=36)]
ProjectKey = Annotated[str, Path(alias="projectPk", min_length=1, max_length=200)]


class ProjectMeta(Model):
    run_id: UUID
    as_of: AwareDatetime
    stale: bool


class ProjectSummary(Model):
    project_pk: str
    friendly_name: str
    window_start: date
    window_end: date
    has_sow: bool
    tasks_total: int
    tasks_due: int
    tasks_done: int
    tasks_partial: int
    tasks_overdue: int
    percent_complete: float
    risk_counts: dict[str, int]


class ProjectDetail(Model):
    summary: ProjectSummary
    detail: dict[str, JsonValue]


class ProjectHistoryPoint(Model):
    run_id: UUID
    as_of: AwareDatetime
    percent_complete: float
    tasks_overdue: int
    risk_counts: dict[str, int]


Data = TypeVar("Data")


class Publication(Model, Generic[Data]):
    meta: ProjectMeta
    data: Data


class Selection:
    def __init__(self, season: Season, run: RunQuery = "current"):
        self.season_type, self.season_year = season.split("-")
        self.season_year = int(self.season_year)
        try:
            self.run_id = None if run in ("current", "latest") else UUID(run)
        except ValueError:
            raise HTTPException(422, "run must be current or a UUID.") from None

    @property
    def semester(self):
        return self.season_type, self.season_year


def get_project_database(request: Request) -> ReadDatabase:
    database = request.app.state.database
    if database is None:
        raise ReadUnavailable()
    return database


Database = Annotated[ReadDatabase, Depends(get_project_database)]
Selected = Annotated[Selection, Depends()]
Cache = Annotated[PublicationCache, Depends(get_cache)]
SUMMARY_FIELDS = """
    project_pk, friendly_name, window_start, window_end, has_sow,
    tasks_total, tasks_due, tasks_done, tasks_partial, tasks_overdue,
    percent_complete, risk_counts
"""
RESPONSE_OPTIONS = {
    304: {"description": "The response matches If-None-Match."},
    404: {"model": ApiError},
    422: {"model": ApiError},
    503: {"model": ApiError},
}


def read_publication(connection, selection: Selection):
    if selection.run_id is None:
        run = connection.execute(
            """
            SELECT run_id, as_of FROM horizon_api.publications
            WHERE domain = 'projects' AND season_type = %s AND season_year = %s
            """,
            selection.semester,
        ).fetchone()
    else:
        # Track 5 retains the summaries of each published run.
        run = connection.execute(
            """
            SELECT run_id, as_of FROM horizon_api.project_summaries
            WHERE season_type = %s AND season_year = %s AND run_id = %s
            LIMIT 1
            """,
            (*selection.semester, selection.run_id),
        ).fetchone()
    if run is None:
        raise PublicationNotFound()
    return run


def publication_meta(connection, selection: Selection, now: datetime) -> ProjectMeta:
    return run_metadata(read_publication(connection, selection), now)


def run_metadata(run, now):
    return ProjectMeta(
        run_id=run["run_id"],
        as_of=run["as_of"].astimezone(timezone.utc),
        stale=now - run["as_of"] > timedelta(days=8),
    )


def cached_meta(request, selection, database, cache):
    def load():
        with database.snapshot() as connection:
            return read_publication(connection, selection)

    ttl = request.app.state.pointer_ttl if selection.run_id is None else None
    run = cache.get(
        ("project-publication", selection.semester, selection.run_id), load, ttl=ttl
    )
    return run_metadata(run, datetime.now(timezone.utc))


def conditional_json(request: Request, version, render, policy=REVALIDATE) -> Response:
    etag = f'"{sha256(json.dumps(version, default=str, sort_keys=True).encode()).hexdigest()}"'
    validators = (
        value.strip().removeprefix("W/")
        for header in request.headers.getlist("if-none-match")
        for value in header.split(",")
    )
    headers = {"ETag": etag, "Cache-Control": policy}
    if any(value in ("*", etag) for value in validators):
        return Response(status_code=304, headers=headers)
    return JSONResponse(render(), headers=headers)


def published_json(request, selection, meta, identifier, data, *, live=None):
    # Staleness is clock-dependent and remains part of the representation.
    version = (DOCUMENT_VERSION, meta.run_id, meta.as_of, meta.stale, identifier, live)
    policy = REVALIDATE if live is not None else CURRENT
    if live is None and selection.run_id is not None and meta.stale:
        policy = IMMUTABLE
    elif live is None and selection.run_id is not None:
        # A fresh snapshot still has one scheduled metadata change at day eight.
        seconds = max(
            0,
            int(
                (
                    meta.as_of + timedelta(days=8) - datetime.now(timezone.utc)
                ).total_seconds()
            ),
        )
        policy = f"public, max-age={min(seconds, 691200)}"
    return conditional_json(
        request,
        version,
        lambda: Publication(meta=meta, data=data()).model_dump(
            mode="json", by_alias=True
        ),
        policy,
    )


@router.get(
    "", response_model=Publication[list[ProjectSummary]], responses=RESPONSE_OPTIONS
)
def projects(request: Request, selection: Selected, database: Database, cache: Cache):
    meta = cached_meta(request, selection, database, cache)

    def load():
        with database.snapshot() as connection:
            rows = connection.execute(
                f"""
                SELECT {SUMMARY_FIELDS} FROM horizon_api.project_summaries
                WHERE run_id = %s ORDER BY friendly_name, project_pk
                """,
                (meta.run_id,),
            ).fetchall()
        return [ProjectSummary(**row) for row in rows]

    data = cache.get(("projects", meta.run_id), load)
    return published_json(request, selection, meta, "list", lambda: data)


@router.get(
    "/{projectPk}",
    response_model=Publication[ProjectDetail],
    responses=RESPONSE_OPTIONS,
)
def project(
    request: Request,
    project_pk: ProjectKey,
    selection: Selected,
    database: Database,
    cache: Cache,
):
    meta = cached_meta(request, selection, database, cache)

    def load():
        with database.snapshot() as connection:
            summary = connection.execute(
                f"""
                SELECT {SUMMARY_FIELDS} FROM horizon_api.project_summaries
                WHERE project_pk = %s AND run_id = %s
                """,
                (project_pk, meta.run_id),
            ).fetchone()
            if summary is None:
                raise PublicationNotFound()
            detail = connection.execute(
                """
                SELECT document FROM horizon_api.project_detail
                WHERE project_pk = %s AND run_id = %s
                """,
                (project_pk, meta.run_id),
            ).fetchone()
            if detail is None:
                raise PublicationNotFound()
        return ProjectDetail(
            summary=ProjectSummary(**summary), detail=detail["document"]
        )

    data = cache.get(("project-detail", meta.run_id, project_pk), load)
    return published_json(
        request, selection, meta, ("detail", project_pk), lambda: data
    )


@router.get(
    "/{projectPk}/sow-timeline",
    response_model=Publication[dict[str, JsonValue]],
    responses=RESPONSE_OPTIONS,
)
def sow_timeline(
    request: Request,
    project_pk: ProjectKey,
    selection: Selected,
    database: Database,
    cache: Cache,
):
    meta = cached_meta(request, selection, database, cache)

    def load():
        with database.snapshot() as connection:
            row = connection.execute(
                """
                SELECT document FROM horizon_api.project_sow_timeline
                WHERE project_pk = %s AND run_id = %s
                """,
                (project_pk, meta.run_id),
            ).fetchone()
        if row is None:
            raise PublicationNotFound()
        return row["document"]

    document = cache.get(("project-timeline", meta.run_id, project_pk), load)
    tasks = document["tasks"]
    pending = {}
    if tasks:
        with database.snapshot() as connection:
            overrides = connection.execute(
                """
                SELECT DISTINCT ON (task_key) task_key, status, reason, set_at
                FROM horizon_projects.sow_task_overrides
                WHERE project_pk = %s AND set_at > %s AND task_key = ANY(%s)
                ORDER BY task_key, set_at DESC, override_id DESC
                """,
                (project_pk, meta.as_of, [task["taskKey"] for task in tasks]),
            ).fetchall()
            pending = {
                row["task_key"]: {
                    "status": row["status"],
                    "reason": row["reason"],
                    "setAt": row["set_at"].astimezone(timezone.utc).isoformat(),
                }
                for row in overrides
            }
    return published_json(
        request,
        selection,
        meta,
        ("timeline", project_pk),
        lambda: {
            **document,
            "tasks": [
                {**task, "pendingOverride": pending.get(task["taskKey"])}
                for task in tasks
            ],
        },
        live=pending,
    )


@router.get(
    "/{projectPk}/history",
    response_model=list[ProjectHistoryPoint],
    responses=RESPONSE_OPTIONS,
)
def history(
    request: Request, project_pk: ProjectKey, season: Season, database: Database
):
    season_type, season_year = season.split("-")
    with database.snapshot() as connection:
        rows = connection.execute(
            """
            SELECT run_id, as_of, percent_complete, tasks_overdue, risk_counts
            FROM horizon_api.project_summaries
            WHERE project_pk = %s AND season_type = %s AND season_year = %s
            ORDER BY as_of, run_id
            """,
            (project_pk, season_type, int(season_year)),
        ).fetchall()
    if not rows:
        raise PublicationNotFound()
    for row in rows:
        row["as_of"] = row["as_of"].astimezone(timezone.utc)
    points = [
        ProjectHistoryPoint(**row).model_dump(mode="json", by_alias=True)
        for row in rows
    ]
    return conditional_json(request, (DOCUMENT_VERSION, points), lambda: points)
