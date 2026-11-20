"""Ranking runs: open a run with its source provenance, snapshot who is ranked,
then compute their metrics.

Every later Track 4 step writes rows keyed by the ``ranking_run_id`` these
assets produce. A run is marked ``failed`` instead of scored when a project
repository has no recent complete feature run, so the website never ranks on
stale code data.
"""

# No `from __future__ import annotations` in this module: Dagster resolves the
# context and asset-input annotations at decoration time, and PEP 563 turns them
# into strings it then refuses.
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import psycopg
from dagster import AssetExecutionContext, Config, Failure, MetadataValue, asset

from ..ranking import store
from ..ranking.members import (
    RoleMappingError,
    resolve_role_mapping_version,
    select_ranked_members,
)
from ..ranking.metrics_code import (
    METRIC_KEYS as CODE_METRIC_KEYS,
    build_project_contexts,
    compute_run_metrics,
)
from ..ranking.metrics_delivery import (
    METRIC_KEYS as DELIVERY_METRIC_KEYS,
    compute_run_delivery_metrics,
)
from ..ranking.metrics_reviews import (
    METRIC_KEYS as REVIEW_METRIC_KEYS,
    ReviewData,
    compute_run_review_metrics,
)
from ..ranking.metrics_survey import (
    METRIC_KEYS as RATING_METRIC_KEYS,
    compute_run_rating_metrics,
)
from ..ranking.rubric import LoadedRubric, load_rubric
from ..ranking.sources import check_source_freshness
from ..storage import PostgresResource

_T1_1_MISSING = (
    "T1.1 tables missing: horizon_gt_features.projects, project_members and "
    "project_repositories must exist before a ranking run."
)


class RankingRunConfig(Config):
    """Which semester to rank, and as of when.

    ``as_of`` is an ISO-8601 timestamp with an offset; it defaults to now.
    """

    season_type: str
    season_year: int
    as_of: Optional[str] = None
    rubric_version: str = "v1"


@dataclass(frozen=True)
class RankingRun:
    ranking_run_id: str
    season_type: str
    season_year: int
    as_of: datetime
    rubric_version: str
    rubric_sha256: str


def _run_rubric(ranking_run: RankingRun) -> LoadedRubric:
    """The rubric the run stored, refusing a file that changed since."""

    loaded = load_rubric(ranking_run.rubric_version)
    if loaded.sha256 != ranking_run.rubric_sha256:
        raise Failure(
            description=(
                f"rubric {loaded.version} changed during the run; "
                "create a new version instead"
            )
        )
    return loaded


def _resolve_as_of(value: Optional[str]) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    as_of = datetime.fromisoformat(value)
    if as_of.tzinfo is None:
        raise Failure(description=f"as_of {value!r} must include a UTC offset.")
    return as_of


@asset(
    group_name="08_ranking",
    kinds={"postgres"},
    description=(
        "Opens a ranking run for one semester: stores the rubric version, the "
        "latest complete feature run per project repository and the published "
        "projects run. Fails the run when a repository has no complete run in "
        "the 8 days before as_of."
    ),
    metadata={"table": "horizon_ranking.ranking_runs"},
)
def ranking_run(
    context: AssetExecutionContext,
    config: RankingRunConfig,
    feature_store_schema: str,
    postgres: PostgresResource,
) -> RankingRun:
    if config.season_type not in ("FALL", "SPRING"):
        raise Failure(
            description=f"season_type must be FALL or SPRING, not {config.season_type!r}."
        )
    as_of = _resolve_as_of(config.as_of)
    loaded = load_rubric(config.rubric_version)
    season = (config.season_type, config.season_year)

    try:
        with postgres.connect() as connection:
            store.upsert_rubric(connection, loaded)
            projects = store.read_season_projects(connection, *season)
            members = store.read_season_members(connection, *season)
            role_mapping_version = resolve_role_mapping_version(projects, members)
            freshness = check_source_freshness(
                store.read_project_repositories(connection, *season),
                store.latest_complete_runs(connection, as_of),
                as_of,
            )
            project_run_id = store.published_project_run(connection, *season)
            ranking_run_id = store.start_ranking_run(
                connection,
                dagster_run_id=context.run.run_id,
                season_type=config.season_type,
                season_year=config.season_year,
                as_of=as_of,
                rubric_version=loaded.version,
                role_mapping_version=role_mapping_version,
                project_run_id=project_run_id,
                source_runs=freshness.source_runs,
            )
            failure_reason = None
            if not freshness.is_fresh:
                failure_reason = (
                    "No complete feature run in the 8 days before as_of for: "
                    + ", ".join(freshness.stale)
                )
                store.fail_ranking_run(connection, ranking_run_id, failure_reason)
    except psycopg.errors.UndefinedTable as error:
        raise Failure(description=_T1_1_MISSING) from error
    except (store.RubricChangedError, RoleMappingError) as error:
        raise Failure(description=str(error)) from error

    # Raised only after the connection block commits, so the failed row stays.
    if failure_reason is not None:
        raise Failure(
            description=failure_reason,
            metadata={"ranking_run_id": MetadataValue.text(ranking_run_id)},
        )

    context.add_output_metadata(
        {
            "ranking_run_id": MetadataValue.text(ranking_run_id),
            "season": MetadataValue.text(f"{config.season_type} {config.season_year}"),
            "as_of": MetadataValue.text(as_of.isoformat()),
            "rubric_version": MetadataValue.text(loaded.version),
            "role_mapping_version": MetadataValue.text(role_mapping_version),
            "source_runs": MetadataValue.int(len(freshness.source_runs)),
            "project_run_id": MetadataValue.text(project_run_id or "none published"),
        }
    )
    return RankingRun(
        ranking_run_id,
        config.season_type,
        config.season_year,
        as_of,
        loaded.version,
        loaded.sha256,
    )


@asset(
    group_name="08_ranking",
    kinds={"postgres"},
    description=(
        "Snapshots who is ranked in which role for the run: tech leads in one "
        "club-wide group, engineers per project. PMs, designers and project "
        "leads are not ranked in the pilot; archived projects are skipped. "
        "Records the rubric buckets each project's review settings switch off."
    ),
    metadata={"table": "horizon_ranking.ranked_members"},
)
def ranked_members(
    context: AssetExecutionContext,
    ranking_run: RankingRun,
    postgres: PostgresResource,
) -> int:
    loaded = _run_rubric(ranking_run)
    season = (ranking_run.season_type, ranking_run.season_year)
    with postgres.connect() as connection:
        projects = store.read_season_projects(connection, *season)
        members = store.read_season_members(connection, *season)
        team_settings = store.read_team_settings(
            connection, [project.project_pk for project in projects]
        )
        ranked = select_ranked_members(
            projects,
            members,
            ranking_run.as_of,
            rubric=loaded.rubric,
            team_settings=team_settings,
        )
        rows = store.replace_ranked_members(connection, ranking_run.ranking_run_id, ranked)

    roles = Counter(member.role for member in ranked)
    context.add_output_metadata(
        {
            "ranking_run_id": MetadataValue.text(ranking_run.ranking_run_id),
            "persisted_rows": MetadataValue.int(rows),
            "engineers": MetadataValue.int(roles["engineer"]),
            "tech_leads": MetadataValue.int(roles["tech_lead"]),
            "members_with_excluded_buckets": MetadataValue.int(
                sum(1 for member in ranked if member.excluded_buckets)
            ),
        }
    )
    return rows


@asset(
    group_name="08_ranking",
    kinds={"postgres"},
    description=(
        "Computes code ownership, consistency and tenure metrics for every ranked "
        "member of the run and writes them to metric_values. Blame metrics use "
        "the run's source runs; commit activity is read as of the run's as_of. "
        "Missing data is NULL with a reason, never 0."
    ),
    metadata={"table": "horizon_ranking.metric_values"},
)
def code_and_tenure_metrics(
    context: AssetExecutionContext,
    ranking_run: RankingRun,
    ranked_members: int,
    postgres: PostgresResource,
) -> int:
    rubric = _run_rubric(ranking_run).rubric
    run_id = ranking_run.ranking_run_id
    season = (ranking_run.season_type, ranking_run.season_year)
    try:
        with postgres.connect() as connection:
            members = store.read_ranked_members(connection, run_id)
            source_runs = store.read_source_runs(connection, run_id)
            repositories = store.read_repositories_by_project(connection, *season)
            semester_ends = {
                project.project_pk: project.window_end
                for project in store.read_season_projects(connection, *season)
            }
            projects = build_project_contexts(
                members, repositories, source_runs, semester_ends
            )
            project_repositories = sorted(
                {repo for project in projects.values() for repo in project.repositories}
            )
            run_ids = sorted(
                {run for project in projects.values() for run in project.source_runs.values()}
            )
            earliest_start = min(
                (member.window_start for member in members), default=ranking_run.as_of.date()
            )
            values = compute_run_metrics(
                members,
                projects,
                ranking_run.as_of,
                rubric,
                contributions=store.read_engineering_contribution(connection, run_ids),
                blame_rows=store.read_blame_commit_summary(connection, run_ids),
                activity=store.read_member_commit_activity(
                    connection, project_repositories, ranking_run.as_of
                ),
                commits=store.read_git_commits(
                    connection, project_repositories, earliest_start
                ),
            )
            rows = store.replace_metric_values(connection, run_id, CODE_METRIC_KEYS, values)
    except psycopg.errors.UndefinedTable as error:
        raise Failure(
            description=(
                "Input tables missing (T1.1 roster, T2.5 blame_commit_summary or "
                f"T2.6 commit history): {error}"
            )
        ) from error

    missing = Counter(value.missing_reason for value in values if value.missing_reason)
    context.add_output_metadata(
        {
            "ranking_run_id": MetadataValue.text(run_id),
            "persisted_rows": MetadataValue.int(rows),
            "members": MetadataValue.int(len(members)),
            "missing_by_reason": MetadataValue.json(dict(missing)),
        }
    )
    return rows


@asset(
    group_name="08_ranking",
    kinds={"postgres"},
    description=(
        "Computes pull request review, collaboration and survey rating metrics "
        "for every ranked member of the run and writes them to metric_values. "
        "PR events and survey answers are latest-state, so they are read as of "
        "the run's as_of. Buckets the run excluded for a member get no rows."
    ),
    metadata={"table": "horizon_ranking.metric_values"},
)
def review_and_rating_metrics(
    context: AssetExecutionContext,
    ranking_run: RankingRun,
    ranked_members: int,
    postgres: PostgresResource,
) -> int:
    rubric = _run_rubric(ranking_run).rubric
    run_id = ranking_run.ranking_run_id
    season = (ranking_run.season_type, ranking_run.season_year)
    try:
        with postgres.connect() as connection:
            members = store.read_ranked_members(connection, run_id)
            source_runs = store.read_source_runs(connection, run_id)
            semester_ends = {
                project.project_pk: project.window_end
                for project in store.read_season_projects(connection, *season)
            }
            projects = build_project_contexts(
                members,
                store.read_repositories_by_project(connection, *season),
                source_runs,
                semester_ends,
            )
            repositories = sorted(
                {repo for project in projects.values() for repo in project.repositories}
            )
            roster = store.read_season_members(connection, *season)
            data = ReviewData.build(
                store.read_pull_requests(connection, repositories),
                store.read_pr_reviews(connection, repositories),
                store.read_pr_review_requests(connection, repositories),
                store.read_pr_commits(connection, sorted(set(source_runs.values()))),
                source_runs,
                roster,
            )
            values = compute_run_review_metrics(
                members,
                projects,
                roster,
                ranking_run.as_of,
                rubric,
                data,
            ) + compute_run_rating_metrics(
                members,
                ranking_run.as_of,
                rubric,
                store.read_survey_answers(connection, *season),
            )
            rows = store.replace_metric_values(
                connection,
                run_id,
                tuple(dict.fromkeys((*REVIEW_METRIC_KEYS, *RATING_METRIC_KEYS))),
                values,
            )
    except psycopg.errors.UndefinedTable as error:
        raise Failure(
            description=(
                "Input tables missing (T1.1 Gitea PR tables or T3.4 survey tables): "
                f"{error}"
            )
        ) from error

    missing = Counter(value.missing_reason for value in values if value.missing_reason)
    context.add_output_metadata(
        {
            "ranking_run_id": MetadataValue.text(run_id),
            "persisted_rows": MetadataValue.int(rows),
            "members": MetadataValue.int(len(members)),
            "missing_by_reason": MetadataValue.json(dict(missing)),
        }
    )
    return rows


@asset(
    group_name="08_ranking",
    kinds={"postgres"},
    description=(
        "Computes delivery against the SOW for every ranked member of the run and "
        "writes it to metric_values: the mean completion of the due SOW tasks each "
        "engineer owns, and of all the project's due tasks for tech leads. Task "
        "status comes from the Track 5 project run recorded on the ranking run; "
        "with no published project run, every row is NULL with reason no_sow."
    ),
    metadata={"table": "horizon_ranking.metric_values"},
)
def delivery_metrics(
    context: AssetExecutionContext,
    ranking_run: RankingRun,
    ranked_members: int,
    postgres: PostgresResource,
) -> int:
    rubric = _run_rubric(ranking_run).rubric
    run_id = ranking_run.ranking_run_id
    season = (ranking_run.season_type, ranking_run.season_year)
    statuses, overrides, matches = [], [], []
    try:
        with postgres.connect() as connection:
            members = store.read_ranked_members(connection, run_id)
            project_run_id = store.read_project_run_id(connection, run_id)
            semester_ends = {
                project.project_pk: project.window_end
                for project in store.read_season_projects(connection, *season)
            }
            if project_run_id is not None:
                statuses = store.read_sow_task_status(
                    connection,
                    project_run_id,
                    sorted({member.project_pk for member in members}),
                )
                overrides = store.read_sow_task_overrides(connection, project_run_id)
                matches = store.read_sow_task_matches(connection, project_run_id)
            values = compute_run_delivery_metrics(
                members,
                rubric,
                ranking_run.as_of,
                project_run_id,
                semester_ends,
                statuses,
                overrides,
                matches,
            )
            rows = store.replace_metric_values(
                connection, run_id, DELIVERY_METRIC_KEYS, values
            )
    except psycopg.errors.UndefinedTable as error:
        raise Failure(
            description=f"Input tables missing (T5.3/T5.4 SOW task tables): {error}"
        ) from error

    missing = Counter(value.missing_reason for value in values if value.missing_reason)
    context.add_output_metadata(
        {
            "ranking_run_id": MetadataValue.text(run_id),
            "project_run_id": MetadataValue.text(project_run_id or ""),
            "persisted_rows": MetadataValue.int(rows),
            "members": MetadataValue.int(len(members)),
            "sow_tasks": MetadataValue.int(len(statuses)),
            "missing_by_reason": MetadataValue.json(dict(missing)),
        }
    )
    return rows
