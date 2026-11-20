"""Pure review-quality metric calculations for T5.6.

These describe how code review works on a team, per project per week. They use
the same weeks and the same "counting review" rule as T5.5 (metrics_flow.py):
APPROVED, REQUEST_CHANGES or COMMENT, by someone other than the PR author.
"""

from __future__ import annotations

from datetime import date, datetime

from .metrics_flow import (
    FlowMetric,
    PullRequest,
    Review,
    Week,
    counting_reviews,
    mark_partial_week,
    weeks_between,
)

# The metric_key values T5.6 owns in horizon_projects.project_metrics.
REVIEW_METRIC_KEYS = (
    "merged_prs_without_review_share",
    "changes_requested_share",
    "reviews_per_merged_pr",
    "distinct_reviewers",
)


def _in_week(moment: datetime, week: Week) -> bool:
    return week.start <= moment < week.end


def merged_in_week(prs: list[PullRequest], week: Week) -> list[PullRequest]:
    """M(w): PRs merged during the week."""
    return [pr for pr in prs if pr.merged_at is not None and _in_week(pr.merged_at, week)]


def reviews_before_merge(pr: PullRequest) -> list[Review]:
    """Counting reviews submitted at or before the merge."""
    return [r for r in counting_reviews(pr) if pr.merged_at is not None and r.submitted_at <= pr.merged_at]


def reviewer_identity(review: Review) -> str:
    """reviewer_pk, or the lower-cased login when the pk is unknown."""
    return review.reviewer_pk or review.reviewer_login.casefold()


def merged_prs_without_review_share(prs: list[PullRequest], week: Week) -> FlowMetric:
    merged = merged_in_week(prs, week)
    key = "merged_prs_without_review_share"
    if not merged:
        return FlowMetric(week.week_start, key, None, "no_merged_prs")
    without_review = [pr for pr in merged if not reviews_before_merge(pr)]
    evidence = {"merged": len(merged), "without_review": len(without_review)}
    return FlowMetric(week.week_start, key, len(without_review) / len(merged), None, evidence)


def changes_requested_share(prs: list[PullRequest], week: Week) -> FlowMetric:
    """Of PRs with a counting review this week, the share that got a REQUEST_CHANGES this week."""
    reviewed = changes_requested = 0
    for pr in prs:
        this_week = [r for r in counting_reviews(pr) if _in_week(r.submitted_at, week)]
        if not this_week:
            continue
        reviewed += 1
        if any(r.state == "REQUEST_CHANGES" for r in this_week):
            changes_requested += 1
    key = "changes_requested_share"
    if reviewed == 0:
        return FlowMetric(week.week_start, key, None, "no_reviews")
    evidence = {"reviewed_prs": reviewed, "changes_requested_prs": changes_requested}
    return FlowMetric(week.week_start, key, changes_requested / reviewed, None, evidence)


def reviews_per_merged_pr(prs: list[PullRequest], week: Week) -> FlowMetric:
    merged = merged_in_week(prs, week)
    key = "reviews_per_merged_pr"
    if not merged:
        return FlowMetric(week.week_start, key, None, "no_merged_prs")
    total = sum(len(reviews_before_merge(pr)) for pr in merged)
    evidence = {"merged": len(merged), "reviews": total}
    return FlowMetric(week.week_start, key, total / len(merged), None, evidence)


def distinct_reviewers(prs: list[PullRequest], week: Week) -> FlowMetric:
    """People who left a counting review this week. A real 0 when nobody did."""
    identities = {
        reviewer_identity(r)
        for pr in prs
        for r in counting_reviews(pr)
        if _in_week(r.submitted_at, week)
    }
    return FlowMetric(week.week_start, "distinct_reviewers", float(len(identities)))


def review_metrics_for_week(prs: list[PullRequest], week: Week) -> list[FlowMetric]:
    """All four T5.6 metrics for one week."""
    metrics = [
        merged_prs_without_review_share(prs, week),
        changes_requested_share(prs, week),
        reviews_per_merged_pr(prs, week),
        distinct_reviewers(prs, week),
    ]
    return mark_partial_week(metrics, week)


def project_review_metrics(
    prs: list[PullRequest], window_start: date, as_of: datetime
) -> list[FlowMetric]:
    """Every week's review metrics for one project, recomputed from scratch each run."""
    rows: list[FlowMetric] = []
    for week in weeks_between(window_start, as_of):
        rows.extend(review_metrics_for_week(prs, week))
    return rows
