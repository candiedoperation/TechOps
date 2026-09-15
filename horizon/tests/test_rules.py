"""Unit tests for the aggregate-only MVP rule engine."""

from __future__ import annotations

from copy import deepcopy
import json

from backend.rules import (
    DEFAULT_AGGREGATION_FLOOR,
    RULES,
    activity_decline,
    contributor_resilience,
    evaluate_mvp_rules,
    inactivity,
    median_baseline,
    merged_throughput,
    open_pr_aging,
    percentile_baseline,
    review_latency,
)


def _week(number: int, **overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "week_start": f"2026-06-{number:02d}",
        "active_days": 6,
        "days_since_activity": 1,
        "oldest_open_pr_days": 2,
        "review_latency_days": 2,
        "merged_count": 4,
        "active_contributors": 4,
        "team_size": 5,
        "data_completeness_pct": 100,
        "last_sync_at": "2026-08-03T12:00:00Z",
    }
    values.update(overrides)
    return values


def _history(**current_overrides: object) -> list[dict[str, object]]:
    return [_week(day) for day in range(1, 9)] + [
        _week(15, **current_overrides)
    ]


def test_baseline_helpers_use_median_and_interpolated_percentile() -> None:
    assert median_baseline([1, 2, 9, 10]) == 5.5
    assert percentile_baseline([1, 2, 9, 10], 0.75) == 9.25
    assert percentile_baseline([1, 2, 9, 10], 0.25) == 1.75


def test_triggered_rules_return_persistable_raw_evidence() -> None:
    cases = [
        (activity_decline, {"active_days": 2}, "active_days", "Activity below baseline"),
        (open_pr_aging, {"oldest_open_pr_days": 18}, "oldest_open_pr_days", "Open PR aging"),
        (review_latency, {"review_latency_days": 6}, "review_latency_days", "Review latency rising"),
        (merged_throughput, {"merged_count": 1}, "merged_count", "Merged throughput below baseline"),
        (inactivity, {"days_since_activity": 9}, "days_since_activity", "Inactivity exceeds baseline"),
        (
            contributor_resilience,
            {"active_contributors": 1},
            "active_contributors",
            "Contributor resilience below baseline",
        ),
    ]
    for rule, overrides, metric, title in cases:
        result = rule(_history(**overrides), baseline_window=8)

        assert result["value"] == overrides[metric]
        assert result["meets_minimum_data"] is True
        assert result["evidence"] is not None
        evidence = result["evidence"]
        assert evidence["title"] == title
        assert evidence["metric"] == metric
        assert evidence["current"] == overrides[metric]
        assert evidence["baseline"] is not None
        assert len(evidence["observations"]) == 9
        assert len(evidence["source_evidence_refs"]) == len(evidence["observations"])
        assert evidence["observations"][-1]["value"] == overrides[metric]

        # Evidence is JSON-persistable and contains only aggregate observations.
        json.dumps(evidence)
        evidence_text = json.dumps(evidence).lower()
        assert "identity" not in evidence_text
        assert "commit" not in evidence_text
        assert "addition" not in evidence_text
        assert "deletion" not in evidence_text


def test_baseline_uses_only_the_trailing_window_before_current() -> None:
    history = [
        _week(1, active_days=99),  # outside the requested window
        _week(2, active_days=4),
        _week(3, active_days=4),
        _week(4, active_days=4),
        _week(5, active_days=4),
        _week(6, active_days=4),
        _week(7, active_days=4),
        _week(8, active_days=4),
        _week(9, active_days=4),
        _week(15, active_days=1),
    ]

    result = activity_decline(history, baseline_window=8)

    assert result["baseline"] == 4
    assert result["value"] == 1
    assert result["evidence"]["observations"][0]["value"] == 4
    assert result["evidence"]["observations"][-1]["value"] == 1


def test_insufficient_data_is_silent_for_every_rule() -> None:
    history = [_week(1), _week(8, active_days=1, active_contributors=1)]

    results = evaluate_mvp_rules(history, baseline_window=8)

    assert set(results) == set(RULES)
    for result in results.values():
        assert result["meets_minimum_data"] is False
        assert result["evidence"] is None


def test_planned_pause_short_circuits_all_signals() -> None:
    history = {
        "planned_pause": True,
        "weeks": _history(
            active_days=0,
            days_since_activity=60,
            oldest_open_pr_days=60,
            review_latency_days=60,
            merged_count=0,
            active_contributors=0,
        ),
    }

    results = evaluate_mvp_rules(history)

    for result in results.values():
        assert result["meets_minimum_data"] is False
        assert result["evidence"] is None
        assert result.get("value") is None
        assert result.get("baseline") is None


def test_planned_pause_date_range_is_active_for_the_current_week() -> None:
    history = {
        "planned_pause": {"start": "2026-08-01", "until": "2026-08-20"},
        "weeks": _history(active_days=0),
    }

    result = activity_decline(history)

    # The latest week is 2026-06-15 in this fixture, so the date range is not
    # active yet and the rule is allowed to evaluate.
    assert result["meets_minimum_data"] is True

    history["weeks"][-1]["week_start"] = "2026-08-03"
    paused_result = activity_decline(history)
    assert paused_result["meets_minimum_data"] is False
    assert paused_result["evidence"] is None


def test_contributor_resilience_omits_values_below_aggregation_floor() -> None:
    history = _history(active_contributors=1, team_size=DEFAULT_AGGREGATION_FLOOR - 1)

    result = contributor_resilience(history)

    assert "value" not in result
    assert "baseline" not in result
    assert result["meets_minimum_data"] is False
    assert result["evidence"] is None
    assert "active_contributors" not in json.dumps(result)


def test_contributor_list_is_not_counted_or_returned() -> None:
    history = _history(team_size=5)
    for record in history:
        record.pop("active_contributors")
        record["contributors"] = [1, 2, 3]

    result = contributor_resilience(history)

    assert "value" in result
    assert result["value"] is None
    assert result["meets_minimum_data"] is False
    assert result["evidence"] is None
    assert "contributors" not in json.dumps(result)


def test_rules_do_not_mutate_input_history() -> None:
    history = _history(active_days=2, oldest_open_pr_days=18)
    original = deepcopy(history)

    evaluate_mvp_rules(history)

    assert history == original


def test_mapping_with_separate_current_metrics_is_supported() -> None:
    history = {
        "weeks": [_week(day) for day in range(1, 9)],
        "metrics": _week(15, active_days=1),
    }

    result = activity_decline(history)

    assert result["value"] == 1
    assert result["baseline"] == 6
    assert result["evidence"] is not None


def test_configured_floor_can_be_higher_without_masking_contributor_values() -> None:
    history = {"aggregation_floor": 6, "weeks": _history(team_size=5)}

    result = contributor_resilience(history)

    assert "value" not in result
    assert "baseline" not in result
    assert result["evidence"] is None
