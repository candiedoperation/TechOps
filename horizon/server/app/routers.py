from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query

from .auth import Principal, current_user, require_exec
from .models import ApiError, Me, MemberDetail, RankingList, Role, SeasonType, Semester
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
                from fastapi import HTTPException

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
    return ranking_list(store, run, role, project_pk, page, page_size)


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
