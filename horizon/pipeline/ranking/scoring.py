"""T4.5 scoring: percentiles, bucket scores, overall scores and ranks.

Pure functions over one comparison group. Every intermediate value stays an
unrounded float; rounding is for display only and never happens before ranking.

A bucket the run excluded for a group (``RoleRubric.excluded_buckets``) has no
metric rows and is left out of that group's scores; its weight is split equally
over the role's other buckets (``RoleRubric.effective_weights``), so everyone in
the group is scored with the same weights.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from .metrics_code import MetricValue
from .rubric import RoleRubric, RubricRules

RANK_EPSILON = 1e-9
GROUP_TOO_SMALL = "group_too_small"


@dataclass(frozen=True)
class MetricScore:
    raw_value: float | None
    percentile: float | None
    group_size: int
    missing_reason: str | None


@dataclass(frozen=True)
class BucketScore:
    score: float | None
    metric_coverage: float


@dataclass(frozen=True)
class MemberScore:
    metrics: Mapping[str, MetricScore]
    buckets: Mapping[str, BucketScore]
    weights: Mapping[str, float]
    coverage: float
    overall_score: float | None
    status: str
    rank_in_group: int | None
    ranked_in_group: int | None


def _finite(value: float | None, label: str) -> float | None:
    if value is None:
        return None
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


def scored_metric_keys(role_rubric: RoleRubric, excluded: Iterable[str] = ()) -> set[str]:
    """The metric keys a member with these excluded buckets must have a row for.

    The kept buckets come from T4.1's ``RoleRubric.effective_weights``, the same
    rule the metric steps use to skip an excluded bucket.
    """

    kept = role_rubric.effective_weights(excluded)
    return {metric.key for bucket in role_rubric.buckets if bucket.key in kept for metric in bucket.metrics}


def percentiles(values: Mapping[str, float | None], direction: str) -> dict[str, float | None]:
    """Average-rank percentiles (0-100) among the non-NULL values.

    Ties share the mean of the ranks they occupy, raw values are compared
    exactly, and lower-is-better metrics are flipped. NULL stays NULL and is
    never ranked last. With fewer than two values every percentile is NULL.
    """

    present = [value for value in values.values() if value is not None]
    n = len(present)
    result: dict[str, float | None] = {}
    for key, value in values.items():
        if value is None or n < 2:
            result[key] = None
            continue
        below = sum(other < value for other in present)
        equal = sum(other == value for other in present)
        rank = 1.0 + below + (equal - 1) / 2.0
        percentile = 100.0 * (rank - 1.0) / (n - 1)
        result[key] = 100.0 - percentile if direction == "lower_is_better" else percentile
    return result


def competition_ranks(scores: Mapping[str, float]) -> dict[str, int]:
    """Standard competition ranks (1, 2, 2, 4); scores within 1e-9 tie."""

    return {
        key: 1 + sum(other > score + RANK_EPSILON for other in scores.values())
        for key, score in scores.items()
    }


def _append_reason(reason: str | None, extra: str) -> str:
    if not reason:
        return extra
    if extra in reason.split(";"):
        return reason
    return f"{reason};{extra}"


def score_group(
    members: Mapping[str, Mapping[str, MetricValue]],
    role_rubric: RoleRubric,
    rules: RubricRules,
    excluded: Iterable[str] = (),
) -> dict[str, MemberScore]:
    """Score every member of one comparison group.

    ``members`` maps a member key to its metric rows by metric key. Each member
    must have exactly the rubric's metrics outside the excluded buckets: a
    missing row means an upstream step did not run, which is not the same as a
    NULL value with a reason, so it is an error.
    """

    excluded = tuple(sorted(set(excluded)))
    weights = {key: weight / 100.0 for key, weight in role_rubric.effective_weights(excluded).items()}
    buckets = [bucket for bucket in role_rubric.buckets if bucket.key in weights]
    expected = scored_metric_keys(role_rubric, excluded)
    for member_key, rows in members.items():
        if set(rows) != expected:
            raise ValueError(
                f"member {member_key!r} metric rows {sorted(rows)} "
                f"do not match the rubric's {sorted(expected)}"
            )
        for metric_key, row in rows.items():
            if row.metric_key != metric_key:
                raise ValueError(f"{member_key}: row for {row.metric_key!r} filed as {metric_key!r}")
            _finite(row.raw_value, f"{member_key}.{metric_key}")

    metric_scores: dict[str, dict[str, MetricScore]] = {key: {} for key in members}
    for bucket in buckets:
        for metric in bucket.metrics:
            raw = {key: rows[metric.key].raw_value for key, rows in members.items()}
            group_size = sum(value is not None for value in raw.values())
            ranked = percentiles(raw, metric.direction)
            for key, value in raw.items():
                reason = members[key][metric.key].missing_reason
                if value is not None and group_size == 1:
                    reason = _append_reason(reason, GROUP_TOO_SMALL)
                metric_scores[key][metric.key] = MetricScore(
                    value, ranked[key], group_size, reason
                )

    bucket_scores: dict[str, dict[str, BucketScore]] = {}
    coverage: dict[str, float] = {}
    overall: dict[str, float | None] = {}
    status: dict[str, str] = {}
    for key in members:
        per_bucket: dict[str, BucketScore] = {}
        for bucket in buckets:
            available = [
                (metric.share / 100.0, metric_scores[key][metric.key].percentile)
                for metric in bucket.metrics
                if metric_scores[key][metric.key].percentile is not None
            ]
            share_sum = sum(share for share, _ in available)
            score = (
                sum(share * percentile for share, percentile in available) / share_sum
                if available else None
            )
            per_bucket[bucket.key] = BucketScore(score, share_sum)
        bucket_scores[key] = per_bucket
        coverage[key] = sum(weights[b] * value.metric_coverage for b, value in per_bucket.items())
        present = [(weights[b], value.score) for b, value in per_bucket.items() if value.score is not None]
        overall[key] = (
            sum(weight * score for weight, score in present) / sum(weight for weight, _ in present)
            if present else None
        )
        if len(members) < rules.min_group_size:
            status[key] = GROUP_TOO_SMALL
        elif coverage[key] < rules.min_coverage or overall[key] is None:
            status[key] = "insufficient_data"
        else:
            status[key] = "ranked"

    ranked_scores = {key: overall[key] for key in members if status[key] == "ranked"}
    ranks = competition_ranks(ranked_scores)
    result = {}
    for key in members:
        is_ranked = status[key] == "ranked"
        result[key] = MemberScore(
            metrics=metric_scores[key],
            buckets=bucket_scores[key],
            weights=weights,
            coverage=coverage[key],
            overall_score=overall[key] if is_ranked else None,
            status=status[key],
            rank_in_group=ranks[key] if is_ranked else None,
            ranked_in_group=len(ranked_scores) if is_ranked else None,
        )
    return result
