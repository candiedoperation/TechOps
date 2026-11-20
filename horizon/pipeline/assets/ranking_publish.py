"""T4.5 publish step: make a scored ranking run the one the website reads."""

# No `from __future__ import annotations` (see ranking.py).
from dagster import AssetCheckResult, AssetExecutionContext, AssetIn, Failure, MetadataValue, asset, asset_check

from ..ranking import score_store, store
from ..ranking.publish import PublishError, publish_problems, publish_run
from ..storage import PostgresResource
from .ranking import RankingRun, _run_rubric


@asset(
    group_name="08_ranking",
    kinds={"postgres"},
    description=(
        "Publishes a scored, explained run in one transaction: replaces its leaderboard rows and "
        "member documents in horizon_api, moves the semester's ranking publication "
        "to it (keeping the old run as previous_run_id) and marks it published. On "
        "any error the run is marked failed and the previous publication stays."
    ),
    metadata={"table": "horizon_api.ranking_leaderboard"},
)
def publish_ranking(
    context: AssetExecutionContext,
    ranking_run: RankingRun,
    member_explanations: int,
    postgres: PostgresResource,
) -> int:
    del member_explanations
    return _publish(context, ranking_run, postgres)


def _publish(context, ranking_run: RankingRun, postgres: PostgresResource) -> int:
    rubric = _run_rubric(ranking_run).rubric
    run_id = ranking_run.ranking_run_id
    try:
        with postgres.connect() as connection:
            run = score_store.read_run(connection, run_id, lock=True)
            if run.status == "published":
                problems = publish_problems(connection, run)
                if problems:
                    raise Failure(description="Published run is inconsistent: " + "; ".join(problems))
                count = len(store.read_ranked_members(connection, run_id))
                context.add_output_metadata({"ranking_run_id": MetadataValue.text(run_id),
                                             "retry": MetadataValue.text("already published; re-checked only")})
                return count
            count = publish_run(connection, run, rubric)
    except Failure:
        raise
    except (PublishError, ValueError, RuntimeError) as error:
        with postgres.connect() as connection:
            store.fail_ranking_run(connection, run_id, f"publish: {error}")
        raise Failure(description=f"Publishing failed; the previous publication is unchanged: {error}") from error

    context.add_output_metadata({
        "ranking_run_id": MetadataValue.text(run_id),
        "leaderboard_rows": MetadataValue.int(count),
        "season": MetadataValue.text(f"{ranking_run.season_type} {ranking_run.season_year}"),
    })
    return count


@asset_check(
    asset=publish_ranking,
    additional_ins={"ranking_run": AssetIn("ranking_run")},
    description="The publication points at this run and every ranked member has a valid row and document.",
)
def publish_ranking_integrity(ranking_run: RankingRun, postgres: PostgresResource) -> AssetCheckResult:
    with postgres.connect() as connection:
        run = score_store.read_run(connection, ranking_run.ranking_run_id)
        problems = publish_problems(connection, run)
    return AssetCheckResult(
        passed=not problems,
        description="; ".join(problems) or "Published read models match the run.",
        metadata={"ranking_run_id": MetadataValue.text(ranking_run.ranking_run_id)},
    )
