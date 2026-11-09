"""Ranking runs: open a run with its source provenance, then snapshot who is ranked.

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
from ..ranking.rubric import load_rubric
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
    return RankingRun(ranking_run_id, config.season_type, config.season_year, as_of)


@asset(
    group_name="08_ranking",
    kinds={"postgres"},
    description=(
        "Snapshots who is ranked in which role for the run: tech leads in one "
        "club-wide group, engineers per project. PMs, designers and project "
        "leads are not ranked in the pilot; archived projects are skipped."
    ),
    metadata={"table": "horizon_ranking.ranked_members"},
)
def ranked_members(
    context: AssetExecutionContext,
    ranking_run: RankingRun,
    postgres: PostgresResource,
) -> int:
    season = (ranking_run.season_type, ranking_run.season_year)
    with postgres.connect() as connection:
        projects = store.read_season_projects(connection, *season)
        members = store.read_season_members(connection, *season)
        ranked = select_ranked_members(projects, members, ranking_run.as_of)
        rows = store.replace_ranked_members(connection, ranking_run.ranking_run_id, ranked)

    roles = Counter(member.role for member in ranked)
    context.add_output_metadata(
        {
            "ranking_run_id": MetadataValue.text(ranking_run.ranking_run_id),
            "persisted_rows": MetadataValue.int(rows),
            "engineers": MetadataValue.int(roles["engineer"]),
            "tech_leads": MetadataValue.int(roles["tech_lead"]),
        }
    )
    return rows
