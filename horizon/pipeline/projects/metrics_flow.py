"""Pure engineering-flow metric calculations for T5.5.

Every function here takes plain Python objects and returns plain Python
objects. Nothing opens a database connection or calls Dagster, so the
definitions in the T5.5 spec can be unit tested on their own.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from statistics import median
from typing import Any
from zoneinfo import ZoneInfo

# Weeks are Monday 00:00 to the next Monday 00:00 in this time zone.
PROJECT_TIMEZONE = ZoneInfo("America/New_York")

# A review only counts when it is one of these states and not by the PR author.
COUNTING_REVIEW_STATES = frozenset({"APPROVED", "REQUEST_CHANGES", "COMMENT"})

# The metric_key values T5.5 owns in horizon_projects.project_metrics.
FLOW_METRIC_KEYS = (
    "prs_opened",
    "prs_merged",
    "open_prs_end_of_week",
    "median_open_pr_age_days",
    "median_time_to_first_review_hours",
    "median_time_to_merge_hours",
)

SECONDS_PER_HOUR = 3600
SECONDS_PER_DAY = 86400


@dataclass(frozen=True)
class Review:
    """One submitted review on a pull request."""

    reviewer_login: str
    state: str
    submitted_at: datetime
    reviewer_pk: str | None = None  # Authentik pk when the login resolves (T1.1)


@dataclass(frozen=True)
class PullRequest:
    """One pull request in a project repository (a gitea_pull_requests row)."""

    number: int
    author_login: str
    created_at: datetime
    merged_at: datetime | None
    closed_at: datetime | None
    reviews: tuple[Review, ...] = ()


@dataclass(frozen=True)
class Week:
    """One reporting week: [start, end), where end is cut off at as_of."""

    week_start: date
    start: datetime
    end: datetime
    partial: bool


@dataclass(frozen=True)
class FlowMetric:
    """One project_metrics row, without the run and project keys."""

    week_start: date
    metric_key: str
    value: float | None
    missing_reason: str | None = None
    evidence: dict[str, Any] = field(default_factory=dict)


def monday_of(moment: datetime) -> date:
    """The Monday (in New York time) of the week that contains ``moment``."""
    local_day = moment.astimezone(PROJECT_TIMEZONE).date()
    return local_day - timedelta(days=local_day.weekday())


def local_midnight(day: date) -> datetime:
    """Midnight at the start of ``day`` in New York time, expressed in UTC.

    Python subtracts two datetimes that share a tzinfo by wall clock, which is
    an hour off across a daylight saving change. Keeping boundaries in UTC
    makes every subtraction and comparison use real elapsed time.
    """
    return datetime(day.year, day.month, day.day, tzinfo=PROJECT_TIMEZONE).astimezone(timezone.utc)


def weeks_between(window_start: date, as_of: datetime) -> list[Week]:
    """Every week from the one containing window_start to the one containing as_of.

    Building each boundary from a calendar date (instead of adding 7 days of
    seconds) keeps every week starting at local midnight across daylight saving
    changes.
    """
    first_monday = window_start - timedelta(days=window_start.weekday())
    last_monday = monday_of(as_of)
    weeks: list[Week] = []
    monday = first_monday
    while monday <= last_monday:
        start = local_midnight(monday)
        next_monday = local_midnight(monday + timedelta(days=7))
        end = min(next_monday, as_of)
        weeks.append(Week(week_start=monday, start=start, end=end, partial=as_of < next_monday))
        monday += timedelta(days=7)
    return weeks


def elapsed_seconds(earlier: datetime, later: datetime) -> float:
    """Real seconds between two aware datetimes, even across a clock change."""
    return (later.astimezone(timezone.utc) - earlier.astimezone(timezone.utc)).total_seconds()


def hours_between(earlier: datetime, later: datetime) -> float:
    return elapsed_seconds(earlier, later) / SECONDS_PER_HOUR


def days_between(earlier: datetime, later: datetime) -> float:
    return elapsed_seconds(earlier, later) / SECONDS_PER_DAY


def counting_reviews(pr: PullRequest) -> list[Review]:
    """Reviews that count: a counted state, by someone other than the author."""
    author = pr.author_login.casefold()
    return [
        review
        for review in pr.reviews
        if review.state in COUNTING_REVIEW_STATES and review.reviewer_login.casefold() != author
    ]


def first_review_at(pr: PullRequest) -> datetime | None:
    """Earliest submitted_at among the counting reviews."""
    return min((review.submitted_at for review in counting_reviews(pr)), default=None)


def prs_opened(prs: list[PullRequest], start: datetime, end: datetime) -> int:
    """Count PRs created in [start, end)."""
    return sum(1 for pr in prs if start <= pr.created_at < end)


def prs_merged(prs: list[PullRequest], start: datetime, end: datetime) -> int:
    """Count PRs merged in [start, end)."""
    return sum(1 for pr in prs if pr.merged_at is not None and start <= pr.merged_at < end)


def open_prs_at(prs: list[PullRequest], moment: datetime) -> list[PullRequest]:
    """PRs created before ``moment`` and not closed yet at ``moment`` (the set O(w))."""
    return [
        pr
        for pr in prs
        if pr.created_at < moment and (pr.closed_at is None or pr.closed_at >= moment)
    ]


def median_open_pr_age_days(prs: list[PullRequest], week: Week) -> FlowMetric:
    open_prs = open_prs_at(prs, week.end)
    if not open_prs:
        return FlowMetric(week.week_start, "median_open_pr_age_days", None, "no_open_prs")
    ages = [days_between(pr.created_at, week.end) for pr in open_prs]
    return FlowMetric(week.week_start, "median_open_pr_age_days", median(ages))


def median_time_to_first_review_hours(
    prs: list[PullRequest], week: Week, as_of: datetime
) -> FlowMetric:
    """Median wait for a first review, for PRs opened this week.

    A PR still waiting at as_of counts with its wait so far. A PR that was closed
    or merged without a review is left out (T5.6 reports those).
    """
    hours: list[float] = []
    reviewed = waiting = excluded = 0
    for pr in prs:
        if not week.start <= pr.created_at < week.end:
            continue
        first_review = first_review_at(pr)
        still_open = pr.closed_at is None or pr.closed_at > as_of
        if first_review is not None and first_review <= as_of:
            hours.append(hours_between(pr.created_at, first_review))
            reviewed += 1
        elif still_open:
            hours.append(hours_between(pr.created_at, as_of))
            waiting += 1
        else:
            excluded += 1
    evidence = {"reviewed": reviewed, "waiting": waiting, "excluded": excluded}
    if not hours:
        return FlowMetric(
            week.week_start, "median_time_to_first_review_hours", None, "no_reviews", evidence
        )
    return FlowMetric(
        week.week_start, "median_time_to_first_review_hours", median(hours), None, evidence
    )


def median_time_to_merge_hours(prs: list[PullRequest], week: Week) -> FlowMetric:
    hours = [
        hours_between(pr.created_at, pr.merged_at)
        for pr in prs
        if pr.merged_at is not None and week.start <= pr.merged_at < week.end
    ]
    if not hours:
        return FlowMetric(week.week_start, "median_time_to_merge_hours", None, "no_merged_prs")
    return FlowMetric(week.week_start, "median_time_to_merge_hours", median(hours))


def flow_metrics_for_week(prs: list[PullRequest], week: Week, as_of: datetime) -> list[FlowMetric]:
    """All six T5.5 metrics for one week."""
    metrics = [
        FlowMetric(week.week_start, "prs_opened", float(prs_opened(prs, week.start, week.end))),
        FlowMetric(week.week_start, "prs_merged", float(prs_merged(prs, week.start, week.end))),
        FlowMetric(
            week.week_start, "open_prs_end_of_week", float(len(open_prs_at(prs, week.end)))
        ),
        median_open_pr_age_days(prs, week),
        median_time_to_first_review_hours(prs, week, as_of),
        median_time_to_merge_hours(prs, week),
    ]
    return mark_partial_week(metrics, week)


def mark_partial_week(metrics: list[FlowMetric], week: Week) -> list[FlowMetric]:
    """Add evidence.partial_week = true to every metric of the current, unfinished week."""
    if not week.partial:
        return metrics
    return [
        FlowMetric(m.week_start, m.metric_key, m.value, m.missing_reason, {**m.evidence, "partial_week": True})
        for m in metrics
    ]


def project_flow_metrics(
    prs: list[PullRequest], window_start: date, as_of: datetime
) -> list[FlowMetric]:
    """Every week's flow metrics for one project, recomputed from scratch each run."""
    rows: list[FlowMetric] = []
    for week in weeks_between(window_start, as_of):
        rows.extend(flow_metrics_for_week(prs, week, as_of))
    return rows
