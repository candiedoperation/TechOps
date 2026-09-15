"""Pure, aggregate-only MVP project health rules.

The rule functions in this module deliberately accept plain mappings (or
small objects with equivalent attributes).  They do not know about MongoDB,
Gitea, authentication, or snapshot persistence.  A caller can therefore
replay the same input and persist the returned evidence alongside an
immutable weekly snapshot.

Input shape
===========

``project_history`` may be either a sequence of weekly aggregate mappings or
a mapping containing ``weeks``/``history`` and, optionally, a separate
``current``/``metrics`` mapping.  A weekly mapping may contain these
aggregate fields directly or under ``metrics``::

    {
        "week_start": "2026-07-27",
        "active_days": 5,
        "days_since_activity": 1,
        "open_prs": 2,
        "oldest_open_pr_days": 4,
        "review_latency_days": 2.5,
        "merged_count": 3,
        "active_contributors": 4,  # only when team_size is above the floor
        "team_size": 6,
    }

The latest weekly mapping is the current value; the preceding
``baseline_window`` mappings are the trailing baseline window.  If a
container supplies ``current`` or ``metrics``, that mapping is used as the
current week and the container's ``weeks``/``history`` are the prior weeks.

Each normal result has this shape::

    {
        "value": current aggregate value or None,
        "baseline": trailing median/percentile or None,
        "window": baseline_window,
        "meets_minimum_data": bool,
        "evidence": persisted evidence mapping or None,
    }

``evidence`` is non-null only for a triggered rule.  It contains the raw
aggregate observations used by the comparison and source references, so a
warning can be inspected later.  It never copies arbitrary input fields;
in particular, contributor lists, identities, commit counts, additions, and
deletions are not read or returned.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime
from math import ceil, isfinite
from numbers import Real
from typing import Any, Callable, NamedTuple


DEFAULT_BASELINE_WINDOW = 8
DEFAULT_AGGREGATION_FLOOR = 3
DEFAULT_MINIMUM_BASELINE_OBSERVATIONS = 4

# Thresholds are intentionally conservative and visible.  They are rule-set
# policy, not mutable runtime state.  A future rule-set version can change
# these constants without changing historical snapshots.
ACTIVITY_DECLINE_RATIO = 0.75
MERGED_THROUGHPUT_RATIO = 0.75
CONTRIBUTOR_RESILIENCE_RATIO = 0.75

OPEN_PR_AGING_PERCENTILE = 0.75
REVIEW_LATENCY_PERCENTILE = 0.75
INACTIVITY_PERCENTILE = 0.75
MERGED_THROUGHPUT_PERCENTILE = 0.25
CONTRIBUTOR_RESILIENCE_PERCENTILE = 0.25

OPEN_PR_AGING_MIN_DAYS = 7
OPEN_PR_AGING_MIN_INCREASE_DAYS = 3
REVIEW_LATENCY_MIN_DAYS = 3
REVIEW_LATENCY_MIN_INCREASE_DAYS = 2
INACTIVITY_MIN_DAYS = 7
INACTIVITY_MIN_INCREASE_DAYS = 3


class _PreparedMetric(NamedTuple):
    """Internal metric extraction result; never exposed directly."""

    current: float | int | None
    baseline_values: tuple[float | int, ...]
    baseline_records: tuple[Mapping[str, Any] | Any, ...]
    current_record: Mapping[str, Any] | Any | None
    meets_minimum_data: bool


def _field(value: Any, name: str, default: Any = None) -> Any:
    """Read one field from a mapping or a small dataclass-like object."""

    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _first_field(value: Any, names: Iterable[str], default: Any = None) -> Any:
    for name in names:
        found = _field(value, name, None)
        if found is not None:
            return found
    return default


def _is_record(value: Any) -> bool:
    return isinstance(value, Mapping) or hasattr(value, "__dict__")


def _records_from_sequence(value: Any) -> list[Any]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [item for item in value if _is_record(item)]
    return []


def _same_week(left: Any, right: Any) -> bool:
    left_week = _week_label(left)
    right_week = _week_label(right)
    return left_week is not None and left_week == right_week


def _history_records(project_history: Any) -> tuple[list[Any], Any]:
    """Return chronologically ordered records and the container context."""

    if isinstance(project_history, Sequence) and not isinstance(
        project_history, (str, bytes, bytearray)
    ):
        records = _records_from_sequence(project_history)
        context: Any = {}
    else:
        context = project_history if _is_record(project_history) else {}
        current = _first_field(
            project_history,
            ("current", "latest", "current_week", "current_snapshot", "metrics"),
        )
        history = _first_field(
            project_history,
            ("weeks", "history", "snapshots", "weekly_snapshots", "observations"),
            [],
        )
        records = _records_from_sequence(history)
        if current is not None and _is_record(current):
            matching_index = next(
                (index for index, record in enumerate(records) if _same_week(record, current)),
                None,
            )
            if matching_index is not None:
                records[matching_index] = current
            else:
                records.append(current)

        # A single weekly mapping is also a valid input.  Do not mistake a
        # nested review-history list for a metric history.
        if not records and _is_record(project_history):
            records = [project_history]

    if len(records) > 1 and all(_week_label(item) is not None for item in records):
        records.sort(key=lambda item: _week_label(item) or "")
    return records, context


def _week_label(record: Any) -> str | None:
    value = _first_field(
        record,
        ("week_start", "snapshot_week_start", "week", "date", "snapshot_date"),
    )
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        return value
    return str(value)


def _metric_value(record: Any, metric: str) -> float | int | None:
    """Read a scalar aggregate metric without inspecting individual data."""

    aliases: dict[str, tuple[str, ...]] = {
        "active_days": ("active_days", "activity_days", "activity"),
        "days_since_activity": (
            "days_since_activity",
            "days_since_last_activity",
            "inactivity_days",
        ),
        "oldest_open_pr_days": (
            "oldest_open_pr_days",
            "oldest_open_pr_age_days",
            "oldest_pr_days",
        ),
        "review_latency_days": (
            "review_latency_days",
            "review_latency",
            "reviewLatency",
        ),
        "merged_count": ("merged_count", "merged_pr_count", "mergedCount"),
        "active_contributors": (
            "active_contributors",
            "active_contributor_count",
            "contributor_count",
            "contributors_count",
        ),
    }
    names = aliases.get(metric, (metric,))

    direct = _first_field(record, names)
    nested = _field(record, "metrics", None)
    if direct is None and nested is not None:
        direct = _first_field(nested, names)

    # A list/set of contributors is deliberately not converted to a count.
    # Doing so would make this module depend on individual-level input shape.
    if isinstance(direct, (list, tuple, set, frozenset, dict)):
        return None
    if isinstance(direct, bool) or not isinstance(direct, Real):
        return None
    number = float(direct) if isinstance(direct, float) else int(direct)
    if not isfinite(float(number)) or number < 0:
        return None
    return number


def _context_metric(context: Any, record: Any, names: Iterable[str]) -> Any:
    value = _first_field(record, names, None)
    if value is not None:
        return value
    nested = _field(record, "metrics", None)
    value = _first_field(nested, names, None) if nested is not None else None
    if value is not None:
        return value
    return _first_field(context, names, None)


def _team_size(context: Any, record: Any) -> int | None:
    value = _context_metric(
        context,
        record,
        ("team_size", "teamSize", "team_size_at_snapshot"),
    )
    if isinstance(value, bool) or not isinstance(value, Real):
        return None
    number = float(value)
    if not isfinite(number) or number < 0 or not number.is_integer():
        return None
    return int(number)


def _normalise_window(baseline_window: int) -> int:
    if isinstance(baseline_window, bool) or not isinstance(baseline_window, int):
        raise TypeError("baseline_window must be a positive integer")
    if baseline_window <= 0:
        raise ValueError("baseline_window must be a positive integer")
    return baseline_window


def _minimum_observations(
    project_history: Any,
    baseline_window: int,
    override: int | None,
) -> int:
    configured = override
    if configured is None:
        configured = _first_field(
            project_history,
            ("minimum_baseline_observations", "min_baseline_observations"),
            None,
        )
    if configured is None:
        configured = min(
            baseline_window,
            max(DEFAULT_MINIMUM_BASELINE_OBSERVATIONS, ceil(baseline_window / 2)),
        )
    if isinstance(configured, bool) or not isinstance(configured, int) or configured <= 0:
        raise ValueError("minimum data volume must be a positive integer")
    return configured


def median_baseline(values: Iterable[Real]) -> float | int:
    """Return the median of finite, non-negative scalar observations."""

    clean = _clean_values(values)
    if not clean:
        raise ValueError("at least one numeric observation is required")
    ordered = sorted(clean)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def percentile_baseline(values: Iterable[Real], percentile: float) -> float | int:
    """Return a linearly interpolated percentile of finite observations."""

    if isinstance(percentile, bool) or not isinstance(percentile, Real):
        raise TypeError("percentile must be a number between 0 and 1")
    percentile_value = float(percentile)
    if not 0 <= percentile_value <= 1:
        raise ValueError("percentile must be between 0 and 1")

    clean = sorted(_clean_values(values))
    if not clean:
        raise ValueError("at least one numeric observation is required")
    if len(clean) == 1:
        return clean[0]
    position = (len(clean) - 1) * percentile_value
    lower = int(position)
    upper = min(lower + 1, len(clean) - 1)
    fraction = position - lower
    return clean[lower] + (clean[upper] - clean[lower]) * fraction


def _clean_values(values: Iterable[Real]) -> list[float | int]:
    clean: list[float | int] = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, Real):
            continue
        number = float(value)
        if not isfinite(number) or number < 0:
            continue
        clean.append(float(value) if isinstance(value, float) else int(value))
    return clean


def _pause_state(project_history: Any, current_record: Any | None) -> str | None:
    """Return a lifecycle short-circuit before any metric is evaluated."""

    candidates = [
        current_record,
        _field(current_record, "boundary", None),
        project_history,
        _field(project_history, "boundary", None),
    ]
    lifecycle_names = ("lifecycle_state", "lifecycle", "state", "status")
    for candidate in candidates:
        lifecycle = _first_field(candidate, lifecycle_names, None)
        if isinstance(lifecycle, str):
            normalised = lifecycle.strip().lower().replace(" ", "_")
            if normalised in {"paused", "planned_pause", "planned_paused", "pause"}:
                return "planned_pause"
            if normalised in {"archived", "excluded"}:
                return "excluded"

    pause_values = [
        _first_field(current_record, ("planned_pause", "pause"), None),
        _first_field(project_history, ("planned_pause", "pause"), None),
    ]
    current_week = _week_label(current_record) or _week_label(project_history)
    current_date = _parse_date(current_week)
    for pause in pause_values:
        if pause is None or pause is False:
            continue
        if pause is True:
            return "planned_pause"
        if isinstance(pause, str):
            # A string pause marker is an explicit lifecycle declaration.
            if pause.strip().lower() in {"paused", "planned_pause", "true", "yes"}:
                return "planned_pause"
            continue
        if not isinstance(pause, Mapping):
            continue
        if pause.get("active") is True or pause.get("is_active") is True:
            return "planned_pause"
        start = _parse_date(
            _first_field(pause, ("start", "from", "effective_from", "starts_at"), None)
        )
        end = _parse_date(
            _first_field(pause, ("end", "through", "until", "effective_to", "ends_at"), None)
        )
        if current_date is not None and (start is None or current_date >= start) and (
            end is None or current_date <= end
        ):
            return "planned_pause"
    return None


def _parse_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None


def _empty_result(
    baseline_window: int,
    *,
    value: float | int | None = None,
    baseline: float | int | None = None,
    omit_values: bool = False,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "window": baseline_window,
        "meets_minimum_data": False,
        "evidence": None,
    }
    # Contributor privacy is stricter than the general result contract: when
    # aggregation is not allowed, the value and baseline fields do not exist.
    if not omit_values:
        result["value"] = value
        result["baseline"] = baseline
    return result


def _prepare_metric(
    project_history: Any,
    baseline_window: int,
    metric: str,
    *,
    minimum_data_volume: int | None = None,
    require_aggregation_floor: int | None = None,
) -> _PreparedMetric | None:
    records, context = _history_records(project_history)
    if not records:
        return _PreparedMetric(None, (), (), None, False)
    current_record = records[-1]

    if require_aggregation_floor is not None:
        # Check the floor before reading/returning contributor values.  The
        # scalar is read only after this gate succeeds.
        current_team_size = _team_size(context, current_record)
        if current_team_size is None or current_team_size < require_aggregation_floor:
            return None

    current_value = _metric_value(current_record, metric)

    historical_records = records[:-1][-baseline_window:]
    baseline_records: list[Any] = []
    baseline_values: list[float | int] = []
    for record in historical_records:
        if require_aggregation_floor is not None:
            team_size = _team_size(context, record)
            if team_size is None or team_size < require_aggregation_floor:
                continue
        value = _metric_value(record, metric)
        if value is not None:
            baseline_records.append(record)
            baseline_values.append(value)

    minimum = _minimum_observations(project_history, baseline_window, minimum_data_volume)
    enough = current_value is not None and len(baseline_values) >= minimum
    return _PreparedMetric(
        current_value,
        tuple(baseline_values),
        tuple(baseline_records),
        current_record,
        enough,
    )


def _source_ref(record: Any) -> dict[str, str | int] | None:
    """Build a safe, aggregate-only source reference."""

    reference = _first_field(record, ("source_ref", "snapshot_id", "repo_snapshot_id"), None)
    if isinstance(reference, (str, int)) and not isinstance(reference, bool):
        return {"source": "project_history", "ref": reference}
    return {"source": "project_history"}


def _observation(record: Any, metric: str, value: float | int) -> dict[str, Any]:
    observation: dict[str, Any] = {
        "week_start": _week_label(record),
        "metric": metric,
        "value": value,
        "source_ref": _source_ref(record),
    }
    completeness = _first_field(
        record,
        ("data_completeness_pct", "data_completeness", "completeness_pct"),
        None,
    )
    if isinstance(completeness, Real) and not isinstance(completeness, bool):
        completeness_number = float(completeness)
        if isfinite(completeness_number) and 0 <= completeness_number <= 100:
            observation["data_completeness_pct"] = completeness_number
    sync_time = _first_field(record, ("last_sync_at", "synced_at"), None)
    if isinstance(sync_time, (str, int, float)) and not isinstance(sync_time, bool):
        observation["last_sync_at"] = sync_time
    return observation


def _evidence(
    *,
    rule_id: str,
    icon: str,
    title: str,
    metric: str,
    unit: str,
    current: float | int,
    baseline: float | int,
    baseline_window: int,
    baseline_records: Sequence[Any],
    baseline_values: Sequence[float | int],
    current_record: Any,
    statistic: str,
    trigger_operator: str,
    trigger_threshold: float | int,
) -> dict[str, Any]:
    observations = [
        _observation(record, metric, value)
        for record, value in zip(baseline_records, baseline_values)
    ]
    observations.append(_observation(current_record, metric, current))
    return {
        "type": rule_id,
        "icon": icon,
        "title": title,
        "metric": metric,
        "unit": unit,
        "current": current,
        "baseline": baseline,
        "window": f"trailing {baseline_window} weeks",
        "baseline_statistic": statistic,
        "trigger": {
            "operator": trigger_operator,
            "threshold": trigger_threshold,
        },
        "observations": observations,
        "source_evidence_refs": [item["source_ref"] for item in observations],
    }


def _rule_result(
    prepared: _PreparedMetric,
    baseline_window: int,
    baseline: float | int,
    *,
    trigger: bool,
    evidence_args: dict[str, Any],
) -> dict[str, Any]:
    return {
        "value": prepared.current,
        "baseline": baseline,
        "window": baseline_window,
        "meets_minimum_data": True,
        "evidence": _evidence(**evidence_args) if trigger else None,
    }


def _suppressed_or_none(project_history: Any, baseline_window: int) -> dict[str, Any] | None:
    records, _ = _history_records(project_history)
    current = records[-1] if records else None
    state = _pause_state(project_history, current)
    if state is not None:
        return _empty_result(baseline_window)
    return None


def activity_decline(
    project_history: Any,
    baseline_window: int = DEFAULT_BASELINE_WINDOW,
    *,
    minimum_data_volume: int | None = None,
) -> dict[str, Any]:
    """Flag a material drop in aggregate active days versus the median."""

    window = _normalise_window(baseline_window)
    suppressed = _suppressed_or_none(project_history, window)
    if suppressed is not None:
        return suppressed
    prepared = _prepare_metric(
        project_history,
        window,
        "active_days",
        minimum_data_volume=minimum_data_volume,
    )
    if prepared is None or not prepared.meets_minimum_data:
        return _empty_result(
            window,
            value=prepared.current if prepared is not None else None,
        )
    baseline = median_baseline(prepared.baseline_values)
    threshold = min(baseline * ACTIVITY_DECLINE_RATIO, baseline - 1)
    trigger = prepared.current <= threshold
    return _rule_result(
        prepared,
        window,
        baseline,
        trigger=trigger,
        evidence_args={
            "rule_id": "activity_decline",
            "icon": "activity",
            "title": "Activity below baseline",
            "metric": "active_days",
            "unit": "days/week",
            "current": prepared.current,
            "baseline": baseline,
            "baseline_window": window,
            "baseline_records": prepared.baseline_records,
            "baseline_values": prepared.baseline_values,
            "current_record": prepared.current_record,
            "statistic": "median",
            "trigger_operator": "<=",
            "trigger_threshold": threshold,
        },
    )


def open_pr_aging(
    project_history: Any,
    baseline_window: int = DEFAULT_BASELINE_WINDOW,
    *,
    minimum_data_volume: int | None = None,
) -> dict[str, Any]:
    """Flag an unusually old open pull request aggregate."""

    window = _normalise_window(baseline_window)
    suppressed = _suppressed_or_none(project_history, window)
    if suppressed is not None:
        return suppressed
    prepared = _prepare_metric(
        project_history,
        window,
        "oldest_open_pr_days",
        minimum_data_volume=minimum_data_volume,
    )
    if prepared is None or not prepared.meets_minimum_data:
        return _empty_result(
            window,
            value=prepared.current if prepared is not None else None,
        )
    baseline = percentile_baseline(prepared.baseline_values, OPEN_PR_AGING_PERCENTILE)
    threshold = max(
        OPEN_PR_AGING_MIN_DAYS,
        baseline + OPEN_PR_AGING_MIN_INCREASE_DAYS,
        baseline * 1.5,
    )
    trigger = prepared.current >= threshold
    return _rule_result(
        prepared,
        window,
        baseline,
        trigger=trigger,
        evidence_args={
            "rule_id": "open_pr_aging",
            "icon": "pull",
            "title": "Open PR aging",
            "metric": "oldest_open_pr_days",
            "unit": "days",
            "current": prepared.current,
            "baseline": baseline,
            "baseline_window": window,
            "baseline_records": prepared.baseline_records,
            "baseline_values": prepared.baseline_values,
            "current_record": prepared.current_record,
            "statistic": "75th_percentile",
            "trigger_operator": ">=",
            "trigger_threshold": threshold,
        },
    )


def review_latency(
    project_history: Any,
    baseline_window: int = DEFAULT_BASELINE_WINDOW,
    *,
    minimum_data_volume: int | None = None,
) -> dict[str, Any]:
    """Flag unusually slow aggregate pull-request review latency."""

    window = _normalise_window(baseline_window)
    suppressed = _suppressed_or_none(project_history, window)
    if suppressed is not None:
        return suppressed
    prepared = _prepare_metric(
        project_history,
        window,
        "review_latency_days",
        minimum_data_volume=minimum_data_volume,
    )
    if prepared is None or not prepared.meets_minimum_data:
        return _empty_result(
            window,
            value=prepared.current if prepared is not None else None,
        )
    baseline = percentile_baseline(prepared.baseline_values, REVIEW_LATENCY_PERCENTILE)
    threshold = max(
        REVIEW_LATENCY_MIN_DAYS,
        baseline + REVIEW_LATENCY_MIN_INCREASE_DAYS,
        baseline * 1.5,
    )
    trigger = prepared.current >= threshold
    return _rule_result(
        prepared,
        window,
        baseline,
        trigger=trigger,
        evidence_args={
            "rule_id": "review_latency",
            "icon": "pull",
            "title": "Review latency rising",
            "metric": "review_latency_days",
            "unit": "days",
            "current": prepared.current,
            "baseline": baseline,
            "baseline_window": window,
            "baseline_records": prepared.baseline_records,
            "baseline_values": prepared.baseline_values,
            "current_record": prepared.current_record,
            "statistic": "75th_percentile",
            "trigger_operator": ">=",
            "trigger_threshold": threshold,
        },
    )


def merged_throughput(
    project_history: Any,
    baseline_window: int = DEFAULT_BASELINE_WINDOW,
    *,
    minimum_data_volume: int | None = None,
) -> dict[str, Any]:
    """Flag a material drop in aggregate merged pull-request throughput."""

    window = _normalise_window(baseline_window)
    suppressed = _suppressed_or_none(project_history, window)
    if suppressed is not None:
        return suppressed
    prepared = _prepare_metric(
        project_history,
        window,
        "merged_count",
        minimum_data_volume=minimum_data_volume,
    )
    if prepared is None or not prepared.meets_minimum_data:
        return _empty_result(
            window,
            value=prepared.current if prepared is not None else None,
        )
    baseline = percentile_baseline(
        prepared.baseline_values,
        MERGED_THROUGHPUT_PERCENTILE,
    )
    threshold = min(baseline * MERGED_THROUGHPUT_RATIO, baseline - 1)
    trigger = prepared.current <= threshold
    return _rule_result(
        prepared,
        window,
        baseline,
        trigger=trigger,
        evidence_args={
            "rule_id": "merged_throughput",
            "icon": "activity",
            "title": "Merged throughput below baseline",
            "metric": "merged_count",
            "unit": "merged PRs/week",
            "current": prepared.current,
            "baseline": baseline,
            "baseline_window": window,
            "baseline_records": prepared.baseline_records,
            "baseline_values": prepared.baseline_values,
            "current_record": prepared.current_record,
            "statistic": "25th_percentile",
            "trigger_operator": "<=",
            "trigger_threshold": threshold,
        },
    )


def inactivity(
    project_history: Any,
    baseline_window: int = DEFAULT_BASELINE_WINDOW,
    *,
    minimum_data_volume: int | None = None,
) -> dict[str, Any]:
    """Flag a current inactivity gap that exceeds the trailing upper tail."""

    window = _normalise_window(baseline_window)
    suppressed = _suppressed_or_none(project_history, window)
    if suppressed is not None:
        return suppressed
    prepared = _prepare_metric(
        project_history,
        window,
        "days_since_activity",
        minimum_data_volume=minimum_data_volume,
    )
    if prepared is None or not prepared.meets_minimum_data:
        return _empty_result(
            window,
            value=prepared.current if prepared is not None else None,
        )
    baseline = percentile_baseline(prepared.baseline_values, INACTIVITY_PERCENTILE)
    threshold = max(
        INACTIVITY_MIN_DAYS,
        baseline + INACTIVITY_MIN_INCREASE_DAYS,
        baseline * 1.5,
    )
    trigger = prepared.current >= threshold
    return _rule_result(
        prepared,
        window,
        baseline,
        trigger=trigger,
        evidence_args={
            "rule_id": "inactivity",
            "icon": "activity",
            "title": "Inactivity exceeds baseline",
            "metric": "days_since_activity",
            "unit": "days",
            "current": prepared.current,
            "baseline": baseline,
            "baseline_window": window,
            "baseline_records": prepared.baseline_records,
            "baseline_values": prepared.baseline_values,
            "current_record": prepared.current_record,
            "statistic": "75th_percentile",
            "trigger_operator": ">=",
            "trigger_threshold": threshold,
        },
    )


def contributor_resilience(
    project_history: Any,
    baseline_window: int = DEFAULT_BASELINE_WINDOW,
    *,
    aggregation_floor: int | None = None,
    minimum_data_volume: int | None = None,
) -> dict[str, Any]:
    """Flag a drop in aggregate contributors only above the privacy floor.

    ``active_contributors`` is never inferred from a list.  If the current
    team size is unknown or below ``aggregation_floor``, this function omits
    both ``value`` and ``baseline`` from its result entirely.
    """

    window = _normalise_window(baseline_window)
    suppressed = _suppressed_or_none(project_history, window)
    if suppressed is not None:
        return _empty_result(window, omit_values=True)

    floor = aggregation_floor
    if floor is None:
        configured_floor = _first_field(
            project_history,
            ("aggregation_floor", "minimum_team_size_for_aggregation"),
            DEFAULT_AGGREGATION_FLOOR,
        )
        floor = configured_floor
    if isinstance(floor, bool) or not isinstance(floor, int) or floor <= 0:
        raise ValueError("aggregation_floor must be a positive integer")

    prepared = _prepare_metric(
        project_history,
        window,
        "active_contributors",
        minimum_data_volume=minimum_data_volume,
        require_aggregation_floor=floor,
    )
    if prepared is None:
        return _empty_result(window, omit_values=True)
    if not prepared.meets_minimum_data:
        return _empty_result(
            window,
            value=prepared.current,
            omit_values=False,
        )
    baseline = percentile_baseline(
        prepared.baseline_values,
        CONTRIBUTOR_RESILIENCE_PERCENTILE,
    )
    threshold = min(baseline * CONTRIBUTOR_RESILIENCE_RATIO, baseline - 1)
    trigger = prepared.current <= threshold
    return _rule_result(
        prepared,
        window,
        baseline,
        trigger=trigger,
        evidence_args={
            "rule_id": "contributor_resilience",
            "icon": "users",
            "title": "Contributor resilience below baseline",
            "metric": "active_contributors",
            "unit": "active contributors",
            "current": prepared.current,
            "baseline": baseline,
            "baseline_window": window,
            "baseline_records": prepared.baseline_records,
            "baseline_values": prepared.baseline_values,
            "current_record": prepared.current_record,
            "statistic": "25th_percentile",
            "trigger_operator": "<=",
            "trigger_threshold": threshold,
        },
    )


RULES: dict[str, Callable[..., dict[str, Any]]] = {
    "activity_decline": activity_decline,
    "open_pr_aging": open_pr_aging,
    "review_latency": review_latency,
    "merged_throughput": merged_throughput,
    "inactivity": inactivity,
    "contributor_resilience": contributor_resilience,
}


def evaluate_mvp_rules(
    project_history: Any,
    baseline_window: int = DEFAULT_BASELINE_WINDOW,
    *,
    aggregation_floor: int | None = None,
    minimum_data_volume: int | None = None,
) -> dict[str, dict[str, Any]]:
    """Evaluate all MVP rules without combining them into a project status.

    Deprecated as the default production signal source: ``run_weekly_snapshot_job``
    now prefers ``backend.signal_llm``'s LLM-judged weekly signal when LLM
    enrichment is configured, and only falls back to this deterministic
    trailing-baseline engine when it isn't (local/demo mode, or an LLM
    outage). Kept because ``backend.seed``'s local fixtures and this
    module's own test suite depend on it requiring no API key.
    """

    return {
        "activity_decline": activity_decline(
            project_history,
            baseline_window,
            minimum_data_volume=minimum_data_volume,
        ),
        "open_pr_aging": open_pr_aging(
            project_history,
            baseline_window,
            minimum_data_volume=minimum_data_volume,
        ),
        "review_latency": review_latency(
            project_history,
            baseline_window,
            minimum_data_volume=minimum_data_volume,
        ),
        "merged_throughput": merged_throughput(
            project_history,
            baseline_window,
            minimum_data_volume=minimum_data_volume,
        ),
        "inactivity": inactivity(
            project_history,
            baseline_window,
            minimum_data_volume=minimum_data_volume,
        ),
        "contributor_resilience": contributor_resilience(
            project_history,
            baseline_window,
            aggregation_floor=aggregation_floor,
            minimum_data_volume=minimum_data_volume,
        ),
    }


# Common spelling variants make the small module easier to consume while the
# rule IDs above remain stable for persisted warnings.
activity_decline_rule = activity_decline
open_pr_aging_rule = open_pr_aging
review_latency_rule = review_latency
merged_throughput_rule = merged_throughput
inactivity_rule = inactivity
contributor_resilience_rule = contributor_resilience


__all__ = [
    "DEFAULT_AGGREGATION_FLOOR",
    "DEFAULT_BASELINE_WINDOW",
    "DEFAULT_MINIMUM_BASELINE_OBSERVATIONS",
    "RULES",
    "activity_decline",
    "activity_decline_rule",
    "contributor_resilience",
    "contributor_resilience_rule",
    "evaluate_mvp_rules",
    "inactivity",
    "inactivity_rule",
    "median_baseline",
    "merged_throughput",
    "merged_throughput_rule",
    "open_pr_aging",
    "open_pr_aging_rule",
    "percentile_baseline",
    "review_latency",
    "review_latency_rule",
]
