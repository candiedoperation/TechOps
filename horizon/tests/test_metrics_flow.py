"""Tests for the T5.5 engineering-flow metrics."""

from datetime import date, datetime

import pytest

from pipeline.projects.metrics_flow import (
    PROJECT_TIMEZONE,
    PullRequest,
    Review,
    first_review_at,
    project_flow_metrics,
    weeks_between,
)


def ny(year, month, day, hour=0, minute=0):
    """A New York time, so the fixtures read like the spec."""
    return datetime(year, month, day, hour, minute, tzinfo=PROJECT_TIMEZONE)


def by_key(rows, week_start):
    return {row.metric_key: row for row in rows if row.week_start == week_start}


# The worked example from the T5.5 spec: week of Mon 2026-11-02.
PR_30 = PullRequest(
    number=30,
    author_login="alice",
    created_at=ny(2026, 11, 2, 9),
    merged_at=ny(2026, 11, 3, 9),
    closed_at=ny(2026, 11, 3, 9),
    reviews=(Review("bob", "APPROVED", ny(2026, 11, 2, 15)),),
)
PR_31 = PullRequest(
    number=31,
    author_login="carol",
    created_at=ny(2026, 11, 4, 10),
    merged_at=None,
    closed_at=None,
    # The author's own comment must not count as a review.
    reviews=(Review("Carol", "COMMENT", ny(2026, 11, 4, 11)),),
)
PR_32 = PullRequest(
    number=32,
    author_login="dave",
    created_at=ny(2026, 11, 5, 12),
    merged_at=ny(2026, 11, 5, 13),
    closed_at=ny(2026, 11, 5, 13),
)
SPEC_AS_OF = ny(2026, 11, 8, 23, 59)
SPEC_WEEK = date(2026, 11, 2)


def test_spec_worked_example():
    rows = project_flow_metrics([PR_30, PR_31, PR_32], SPEC_WEEK, SPEC_AS_OF)
    week = by_key(rows, SPEC_WEEK)

    assert week["prs_opened"].value == 3
    assert week["prs_merged"].value == 2
    assert week["open_prs_end_of_week"].value == 1
    assert week["median_open_pr_age_days"].value == pytest.approx(4.58, abs=0.01)
    assert week["median_time_to_first_review_hours"].value == pytest.approx(57.99, abs=0.01)
    assert week["median_time_to_merge_hours"].value == pytest.approx(12.5)


def test_spec_example_first_review_evidence_counts():
    rows = project_flow_metrics([PR_30, PR_31, PR_32], SPEC_WEEK, SPEC_AS_OF)
    evidence = by_key(rows, SPEC_WEEK)["median_time_to_first_review_hours"].evidence

    assert evidence["reviewed"] == 1
    assert evidence["waiting"] == 1
    assert evidence["excluded"] == 1


def test_spec_example_week_is_partial():
    rows = project_flow_metrics([PR_30, PR_31, PR_32], SPEC_WEEK, SPEC_AS_OF)

    assert all(row.evidence.get("partial_week") is True for row in rows)


def test_self_review_does_not_count_case_insensitive():
    pr = PullRequest(
        number=1,
        author_login="Alice",
        created_at=ny(2026, 11, 2, 9),
        merged_at=None,
        closed_at=None,
        reviews=(
            Review("alice", "APPROVED", ny(2026, 11, 2, 10)),
            Review("bob", "PENDING", ny(2026, 11, 2, 11)),
            Review("bob", "COMMENT", ny(2026, 11, 2, 12)),
        ),
    )

    assert first_review_at(pr) == ny(2026, 11, 2, 12)


# Three weeks: Oct 19, Oct 26 (contains the Nov 1 daylight saving change) and Nov 2.
WINDOW_START = date(2026, 10, 21)  # a Wednesday, so weeks begin Mon Oct 19
THREE_WEEK_AS_OF = ny(2026, 11, 4, 12)

PR_LAST_MINUTE = PullRequest(  # opened Sun 23:59, the last minute of week 1
    number=1,
    author_login="alice",
    created_at=ny(2026, 10, 25, 23, 59),
    merged_at=ny(2026, 10, 26, 0, 0),  # merged exactly at Monday midnight: week 2
    closed_at=ny(2026, 10, 26, 0, 0),
    reviews=(Review("bob", "APPROVED", ny(2026, 10, 25, 23, 59)),),
)
PR_MONDAY_MIDNIGHT = PullRequest(  # opened exactly at Monday 00:00: week 2
    number=2,
    author_login="bob",
    created_at=ny(2026, 10, 26, 0, 0),
    merged_at=None,
    closed_at=ny(2026, 10, 27, 9),  # closed without merging or review
)
PR_LONG_OPEN = PullRequest(  # opened week 1, still open, reviewed in week 3
    number=3,
    author_login="carol",
    created_at=ny(2026, 10, 20, 12),
    merged_at=None,
    closed_at=None,
    reviews=(Review("dave", "REQUEST_CHANGES", ny(2026, 11, 3, 12)),),
)
THREE_WEEK_PRS = [PR_LAST_MINUTE, PR_MONDAY_MIDNIGHT, PR_LONG_OPEN]


def test_weeks_cover_window_to_as_of_and_start_at_local_midnight():
    weeks = weeks_between(WINDOW_START, THREE_WEEK_AS_OF)

    assert [w.week_start for w in weeks] == [date(2026, 10, 19), date(2026, 10, 26), date(2026, 11, 2)]
    assert [w.partial for w in weeks] == [False, False, True]
    assert weeks[-1].end == THREE_WEEK_AS_OF
    # The week with the clock change is 169 hours long but still ends at local midnight.
    assert weeks[1].end == ny(2026, 11, 2)
    assert (weeks[1].end - weeks[1].start).total_seconds() / 3600 == 169


def test_week_boundaries_for_opened_and_merged():
    rows = project_flow_metrics(THREE_WEEK_PRS, WINDOW_START, THREE_WEEK_AS_OF)
    week1 = by_key(rows, date(2026, 10, 19))
    week2 = by_key(rows, date(2026, 10, 26))
    week3 = by_key(rows, date(2026, 11, 2))

    assert week1["prs_opened"].value == 2  # #1 at Sun 23:59 and #3
    assert week2["prs_opened"].value == 1  # #2 at Mon 00:00
    assert week3["prs_opened"].value == 0
    assert week1["prs_merged"].value == 0
    assert week2["prs_merged"].value == 1  # #1 merged at Mon 00:00


def test_open_prs_end_of_week_and_age():
    rows = project_flow_metrics(THREE_WEEK_PRS, WINDOW_START, THREE_WEEK_AS_OF)
    week1 = by_key(rows, date(2026, 10, 19))
    week2 = by_key(rows, date(2026, 10, 26))

    # The spec counts a PR as open when closed_at >= end(w), so #1, closed exactly
    # at Mon Oct 26 00:00, is still open at the end of week 1.
    assert week1["open_prs_end_of_week"].value == 2  # #1 and #3
    assert week2["open_prs_end_of_week"].value == 1  # only #3
    # Oct 20 12:00 to Nov 2 00:00 is 12.5 calendar days plus the extra hour
    # from the Nov 1 clock change.
    assert week2["median_open_pr_age_days"].value == pytest.approx(12.5 + 1 / 24)


def test_first_review_waiting_reviewed_and_excluded():
    rows = project_flow_metrics(THREE_WEEK_PRS, WINDOW_START, THREE_WEEK_AS_OF)
    week1 = by_key(rows, date(2026, 10, 19))["median_time_to_first_review_hours"]
    week2 = by_key(rows, date(2026, 10, 26))["median_time_to_first_review_hours"]
    week3 = by_key(rows, date(2026, 11, 2))["median_time_to_first_review_hours"]

    # #1 reviewed after 0 hours; #3 reviewed on Nov 3 12:00 (a later week still
    # counts): 14 days plus the extra clock-change hour = 337 hours.
    assert week1.value == pytest.approx((0 + 337) / 2)
    assert week1.evidence == {"reviewed": 2, "waiting": 0, "excluded": 0}
    # #2 closed with no review: excluded, so nothing is left.
    assert week2.value is None
    assert week2.missing_reason == "no_reviews"
    assert week2.evidence == {"reviewed": 0, "waiting": 0, "excluded": 1}
    # No PRs opened in week 3.
    assert week3.value is None
    assert week3.missing_reason == "no_reviews"


def test_review_after_as_of_counts_as_waiting():
    as_of = ny(2026, 10, 30, 12)  # before #3's review on Nov 3
    rows = project_flow_metrics([PR_LONG_OPEN], WINDOW_START, as_of)
    week1 = by_key(rows, date(2026, 10, 19))["median_time_to_first_review_hours"]

    assert week1.evidence == {"reviewed": 0, "waiting": 1, "excluded": 0}
    assert week1.value == pytest.approx((as_of - PR_LONG_OPEN.created_at).total_seconds() / 3600)


def test_missing_reasons_when_nothing_happened():
    rows = project_flow_metrics([], WINDOW_START, THREE_WEEK_AS_OF)
    week = by_key(rows, date(2026, 10, 19))

    assert week["prs_opened"].value == 0  # a real zero, not missing
    assert week["open_prs_end_of_week"].value == 0
    assert week["median_open_pr_age_days"].missing_reason == "no_open_prs"
    assert week["median_time_to_first_review_hours"].missing_reason == "no_reviews"
    assert week["median_time_to_merge_hours"].missing_reason == "no_merged_prs"
    assert week["median_time_to_merge_hours"].value is None


def test_every_week_has_all_six_metrics():
    rows = project_flow_metrics(THREE_WEEK_PRS, WINDOW_START, THREE_WEEK_AS_OF)

    assert len(rows) == 3 * 6
    assert {row.metric_key for row in rows} == {
        "prs_opened",
        "prs_merged",
        "open_prs_end_of_week",
        "median_open_pr_age_days",
        "median_time_to_first_review_hours",
        "median_time_to_merge_hours",
    }
