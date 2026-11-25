"""T4.5 scoring: turn a run's metric rows into percentiles, scores and ranks."""

# No `from __future__ import annotations`: Dagster resolves the asset-input
# annotations at decoration time (see ranking.py).
from collections import Counter

from dagster import (
    AssetCheckResult,
    AssetExecutionContext,
    AssetIn,
    Failure,
    MetadataValue,
    asset,
    asset_check,
)

from ..ranking import score_store, store
from ..ranking.scoring import score_group
from ..storage import PostgresResource
from .ranking import RankingRun, _run_rubric


@asset(
    group_name="08_ranking",
    kinds={"postgres"},
    description=(
        "Scores every ranked member of the run: percentiles per metric inside the "
        "comparison group, share-weighted bucket scores, coverage, the overall "
        "score and the rank. Writes member_scores and marks the run scored. "
        "Re-running a scored run only re-checks it."
    ),
    metadata={"table": "horizon_ranking.member_scores"},
)
def member_scores(
    context: AssetExecutionContext,
    ranking_run: RankingRun,
    code_and_tenure_metrics: int,
    review_and_rating_metrics: int,
    delivery_metrics: int,
    postgres: PostgresResource,
) -> int:
    del code_and_tenure_metrics, review_and_rating_metrics, delivery_metrics
    return _score_run(context, ranking_run, postgres)


def _score_run(context, ranking_run: RankingRun, postgres: PostgresResource) -> int:
    rubric = _run_rubric(ranking_run).rubric
    run_id = ranking_run.ranking_run_id
    try:
        with postgres.connect() as connection:
            run = score_store.read_run(connection, run_id)
            if run.status in ("scored", "published"):
                problems = score_store.score_problems(connection, run_id)
                if problems:
                    raise Failure(description="Stored scores are inconsistent: " + "; ".join(problems))
                count = len(score_store.read_scores(connection, run_id))
                context.add_output_metadata({"ranking_run_id": MetadataValue.text(run_id),
                                             "member_rows": MetadataValue.int(count),
                                             "retry": MetadataValue.text("already scored; re-checked only")})
                return count
            if run.status != "running" or run.is_final:
                raise Failure(description=f"Ranking run {run_id} is {run.status}; only a running run is scored.")
            # T4.1's lock: holds the run row and refuses unless it is still running.
            store._lock_running_run(connection, run_id, "score members")
            members = store.read_ranked_members(connection, run_id)
            metrics = score_store.read_unscored_metrics(connection, run_id)
            scores = {}
            for group in score_store.group_members(members).values():
                role, excluded = group[0].role, group[0].excluded_buckets
                rows = {(m.authentik_user_pk, m.project_pk): metrics.get((m.authentik_user_pk, m.project_pk), {})
                        for m in group}
                scores.update(score_group(rows, rubric.roles[role], rubric.rules, excluded))
            count = score_store.write_scores(connection, run_id, scores)
            score_store.set_status(connection, run_id, "running", "scored")
    except ValueError as error:
        with postgres.connect() as connection:
            store.fail_ranking_run(connection, run_id, f"scoring: {error}")
        raise Failure(description=f"Scoring failed: {error}") from error

    statuses = Counter(score.status for score in scores.values())
    context.add_output_metadata({
        "ranking_run_id": MetadataValue.text(run_id),
        "member_rows": MetadataValue.int(count),
        "by_status": MetadataValue.json(dict(statuses)),
        "comparison_groups": MetadataValue.int(len({m.comparison_group for m in members})),
    })
    return count


@asset_check(
    asset=member_scores,
    additional_ins={"ranking_run": AssetIn("ranking_run")},
    description="One score per ranked member; ranks and scores match each status.",
)
def member_scores_integrity(ranking_run: RankingRun, postgres: PostgresResource) -> AssetCheckResult:
    with postgres.connect() as connection:
        problems = score_store.score_problems(connection, ranking_run.ranking_run_id)
    return AssetCheckResult(
        passed=not problems,
        description="; ".join(problems) or "Every ranked member has a consistent score row.",
        metadata={"ranking_run_id": MetadataValue.text(ranking_run.ranking_run_id)},
    )
