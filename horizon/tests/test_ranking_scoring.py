import json
import math
from pathlib import Path

import pytest

from pipeline.ranking.metrics_code import MetricValue
from pipeline.ranking.rubric import Bucket, Metric, RoleRubric, RubricRules, load_rubric
from pipeline.ranking.scoring import competition_ranks, percentiles, score_group, scored_metric_keys

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "ranking_worked_example.json").read_text())
RUBRIC = load_rubric("v1").rubric
ENGINEER = RUBRIC.roles["engineer"]


def _row(key, value, bucket="b"):
    if isinstance(value, dict):
        return MetricValue("u", "p", bucket, key, value["raw"], value["reason"], {})
    return MetricValue("u", "p", bucket, key, value, None if value is not None else "missing", {})


def _worked_rows(excluded=()):
    keys = scored_metric_keys(ENGINEER, excluded)
    return {
        member: {key: _row(key, value) for key, value in values.items() if key in keys}
        for member, values in FIXTURE["members"].items()
    }


def test_worked_example_matches_percentiles_buckets_coverage_and_ranks():
    scores = score_group(_worked_rows(), ENGINEER, RUBRIC.rules)
    expected = FIXTURE["expected"]
    for metric_key, by_member in expected["percentiles"].items():
        for member, value in by_member.items():
            actual = scores[member].metrics[metric_key].percentile
            assert actual is None if value is None else actual == pytest.approx(value, abs=1e-9)
    for metric_key, size in expected["group_sizes"].items():
        assert {score.metrics[metric_key].group_size for score in scores.values()} == {size}
    for member, buckets in expected["buckets"].items():
        for bucket_key, value in buckets.items():
            actual = scores[member].buckets[bucket_key].score
            assert actual is None if value is None else actual == pytest.approx(value, abs=1e-9)
    for bucket_key, value in expected["bucket_coverage_d"].items():
        assert scores["D"].buckets[bucket_key].metric_coverage == pytest.approx(value)
    for member, score in scores.items():
        assert score.coverage == pytest.approx(expected["coverage"][member])
        assert score.overall_score == pytest.approx(expected["overall"][member], abs=1e-9)
        assert score.rank_in_group == expected["rank"][member]
        assert score.ranked_in_group == 4 and score.status == "ranked"
    assert scores["D"].metrics["verified_completion"].missing_reason == "no_owned_tasks"
    assert scores["D"].metrics["review_turnaround_hours"].missing_reason == "no_review_requests"


def test_hand_checked_worked_example_values():
    scores = score_group(_worked_rows(), ENGINEER, RUBRIC.rules)
    # D's review bucket: (0.40 * 33.333 + 0.30 * 0) / (0.40 + 0.30).
    assert scores["D"].buckets["review_collaboration"].score == pytest.approx((0.4 * 100 / 3) / 0.7)
    # D has no delivery data: the bucket is re-weighted away, not scored as 0.
    present = 0.30 * 0 + 0.15 * 0 + 0.15 * (0.4 * 100 / 3) / 0.7 + 0.10 * 25 / 3 + 0.10 * 50 / 3
    assert scores["D"].overall_score == pytest.approx(present / 0.80)
    assert scores["D"].coverage == pytest.approx(0.30 + 0 + 0.15 + 0.15 * 0.70 + 0.10 + 0.10)


def test_excluded_bucket_weight_is_split_over_the_other_buckets():
    excluded = ("review_collaboration",)
    scores = score_group(_worked_rows(excluded), ENGINEER, RUBRIC.rules, excluded)
    expected = FIXTURE["expected"]["review_collaboration_off"]
    for bucket_key, weight in expected["weights"].items():
        assert scores["A"].weights[bucket_key] == pytest.approx(weight)
    assert "review_collaboration" not in scores["A"].buckets
    for member, value in expected["overall"].items():
        assert scores[member].overall_score == pytest.approx(value)
    assert scores["D"].coverage == pytest.approx(expected["coverage"]["D"])


def test_rows_for_an_excluded_bucket_are_rejected():
    with pytest.raises(ValueError, match="do not match"):
        score_group(_worked_rows(), ENGINEER, RUBRIC.rules, ("review_collaboration",))


def test_group_of_one_is_group_too_small_with_null_percentiles():
    rows = {"solo": {key: _row(key, 1) for key in scored_metric_keys(ENGINEER)}}
    solo = score_group(rows, ENGINEER, RUBRIC.rules)["solo"]
    assert solo.status == "group_too_small"
    assert solo.overall_score is None and solo.rank_in_group is None
    assert all(m.percentile is None and m.missing_reason == "group_too_small" for m in solo.metrics.values())


def _one_bucket(*shares):
    return RoleRubric(comparison_group="project", buckets=(Bucket(
        key="b", label="B", weight=100,
        metrics=tuple(Metric(key=f"m{i}", label=f"M{i}", unit="ratio", share=share,
                             direction="higher_is_better") for i, share in enumerate(shares)),
    ),))


def _simple(members):
    return {name: {f"m{i}": _row(f"m{i}", v) for i, v in enumerate(values)} for name, values in members.items()}


@pytest.mark.parametrize(("coverage", "status"), [(0.5999, "insufficient_data"), (0.60, "ranked")])
def test_coverage_below_sixty_percent_is_insufficient(coverage, status):
    role = _one_bucket(coverage * 100, (1 - coverage) * 100)
    scores = score_group(_simple({"a": [1, None], "b": [2, None]}), role, RUBRIC.rules)
    assert scores["a"].coverage == pytest.approx(coverage)
    assert scores["a"].status == status
    assert (scores["a"].overall_score is None) == (status != "ranked")


def test_scores_within_1e9_share_a_rank_and_the_next_rank_skips():
    assert competition_ranks({"a": 80.0, "b": 80.0 - 1e-12, "c": 50.0}) == {"a": 1, "b": 1, "c": 3}
    assert competition_ranks({"a": 10, "b": 8, "c": 8, "d": 1}) == {"a": 1, "b": 2, "c": 2, "d": 4}


def test_raw_values_tie_exactly_and_nulls_are_not_ranked_last():
    ranked = percentiles({"a": 1.0, "b": 1.0, "c": 1.0 + 1e-12, "d": None}, "higher_is_better")
    assert ranked == {"a": 25.0, "b": 25.0, "c": 100.0, "d": None}
    assert percentiles({"a": 3.0, "b": 1.0}, "lower_is_better") == {"a": 0.0, "b": 100.0}


def test_missing_rows_and_non_finite_values_are_errors():
    with pytest.raises(ValueError, match="do not match"):
        score_group({"a": {}}, ENGINEER, RUBRIC.rules)
    with pytest.raises(ValueError, match="finite"):
        score_group(_simple({"a": [math.inf], "b": [1]}), _one_bucket(100), RUBRIC.rules)


def test_tech_leads_are_scored_club_wide():
    role = RUBRIC.roles["tech_lead"]
    rows = {
        name: {key: _row(key, float(index)) for key in scored_metric_keys(role)}
        for index, name in enumerate(("lead-a", "lead-b"))
    }
    scores = score_group(rows, role, RUBRIC.rules)
    assert scores["lead-a"].status == scores["lead-b"].status == "ranked"
    assert (scores["lead-b"].rank_in_group, scores["lead-a"].rank_in_group) == (1, 2)
