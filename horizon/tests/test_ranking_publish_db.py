from datetime import timedelta

import pytest
from dagster import Failure

from pipeline.assets.ranking_explanations import explain_run
from pipeline.assets.ranking_publish import _publish
from pipeline.assets.ranking_scores import _score_run
from pipeline.ranking import publish, score_store
from pipeline.ranking.read_models import RankingDocument

from ranking_db import AS_OF, FakeContext, needs_postgres, seed_worked_example

pytestmark = needs_postgres


def _scored(postgres, dagster_run_id, as_of=AS_OF, scale=1.0):
    run = seed_worked_example(postgres, dagster_run_id=dagster_run_id, as_of=as_of, scale=scale)
    _score_run(FakeContext(), run, postgres)
    explain_run(FakeContext(), run, postgres, None, "none")
    return run


def _publication(postgres):
    with postgres.connect() as connection:
        return connection.execute(
            "SELECT run_id, previous_run_id FROM horizon_api.publications WHERE domain = 'ranking'"
        ).fetchone()


def test_publishing_writes_read_models_and_points_the_semester_at_the_run(ranking_postgres):
    run = _scored(ranking_postgres, "dagster-a")

    assert _publish(FakeContext(), run, ranking_postgres) == 4

    assert _publication(ranking_postgres) == (run.ranking_run_id, None)
    with ranking_postgres.connect() as connection:
        stored = score_store.read_run(connection, run.ranking_run_id)
        assert stored.status == "published"
        assert publish.publish_problems(connection, stored) == []
        leader = connection.execute(
            """SELECT comparison_group_label, rank_in_group, bucket_scores->>'delivery'
               FROM horizon_api.ranking_leaderboard WHERE authentik_user_pk = 'A'"""
        ).fetchone()
        document = connection.execute(
            "SELECT document FROM horizon_api.ranking_member_detail WHERE authentik_user_pk = 'D'"
        ).fetchone()[0]
    assert leader == ("Engineers on Project X", 1, "100.0")
    parsed = RankingDocument.model_validate(document)
    assert parsed.overall.rank_in_group == 4 and len(parsed.history) == 1
    evidence = parsed.buckets[0].metrics[0].evidence
    assert evidence == {"per_repository": {"org/api": 1}}  # the email in the fixture is not published


def test_a_second_run_keeps_the_first_as_previous_and_in_history(ranking_postgres):
    first = _scored(ranking_postgres, "dagster-a")
    _publish(FakeContext(), first, ranking_postgres)
    second = _scored(ranking_postgres, "dagster-b", as_of=AS_OF + timedelta(days=7), scale=20.0)

    _publish(FakeContext(), second, ranking_postgres)

    assert _publication(ranking_postgres) == (second.ranking_run_id, first.ranking_run_id)
    with ranking_postgres.connect() as connection:
        document = connection.execute(
            "SELECT document FROM horizon_api.ranking_member_detail WHERE ranking_run_id = %s AND authentik_user_pk = 'D'",
            (second.ranking_run_id,),
        ).fetchone()[0]
    assert [entry["rankingRunId"] for entry in document["history"]] == [first.ranking_run_id, second.ranking_run_id]


def test_a_failure_mid_publish_leaves_the_previous_publication(ranking_postgres, monkeypatch):
    first = _scored(ranking_postgres, "dagster-a")
    _publish(FakeContext(), first, ranking_postgres)
    second = _scored(ranking_postgres, "dagster-b", as_of=AS_OF + timedelta(days=7))

    def explode(*args):
        raise RuntimeError("injected failure after the read models were written")

    monkeypatch.setattr(score_store, "set_status", explode)
    with pytest.raises(Failure, match="previous publication is unchanged"):
        _publish(FakeContext(), second, ranking_postgres)

    assert _publication(ranking_postgres) == (first.ranking_run_id, None)
    with ranking_postgres.connect() as connection:
        assert score_store.read_run(connection, second.ranking_run_id).status == "failed"
        rows = connection.execute(
            "SELECT count(*) FROM horizon_api.ranking_leaderboard WHERE ranking_run_id = %s",
            (second.ranking_run_id,),
        ).fetchone()[0]
    assert rows == 0


def test_republishing_is_a_recheck_and_unscored_or_older_runs_are_refused(ranking_postgres):
    newer = _scored(ranking_postgres, "dagster-new", as_of=AS_OF + timedelta(days=7))
    _publish(FakeContext(), newer, ranking_postgres)
    context = FakeContext()
    assert _publish(context, newer, ranking_postgres) == 4
    assert "re-checked" in context.metadata["retry"].text

    older = _scored(ranking_postgres, "dagster-old")
    with pytest.raises(Failure, match="newer run"):
        _publish(FakeContext(), older, ranking_postgres)

    running = seed_worked_example(ranking_postgres, dagster_run_id="dagster-running")
    with pytest.raises(Failure, match="only a scored run"):
        _publish(FakeContext(), running, ranking_postgres)
    assert _publication(ranking_postgres)[0] == newer.ranking_run_id
