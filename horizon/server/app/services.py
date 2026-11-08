from collections.abc import Sequence
from datetime import datetime, timezone
from uuid import UUID

from .errors import PublicationNotFound
from .models import History, MemberDetail, RankingList, Run, metadata
from .ports import ReadStore


def select_run(runs: Sequence[Run], selection: str) -> Run:
    candidates = [run for run in runs if run.status == "complete"]
    if selection == "final":
        # Provisional rule: latest completed final, not latest non-final fallback.
        candidates = [run for run in candidates if run.is_final]
    elif selection != "latest":
        candidates = [
            run for run in candidates if run.ranking_run_id == UUID(selection)
        ]
    if not candidates:
        raise PublicationNotFound()
    return max(candidates, key=lambda run: (run.as_of, str(run.ranking_run_id)))


def ranking_list(
    store: ReadStore,
    run: Run,
    role: str | None,
    project_pk: str | None,
    page: int,
    page_size: int,
) -> RankingList:
    rows = [
        item.ranking
        for item in store.rows(run.ranking_run_id)
        if (role is None or item.ranking.role == role)
        and (project_pk is None or item.ranking.project_pk == project_pk)
    ]
    # Persisted ranks/scores only; deterministic tie breakers keep page boundaries stable.
    rows.sort(
        key=lambda row: (
            row.comparison_group,
            row.rank_in_group is None,
            row.rank_in_group or 0,
            row.user_pk,
            row.project_pk,
            row.role,
        )
    )
    start = (page - 1) * page_size
    return RankingList(
        **metadata(run, datetime.now(timezone.utc)),
        items=rows[start : start + page_size],
        page=page,
        page_size=page_size,
        total=len(rows),
    )


def member_detail(
    store: ReadStore, run: Run, user_pk: str, semester_runs: Sequence[Run]
) -> MemberDetail:
    items = [
        item
        for item in store.rows(run.ranking_run_id)
        if item.ranking.user_pk == user_pk
    ]
    if not items:
        raise PublicationNotFound()
    history = []
    for previous in sorted(
        semester_runs, key=lambda value: (value.as_of, str(value.ranking_run_id))
    ):
        if previous.status != "complete":
            continue
        for item in store.rows(previous.ranking_run_id):
            row = item.ranking
            if row.user_pk == user_pk:
                history.append(
                    History(
                        ranking_run_id=previous.ranking_run_id,
                        as_of=previous.as_of,
                        project_pk=row.project_pk,
                        role=row.role,
                        overall_score=row.overall_score,
                        rank_in_group=row.rank_in_group,
                    )
                )
    return MemberDetail(
        **metadata(run, datetime.now(timezone.utc)),
        user_pk=user_pk,
        items=items,
        history=history,
    )
