from datetime import date, datetime, timezone

from pipeline.assets.ranking import RankingRunConfig
from pipeline.assets.ranking_scores import _score_run
from pipeline.ranking import score_store
from pipeline.ranking.members import RankedMember
from pipeline.ranking.metrics_survey import compute_run_rating_metrics
from pipeline.ranking.rubric import load_rubric

from ranking_db import FakeContext, needs_postgres, seed_worked_example

V1 = load_rubric("v1").rubric
V2 = load_rubric("v2").rubric
SURVEY_BUCKETS = {"engineer": "peer_ratings", "tech_lead": "leadership_ratings"}


def test_v2_is_v1_without_the_survey_buckets():
    for role, survey_bucket in SURVEY_BUCKETS.items():
        v1 = {bucket.key: bucket for bucket in V1.roles[role].buckets}
        v2 = {bucket.key: bucket for bucket in V2.roles[role].buckets}
        assert set(v1) - set(v2) == {survey_bucket}
        for key, bucket in v2.items():
            assert bucket.metrics == v1[key].metrics and bucket.team_setting == v1[key].team_setting
            # Freed weight is spread in proportion, to whole percentages.
            assert abs(bucket.weight - v1[key].weight * 100 / (100 - v1[survey_bucket].weight)) < 1
    assert V2.rules == V1.rules


def test_v2_is_the_default_and_writes_no_survey_rows():
    assert RankingRunConfig(season_type="FALL", season_year=2026).rubric_version == "v2"
    member = RankedMember("42", "p", "engineer", "Ada", None, "P", "project:p:engineer", 1,
                          date(2026, 8, 31), date(2026, 12, 11))
    as_of = datetime(2026, 11, 8, tzinfo=timezone.utc)
    assert compute_run_rating_metrics([member], as_of, V2, []) == []
    assert compute_run_rating_metrics([member], as_of, V1, [])


@needs_postgres
def test_a_v2_run_scores_without_survey_rows(ranking_postgres):
    run = seed_worked_example(ranking_postgres, rubric_version="v2")
    _score_run(FakeContext(), run, ranking_postgres)
    with ranking_postgres.connect() as connection:
        scores = score_store.read_scores(connection, run.ranking_run_id)
    assert {score.status for score in scores.values()} == {"ranked"}
    assert "peer_ratings" not in scores[("A", "proj-x")].buckets
    assert scores[("A", "proj-x")].coverage == 1.0
