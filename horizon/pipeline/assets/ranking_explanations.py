"""T4.6: plain-language explanations for a scored run, before it is published."""

# No `from __future__ import annotations` (see ranking.py).
from collections import Counter

from dagster import AssetExecutionContext, Failure, MetadataValue, asset
from psycopg.types.json import Jsonb

from ..config import get_pipeline_settings
from ..ranking import explanations, score_store, store
from ..storage import PostgresResource
from .ranking import RankingRun, _run_rubric


@asset(
    group_name="08_ranking",
    kinds={"python", "postgres"},
    description=(
        "Writes a short explanation of every scored member's numbers to "
        "member_scores.explanation. The model sees only that member's own numbers. "
        "An unchanged input reuses an earlier run's explanation; without an API key, "
        "or after a second invalid answer, a summary of the numbers is stored instead."
    ),
    metadata={"table": "horizon_ranking.member_scores"},
)
def member_explanations(
    context: AssetExecutionContext,
    ranking_run: RankingRun,
    member_scores: int,
    postgres: PostgresResource,
) -> int:
    del member_scores
    settings = get_pipeline_settings()
    client = explanations.make_client(settings.anthropic_api_key)
    return explain_run(context, ranking_run, postgres, client, settings.anthropic_model)


def _cached(connection, sha: str):
    """An earlier generated explanation of the same input; fallbacks are never reused."""

    row = connection.execute(
        """
        SELECT explanation FROM horizon_ranking.member_scores
        WHERE input_sha256 = %s AND prompt_version = %s
          AND (explanation->>'generated')::boolean
        LIMIT 1
        """,
        (sha, explanations.PROMPT_VERSION),
    ).fetchone()
    return row[0] if row else None


def explain_run(context, ranking_run: RankingRun, postgres: PostgresResource, client, model: str) -> int:
    rubric = _run_rubric(ranking_run).rubric
    run_id = ranking_run.ranking_run_id
    with postgres.connect() as connection:
        run = score_store.read_run(connection, run_id)
        if run.status == "published":
            context.add_output_metadata({"retry": MetadataValue.text("already published; unchanged")})
            return 0
        if run.status != "scored":
            raise Failure(description=f"Ranking run {run_id} is {run.status}; explanations need a scored run.")
        members = store.read_ranked_members(connection, run_id)
        scores = score_store.read_scores(connection, run_id)
        metrics = score_store.read_scored_metrics(connection, run_id)
        group_sizes = Counter(member.comparison_group for member in members)
        work = []
        for member in members:
            key = (member.authentik_user_pk, member.project_pk)
            data = explanations.explanation_input(
                member, rubric.roles[member.role], scores[key], metrics[key],
                group_sizes[member.comparison_group],
            )
            sha = explanations.input_sha256(data)
            work.append((key, data, sha, _cached(connection, sha)))

    # The API calls run outside any transaction so no row stays locked meanwhile.
    fresh = explanations.explain_all(client, model, [data for _, data, _, cached in work if cached is None])
    results, sources = [], Counter()
    for key, _data, sha, cached in work:
        result = cached if cached is not None else fresh.pop(0)
        sources["cached" if cached is not None else "generated" if result["generated"] else "fallback"] += 1
        results.append((Jsonb(result), result["model"], explanations.PROMPT_VERSION, sha, run_id, *key))

    with postgres.connect() as connection:
        if score_store.read_run(connection, run_id, lock=True).status != "scored":
            raise Failure(description=f"Ranking run {run_id} changed status while it was being explained.")
        with connection.cursor() as cursor:
            cursor.executemany(
                """
                UPDATE horizon_ranking.member_scores
                SET explanation = %s, explanation_model = %s, prompt_version = %s, input_sha256 = %s
                WHERE ranking_run_id = %s AND authentik_user_pk = %s AND project_pk = %s
                """,
                results,
            )
    context.add_output_metadata({
        "ranking_run_id": MetadataValue.text(run_id),
        "explanations": MetadataValue.json(dict(sources)),
        "model": MetadataValue.text(model if client is not None else "none (no API key)"),
    })
    return len(results)
