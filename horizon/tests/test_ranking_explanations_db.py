from dagster import Failure
import pytest

from pipeline.assets.ranking_explanations import explain_run
from pipeline.assets.ranking_publish import _publish
from pipeline.assets.ranking_scores import _score_run

from ranking_db import FakeContext, needs_postgres, seed_worked_example
from test_ranking_explanations import BUCKETS, FakeClient, _answer

pytestmark = needs_postgres


def _scored(postgres, dagster_run_id):
    run = seed_worked_example(postgres, dagster_run_id=dagster_run_id)
    _score_run(FakeContext(), run, postgres)
    return run


def test_explanations_are_stored_and_published_into_the_document(ranking_postgres):
    run = _scored(ranking_postgres, "dagster-a")
    notes = {key: f"Note on {key}." for key in BUCKETS}
    client = FakeClient(*[_answer(notes=notes) for _ in range(4)])
    context = FakeContext()

    assert explain_run(context, run, ranking_postgres, client, "claude-sonnet-5-5") == 4
    assert context.metadata["explanations"].data == {"generated": 4}
    _publish(FakeContext(), run, ranking_postgres)

    with ranking_postgres.connect() as connection:
        model, version, sha = connection.execute(
            """SELECT explanation_model, prompt_version, input_sha256 FROM horizon_ranking.member_scores
               WHERE authentik_user_pk = 'A'"""
        ).fetchone()
        document = connection.execute(
            "SELECT document FROM horizon_api.ranking_member_detail WHERE authentik_user_pk = 'A'"
        ).fetchone()[0]
    assert (model, version, len(sha)) == ("claude-test", "explain-v1", 64)
    assert document["explanation"] == {"summary": "Ada's numbers are in the middle of the group.",
                                       "dataGaps": ["No owned SOW tasks yet."], "model": "claude-test",
                                       "generated": True}
    assert document["buckets"][0]["note"] == f"Note on {document['buckets'][0]['key']}."
    for request in client.calls:
        assert "Member A" not in request["messages"][0]["content"]


def test_an_unchanged_input_reuses_the_earlier_explanation(ranking_postgres):
    first = _scored(ranking_postgres, "dagster-a")
    explain_run(FakeContext(), first, ranking_postgres, FakeClient(*[_answer() for _ in range(4)]), "m")
    _publish(FakeContext(), first, ranking_postgres)
    second = _scored(ranking_postgres, "dagster-b")
    client = FakeClient()
    context = FakeContext()

    explain_run(context, second, ranking_postgres, client, "m")

    assert client.calls == [] and context.metadata["explanations"].data == {"cached": 4}


def test_without_a_client_every_member_gets_the_fallback(ranking_postgres):
    run = _scored(ranking_postgres, "dagster-a")
    context = FakeContext()
    explain_run(context, run, ranking_postgres, None, "m")
    assert context.metadata["explanations"].data == {"fallback": 4}


def test_a_running_run_is_not_explained(ranking_postgres):
    run = seed_worked_example(ranking_postgres)
    with pytest.raises(Failure, match="need a scored run"):
        explain_run(FakeContext(), run, ranking_postgres, None, "m")


def test_fallbacks_are_not_reused_once_a_key_is_configured(ranking_postgres):
    first = _scored(ranking_postgres, "dagster-a")
    explain_run(FakeContext(), first, ranking_postgres, None, "m")
    _publish(FakeContext(), first, ranking_postgres)
    second = _scored(ranking_postgres, "dagster-b")
    context = FakeContext()

    explain_run(context, second, ranking_postgres, FakeClient(*[_answer() for _ in range(4)]), "m")

    assert context.metadata["explanations"].data == {"generated": 4}
