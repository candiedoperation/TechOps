"""Tests for the T5.6 review-quality metrics."""

from datetime import date, datetime

import pytest
from dagster import build_asset_context

from pipeline.assets.projects import ReviewMetricsConfig, project_review_metrics as review_asset
from pipeline.projects.metrics_flow import PROJECT_TIMEZONE, PullRequest, Review
from pipeline.projects.metrics_review import REVIEW_METRIC_KEYS, project_review_metrics


def ny(year, month, day, hour=0, minute=0):
    return datetime(year, month, day, hour, minute, tzinfo=PROJECT_TIMEZONE)


def by_key(rows, week_start):
    return {row.metric_key: row for row in rows if row.week_start == week_start}


# The T5.5 worked-example week, used by the T5.6 spec too.
PR_30 = PullRequest(30, "alice", ny(2026, 11, 2, 9), ny(2026, 11, 3, 9), ny(2026, 11, 3, 9),
                    (Review("bob", "APPROVED", ny(2026, 11, 2, 15)),))
PR_31 = PullRequest(31, "carol", ny(2026, 11, 4, 10), None, None,
                    (Review("Carol", "COMMENT", ny(2026, 11, 4, 11)),))  # self-review
PR_32 = PullRequest(32, "dave", ny(2026, 11, 5, 12), ny(2026, 11, 5, 13), ny(2026, 11, 5, 13))
SPEC_WEEK = date(2026, 11, 2)
SPEC_AS_OF = ny(2026, 11, 8, 23, 59)


def test_spec_worked_example():
    week = by_key(project_review_metrics([PR_30, PR_31, PR_32], SPEC_WEEK, SPEC_AS_OF), SPEC_WEEK)

    assert week["merged_prs_without_review_share"].value == pytest.approx(0.5)
    assert week["reviews_per_merged_pr"].value == pytest.approx(0.5)
    assert week["changes_requested_share"].value == 0
    assert week["distinct_reviewers"].value == 1  # Carol's own comment does not count


def test_self_review_is_excluded_case_insensitively():
    pr = PullRequest(1, "Alice", ny(2026, 11, 2, 9), ny(2026, 11, 2, 12), ny(2026, 11, 2, 12),
                     (Review("alice", "APPROVED", ny(2026, 11, 2, 10)),))
    week = by_key(project_review_metrics([pr], SPEC_WEEK, SPEC_AS_OF), SPEC_WEEK)

    assert week["merged_prs_without_review_share"].value == 1.0
    assert week["reviews_per_merged_pr"].value == 0
    assert week["changes_requested_share"].missing_reason == "no_reviews"
    assert week["distinct_reviewers"].value == 0


def test_week_with_zero_merges_is_null_not_zero():
    pr = PullRequest(1, "alice", ny(2026, 11, 2, 9), None, None,
                     (Review("bob", "REQUEST_CHANGES", ny(2026, 11, 3, 9)),))
    week = by_key(project_review_metrics([pr], SPEC_WEEK, SPEC_AS_OF), SPEC_WEEK)

    for key in ("merged_prs_without_review_share", "reviews_per_merged_pr"):
        assert week[key].value is None
        assert week[key].missing_reason == "no_merged_prs"
    assert week["changes_requested_share"].value == 1.0
    assert week["distinct_reviewers"].value == 1


def test_reviews_after_the_merge_do_not_count_for_that_pr():
    pr = PullRequest(1, "alice", ny(2026, 11, 2, 9), ny(2026, 11, 2, 12), ny(2026, 11, 2, 12),
                     (Review("bob", "APPROVED", ny(2026, 11, 2, 13)),))  # an hour after merge
    week = by_key(project_review_metrics([pr], SPEC_WEEK, SPEC_AS_OF), SPEC_WEEK)

    assert week["merged_prs_without_review_share"].value == 1.0
    assert week["reviews_per_merged_pr"].value == 0
    # The late review still happened this week, so it counts for review activity.
    assert week["distinct_reviewers"].value == 1


def test_changes_requested_uses_reviews_submitted_that_week():
    # Changes requested in week 1, approved in week 2: week 1 = 1.0, week 2 = 0.
    pr = PullRequest(1, "alice", ny(2026, 10, 28, 9), ny(2026, 11, 3, 9), ny(2026, 11, 3, 9), (
        Review("bob", "REQUEST_CHANGES", ny(2026, 10, 29, 9)),
        Review("bob", "APPROVED", ny(2026, 11, 2, 9)),
    ))
    rows = project_review_metrics([pr], date(2026, 10, 26), SPEC_AS_OF)

    assert by_key(rows, date(2026, 10, 26))["changes_requested_share"].value == 1.0
    assert by_key(rows, SPEC_WEEK)["changes_requested_share"].value == 0
    assert by_key(rows, SPEC_WEEK)["reviews_per_merged_pr"].value == 2.0  # both before merge


def test_distinct_reviewers_prefers_pk_then_lowercase_login():
    pr = PullRequest(1, "alice", ny(2026, 11, 2, 9), None, None, (
        Review("Bob", "COMMENT", ny(2026, 11, 2, 10)),
        Review("bob", "APPROVED", ny(2026, 11, 2, 11)),  # same person by login
        Review("robert", "COMMENT", ny(2026, 11, 2, 12), reviewer_pk="42"),
        Review("bobby", "COMMENT", ny(2026, 11, 2, 13), reviewer_pk="42"),  # same pk
        Review("erin", "PENDING", ny(2026, 11, 2, 14)),  # not a counted state
    ))
    week = by_key(project_review_metrics([pr], SPEC_WEEK, SPEC_AS_OF), SPEC_WEEK)

    assert week["distinct_reviewers"].value == 2


def test_every_week_has_all_four_metrics_and_partial_flag():
    rows = project_review_metrics([PR_30], date(2026, 10, 19), SPEC_AS_OF)

    assert len(rows) == 3 * 4
    assert {row.metric_key for row in rows} == set(REVIEW_METRIC_KEYS)
    assert all(row.evidence.get("partial_week") for row in rows if row.week_start == SPEC_WEEK)
    assert not any(row.evidence.get("partial_week") for row in rows if row.week_start != SPEC_WEEK)


def test_asset_on_sample_fixture():
    rows = review_asset(build_asset_context(), ReviewMetricsConfig())
    spec_week = by_key(rows, SPEC_WEEK)
    first_week = by_key(rows, date(2026, 10, 19))

    assert len(rows) == 3 * 4
    assert spec_week["merged_prs_without_review_share"].value == pytest.approx(0.5)
    assert spec_week["distinct_reviewers"].value == 1
    # PR #28: bob requested changes, then approved, both before the merge.
    assert first_week["changes_requested_share"].value == 1.0
    assert first_week["reviews_per_merged_pr"].value == 2.0
