import pytest
from dagster import Failure

from pipeline.assets.ranking_scores import _score_run
from pipeline.ranking import score_store

from ranking_db import FIXTURE, FakeContext, needs_postgres, seed_worked_example

pytestmark = needs_postgres


def test_scoring_stores_the_worked_example_and_marks_the_run_scored(ranking_postgres):
    postgres = ranking_postgres
    run = seed_worked_example(postgres)
    context = FakeContext()

    assert _score_run(context, run, postgres) == 4

    with postgres.connect() as connection:
        scores = score_store.read_scores(connection, run.ranking_run_id)
        metrics = score_store.read_scored_metrics(connection, run.ranking_run_id)
        assert score_store.read_run(connection, run.ranking_run_id).status == "scored"
        assert score_store.score_problems(connection, run.ranking_run_id) == []
    expected = FIXTURE["expected"]
    for member, value in expected["overall"].items():
        key = (member, "proj-x")
        assert scores[key].overall_score == pytest.approx(value, abs=1e-9)
        assert scores[key].rank_in_group == expected["rank"][member]
        assert scores[key].buckets["delivery"]["score"] == expected["buckets"][member]["delivery"]
    assert metrics[("D", "proj-x")]["files_majority_owned"].percentile == 0
    assert metrics[("D", "proj-x")]["verified_completion"].group_size == 3
    assert context.metadata["by_status"].data == {"ranked": 4}


def test_rescoring_a_scored_run_only_rechecks_it(ranking_postgres):
    postgres = ranking_postgres
    run = seed_worked_example(postgres)
    _score_run(FakeContext(), run, postgres)
    context = FakeContext()

    assert _score_run(context, run, postgres) == 4
    assert "re-checked" in context.metadata["retry"].text


def test_a_missing_metric_row_fails_the_run(ranking_postgres):
    postgres = ranking_postgres
    run = seed_worked_example(postgres)
    with postgres.connect() as connection:
        connection.execute(
            "DELETE FROM horizon_ranking.metric_values WHERE authentik_user_pk = 'A' AND metric_key = 'eng_design'"
        )

    with pytest.raises(Failure, match="do not match"):
        _score_run(FakeContext(), run, postgres)
    with postgres.connect() as connection:
        failed = score_store.read_run(connection, run.ranking_run_id)
        stored = score_store.read_scores(connection, run.ranking_run_id)
    assert failed.status == "failed" and stored == {}


def test_a_failed_run_is_never_scored(ranking_postgres):
    postgres = ranking_postgres
    run = seed_worked_example(postgres)
    with postgres.connect() as connection:
        connection.execute("UPDATE horizon_ranking.ranking_runs SET status = 'failed'")

    with pytest.raises(Failure, match="only a running run"):
        _score_run(FakeContext(), run, postgres)
