from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from .auth import Principal, current_user, require_exec
from .models import (
    ApiError,
    Me,
    MemberDetail,
    Project,
    RankingList,
    Role,
    RunMetadata,
    SeasonType,
    Semester,
    metadata,
)
from .query import Season
from .ports import RankingAudit, ReadStore, get_audit, get_store
from .services import member_detail, ranking_list, select_run

router = APIRouter(
    prefix="/api",
    responses={status: {"model": ApiError} for status in (401, 403, 404, 422, 503)},
)
User = Annotated[Principal, Depends(current_user)]
Executive = Annotated[Principal, Depends(require_exec)]
Store = Annotated[ReadStore, Depends(get_store)]
Audit = Annotated[RankingAudit, Depends(get_audit)]


class Selection:
    def __init__(
        self,
        season_type: Annotated[SeasonType, Query(alias="seasonType")],
        season_year: Annotated[int, Query(alias="seasonYear", ge=2000, le=2200)],
        run: Annotated[str, Query(max_length=36)] = "latest",
    ):
        if run not in ("latest", "final"):
            try:
                UUID(run)
            except ValueError:
                raise HTTPException(
                    422, "run must be latest, final, or a UUID."
                ) from None
        self.season_type, self.season_year, self.run = season_type, season_year, run


@router.get("/me", response_model=Me)
def me(user: User, store: Store):
    return Me(
        user_pk=user.user_pk,
        name=user.name,
        is_exec=user.is_exec,
        projects=store.projects_for(user.user_pk),
    )


@router.get("/semesters", response_model=list[Semester])
def semesters(user: User, store: Store):
    # Only confirmed persisted project/semester associations may supply this list.
    return store.semesters()


@router.get("/rankings", response_model=RankingList)
def rankings(
    user: Executive,
    selection: Annotated[Selection, Depends()],
    store: Store,
    audit: Audit,
    role: Role | None = None,
    project_pk: Annotated[
        str | None, Query(alias="projectPk", min_length=1, max_length=200)
    ] = None,
    page: Annotated[int, Query(ge=1, le=1000000)] = 1,
    page_size: Annotated[int, Query(alias="pageSize", ge=1, le=100)] = 25,
):
    run = select_run(
        store.runs(selection.season_type, selection.season_year), selection.run
    )
    audit.record_read(user, "ranking_list", run.ranking_run_id, None)
    return ranking_list(
        store.rows(run.ranking_run_id), run, role, project_pk, page, page_size
    )


@router.get("/rankings/members/{userPk}", response_model=MemberDetail)
def member(
    user_pk: Annotated[str, Path(alias="userPk", min_length=1, max_length=200)],
    user: Executive,
    selection: Annotated[Selection, Depends()],
    store: Store,
    audit: Audit,
):
    runs = store.runs(selection.season_type, selection.season_year)
    run = select_run(runs, selection.run)
    audit.record_read(user, "member_detail", run.ranking_run_id, user_pk)
    return member_detail(store, run, user_pk, runs)


class RankingSelection(Selection):
    def __init__(
        self, season: Season, run: Annotated[str, Query(max_length=36)] = "current"
    ):
        season_type, season_year = season.split("-")
        super().__init__(
            season_type, int(season_year), "latest" if run == "current" else run
        )


class RankingPublication(RankingList):
    projects: list[Project]


@router.get("/v1/rankings/runs", response_model=list[RunMetadata])
def ranking_runs(
    user: Executive,
    season: Season,
    store: Store,
    audit: Audit,
):
    season_type, season_year = season.split("-")
    runs = sorted(
        (
            run
            for run in store.runs(season_type, int(season_year))
            if run.status == "complete"
        ),
        key=lambda run: (run.as_of, run.ranking_run_id),
        reverse=True,
    )
    now = datetime.now(timezone.utc)
    for run in runs:
        audit.record_read(user, "ranking_runs", run.ranking_run_id, None)
    return [metadata(run, now) for run in runs]


@router.get("/v1/rankings", response_model=RankingPublication)
def published_rankings(
    user: Executive,
    selection: Annotated[RankingSelection, Depends()],
    store: Store,
    audit: Audit,
    role: Role = "engineer",
    project_pk: Annotated[
        str | None, Query(alias="projectPk", min_length=1, max_length=200)
    ] = None,
    page: Annotated[int, Query(ge=1, le=1000000)] = 1,
    page_size: Annotated[int, Query(alias="pageSize", ge=1, le=100)] = 25,
):
    run = select_run(
        store.runs(selection.season_type, selection.season_year), selection.run
    )
    audit.record_read(user, "ranking_list", run.ranking_run_id, None)
    rows = store.rows(run.ranking_run_id)
    page_result = ranking_list(
        rows, run, role, project_pk if role == "engineer" else None, page, page_size
    )
    projects = (
        {
            item.ranking.project_pk: item.ranking.project_name
            for item in rows
            if item.ranking.role == "engineer"
        }
        if role == "engineer"
        else {}
    )
    return RankingPublication(
        **page_result.model_dump(),
        projects=[
            Project(project_pk=key, friendly_name=name)
            for key, name in sorted(
                projects.items(), key=lambda item: (item[1], item[0])
            )
        ],
    )
