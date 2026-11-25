from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError

from pipeline.ranking.members import RankedMember
from pipeline.ranking.read_models import (
    LEADERBOARD_COLUMNS,
    RankingDocument,
    StoredMetric,
    StoredScore,
    build_document,
    comparison_group_label,
    leaderboard_row,
    public_evidence,
)
from pipeline.ranking.rubric import load_rubric
from pipeline.ranking.scoring import scored_metric_keys

RUBRIC = load_rubric("v1").rubric
AS_OF = datetime(2026, 11, 8, 23, 59, tzinfo=timezone.utc)


def _member(role="engineer", excluded=()):
    return RankedMember(
        authentik_user_pk="42", project_pk="proj-x", role=role, display_name="Ada",
        role_title="Software Engineer", project_name="Project X",
        comparison_group="project:proj-x:engineer" if role == "engineer" else "club:tech_lead",
        tenure_semesters=3, window_start=date(2026, 8, 31), window_end=date(2026, 12, 11),
        excluded_buckets=tuple(excluded),
    )


def _inputs(role="engineer", excluded=()):
    role_rubric = RUBRIC.roles[role]
    metrics = {
        key: StoredMetric(1.0, None, 50.0, 4, {"per_repository": {"org/api": 1}})
        for key in scored_metric_keys(role_rubric, excluded)
    }
    buckets = {
        bucket.key: {"score": 50.0, "metricCoverage": 1.0}
        for bucket in role_rubric.buckets if bucket.key not in excluded
    }
    score = StoredScore(buckets, 50.0, 1.0, "ranked", 2, 4, explanation={
        "summary": "Ada is ranked 2 of 4 engineers on Project X.", "data_gaps": [],
        "bucket_notes": {"delivery": "All due tasks have merged PR evidence."},
        "model": "fixture", "generated": True,
    })
    return role_rubric, score, metrics


def test_document_has_the_published_shape_and_effective_weights():
    role_rubric, score, metrics = _inputs()
    history = [{"rankingRunId": "run-0", "asOf": "2026-11-01T23:59:00+00:00", "status": "ranked",
                "overallScore": 40.0, "rankInGroup": 3}]
    document = build_document(
        ranking_run_id="run-1", as_of=AS_OF, rubric_version="v1", member=_member(),
        role_rubric=role_rubric, score=score, metrics=metrics, history=history,
    )
    assert RankingDocument.model_validate(document)
    assert document["overall"]["comparisonGroupLabel"] == "Engineers on Project X"
    assert [bucket["weight"] for bucket in document["buckets"]] == pytest.approx([0.3, 0.2, 0.15, 0.15, 0.1, 0.1])
    delivery = next(bucket for bucket in document["buckets"] if bucket["key"] == "delivery")
    assert delivery["note"] == "All due tasks have merged PR evidence."
    assert delivery["metrics"][0]["share"] == 1.0
    assert document["explanation"]["dataGaps"] == []
    assert document["history"] == history


def test_excluded_bucket_is_left_out_and_its_weight_redistributed():
    excluded = ("review_collaboration",)
    role_rubric, score, metrics = _inputs(excluded=excluded)
    document = build_document(
        ranking_run_id="run-1", as_of=AS_OF, rubric_version="v1", member=_member(excluded=excluded),
        role_rubric=role_rubric, score=score, metrics=metrics, history=[],
    )
    weights = {bucket["key"]: bucket["weight"] for bucket in document["buckets"]}
    assert "review_collaboration" not in weights
    assert weights["code_ownership"] == pytest.approx(0.33)
    assert sum(weights.values()) == pytest.approx(1.0)


def test_unranked_document_has_no_score_and_rank():
    role_rubric, score, metrics = _inputs(role="tech_lead")
    unranked = StoredScore(score.buckets, None, 0.4, "insufficient_data", None, None)
    document = build_document(
        ranking_run_id="run-1", as_of=AS_OF, rubric_version="v1", member=_member("tech_lead"),
        role_rubric=role_rubric, score=unranked, metrics=metrics, history=[],
    )
    assert document["overall"]["comparisonGroupLabel"] == "All tech leads"
    assert document["overall"]["score"] is None and document["explanation"] is None


def test_out_of_range_values_fail_validation():
    role_rubric, score, metrics = _inputs()
    bad = StoredScore(score.buckets, 101.0, 1.0, "ranked", 1, 1)
    with pytest.raises(ValidationError):
        build_document(ranking_run_id="run-1", as_of=AS_OF, rubric_version="v1", member=_member(),
                       role_rubric=role_rubric, score=bad, metrics=metrics, history=[])


def test_evidence_is_allowlisted_and_people_lists_become_counts():
    evidence = {
        "per_repository": {"org/api": 3}, "respondent_count": 2,
        "round_means": {"2026-10": 3.0}, "engineers_with_prs": ["1", "2", "3"],
        "engineers_reviewed": ["1"], "reviewer_email": "someone@example.test",
    }
    assert public_evidence(evidence) == {
        "per_repository": {"org/api": 3}, "respondent_count": 2,
        "engineer_count": 3, "reviewed_engineer_count": 1,
    }
    assert public_evidence(None) == {}


def test_leaderboard_row_matches_its_columns():
    _, score, _ = _inputs()
    row = leaderboard_row(ranking_run_id="run-1", season_type="FALL", season_year=2026,
                          as_of=AS_OF, member=_member(), score=score)
    named = dict(zip(LEADERBOARD_COLUMNS, row, strict=True))
    assert named["comparison_group_label"] == comparison_group_label(_member())
    assert named["bucket_scores"]["code_ownership"] == 50.0
    assert named["rank_in_group"] == 2 and named["tenure_semesters"] == 3
