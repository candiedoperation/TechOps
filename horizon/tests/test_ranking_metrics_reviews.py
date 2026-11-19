import itertools
import json
from dataclasses import replace
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from pipeline.ranking.members import ProjectMemberRow, RankedMember
from pipeline.ranking.metrics_code import ProjectContext
from pipeline.ranking.metrics_reviews import (
    PullRequestCommitRow,
    PullRequestRow,
    ReviewData,
    ReviewRequestRow,
    ReviewRow,
    compute_member_review_metrics,
    compute_run_review_metrics,
    is_counting_review,
    review_turnaround_hours,
    review_window,
)
from pipeline.ranking.rubric import load_rubric

# Project p1 has engineers a, b and e (e opens no PRs), tech lead t and a PM.
# The card's worked example: E = 2026-11-08 18:00 in New York.
NY = ZoneInfo("America/New_York")
API, OTHER = ("SpaceApp", "api"), ("Elsewhere", "x")
SOURCE_RUNS = {"SpaceApp/api": "run-api"}
WINDOW_START, SEMESTER_END = date(2026, 8, 31), date(2026, 12, 11)
RUBRIC = load_rubric("v1").rubric
_REVIEW_IDS = itertools.count(1)


def at(day, hour=12, minute=0):
    return datetime.fromisoformat(day).replace(hour=hour, minute=minute, tzinfo=NY)


AS_OF = at("2026-11-08", 18)

PROJECT = ProjectContext(
    project_pk="p1",
    repositories=(API,),
    source_runs=SOURCE_RUNS,
    semester_end=SEMESTER_END,
    team=frozenset({"a", "b", "t"}),
)


def roster_row(pk, roles):
    return ProjectMemberRow(
        project_pk="p1",
        authentik_user_pk=pk,
        username=pk,
        display_name=pk,
        roles=tuple(roles),
        role_titles={},
        tenure_semesters=1,
        role_mapping_version="2026-11-v1",
    )


ROSTER = [
    roster_row("a", ["engineer"]),
    roster_row("b", ["engineer"]),
    roster_row("e", ["engineer"]),
    roster_row("t", ["tech_lead"]),
    roster_row("pm", ["pm"]),
]


def member(pk, role="engineer", **overrides):
    values = dict(
        authentik_user_pk=pk,
        project_pk="p1",
        role=role,
        display_name=pk,
        role_title=None,
        project_name="SpaceApp",
        comparison_group="club:tech_lead" if role == "tech_lead" else "project:p1:engineer",
        tenure_semesters=1,
        window_start=WINDOW_START,
        window_end=date(2026, 11, 8),
    )
    values.update(overrides)
    return RankedMember(**values)


def pr(number, author, *, created="2026-10-01", merged_at=None, repo=API, login=None):
    return PullRequestRow(
        *repo, number, login or author, author, merged_at is not None, at(created),
        at(*merged_at) if merged_at else None,
    )


def review(number, reviewer, state, submitted, *, login=None, repo=API):
    return ReviewRow(
        *repo, number, next(_REVIEW_IDS),
        login or reviewer, reviewer, state, at(*submitted) if submitted else None,
    )


def request(number, requested, requested_at, event_id, repo=API):
    return ReviewRequestRow(*repo, number, event_id, requested, requested, at(*requested_at))


PULL_REQUESTS = [
    pr(12, "a"),
    pr(15, "a"),
    pr(20, "a"),
    pr(18, "b"),                                   # B's own PR
    pr(30, "a", merged_at=("2026-10-10",)),        # commits by a and b
    pr(31, "b", merged_at=("2026-10-12",)),        # only b's commits
    pr(32, "a"),                                   # not merged, commits by a and b
    pr(40, "pm"),
]

REVIEWS = [
    review(12, "b", "APPROVED", ("2026-11-02", 16)),
    review(15, "b", "COMMENT", ("2026-11-05", 9)),
    review(20, "b", "PENDING", None),              # never counts
    review(20, "b", "APPROVED", ("2026-11-09", 9)),  # after E: still unanswered at E
    review(18, "b", "APPROVED", ("2026-11-03", 12)),  # a self-review
    review(12, "t", "APPROVED", ("2026-11-03", 11)),
    review(40, "t", "APPROVED", ("2026-11-03", 11)),  # a PM's PR
]

REQUESTS = [
    request(12, "b", ("2026-11-02", 10), 1),  # Mon, answered 16:00 -> 6 h
    request(15, "b", ("2026-11-03", 9), 2),   # Tue, answered Thu 09:00 -> 48 h
    request(20, "b", ("2026-11-07", 12), 3),  # Sat, unanswered by E -> 30 h
    request(18, "b", ("2026-11-03", 10), 4),  # B's own PR: skipped
]

COMMITS = [
    PullRequestCommitRow(*API, 30, "s1", "a", "run-api"),
    PullRequestCommitRow(*API, 30, "s2", "b", "run-api"),
    PullRequestCommitRow(*API, 31, "s3", "b", "run-api"),
    PullRequestCommitRow(*API, 31, "s4", "c", "run-old"),  # older run: ignored
    PullRequestCommitRow(*API, 32, "s5", "a", "run-api"),
    PullRequestCommitRow(*API, 32, "s6", "b", "run-api"),
]

DATA = ReviewData.build(PULL_REQUESTS, REVIEWS, REQUESTS, COMMITS, SOURCE_RUNS)


def metrics(person, *, data=DATA, project=PROJECT, as_of=AS_OF, roster=ROSTER):
    values = compute_member_review_metrics(
        person, project, roster, as_of, RUBRIC.roles[person.role], data
    )
    return {value.metric_key: value for value in values}


def test_the_worked_turnaround_example_is_30_hours():
    value = metrics(member("b"))["review_turnaround_hours"]

    assert value.raw_value == 30  # median(6, 30, 48)
    assert [(wait["pull_request"], wait["hours"], wait["answered"])
            for wait in value.evidence["requests"]] == [
        ("SpaceApp/api#12", 6, True),
        ("SpaceApp/api#15", 48, True),
        ("SpaceApp/api#20", 30, False),
    ]


def test_an_even_number_of_requests_averages_the_middle_two():
    data = ReviewData.build(PULL_REQUESTS, REVIEWS, REQUESTS[:2], COMMITS, SOURCE_RUNS)
    window = review_window(WINDOW_START, SEMESTER_END, AS_OF)

    assert review_turnaround_hours("b", PROJECT, data, window).raw_value == 27


def test_a_re_request_after_a_review_is_a_new_request():
    requests = [*REQUESTS[:1], request(12, "b", ("2026-11-08", 12), 9)]
    data = ReviewData.build(PULL_REQUESTS, REVIEWS, requests, COMMITS, SOURCE_RUNS)
    window = review_window(WINDOW_START, SEMESTER_END, AS_OF)

    value = review_turnaround_hours("b", PROJECT, data, window)

    # 6 h for the first request; the re-request waits 6 h until E.
    assert [wait["hours"] for wait in value.evidence["requests"]] == [6, 6]


def test_no_review_requests_is_missing():
    value = metrics(member("t", "tech_lead"))["review_turnaround_hours"]

    assert value.raw_value is None
    assert value.missing_reason == "no_review_requests"


def test_prs_reviewed_counts_teammates_prs_with_a_submitted_review():
    value = metrics(member("b"))["prs_reviewed"]

    # #12 and #15. #20 only has a PENDING review in W, and #18 is b's own.
    assert value.raw_value == 2
    assert value.evidence["pull_requests"] == ["SpaceApp/api#12", "SpaceApp/api#15"]


def test_self_reviews_and_pending_reviews_do_not_count():
    own = pr(18, "b")

    assert not is_counting_review(REVIEWS[4], own)
    assert not is_counting_review(REVIEWS[2], pr(20, "a"))
    assert is_counting_review(REVIEWS[0], pr(12, "a"))


def test_logins_are_compared_case_insensitively_when_a_pk_is_missing():
    unresolved_pr = PullRequestRow(*API, 50, "Alice", None, False, at("2026-10-01"), None)
    by_alice = ReviewRow(*API, 50, 1, "alice", None, "APPROVED", at("2026-10-02"))
    by_bob = ReviewRow(*API, 50, 2, "bob", None, "APPROVED", at("2026-10-02"))

    assert not is_counting_review(by_alice, unresolved_pr)
    assert is_counting_review(by_bob, unresolved_pr)


def test_collaborative_prs_need_two_contributors_and_a_merge_in_the_window():
    values_a, values_b = metrics(member("a")), metrics(member("b"))

    # #30 has commits by a and b. #31 has only b (c's commit is from an older
    # run). #32 is not merged.
    assert values_a["collaborative_prs"].raw_value == 1
    assert values_b["collaborative_prs"].raw_value == 1
    assert values_b["collaborative_prs"].evidence["pull_requests"] == ["SpaceApp/api#30"]


def test_tech_lead_rows_follow_the_rubric():
    values = metrics(member("t", "tech_lead"))

    assert {key: value.bucket_key for key, value in values.items()} == {
        "team_prs_reviewed": "review_unblocking",
        "review_turnaround_hours": "review_unblocking",
        "review_spread": "review_unblocking",
    }
    # t reviewed a's #12; the PM's #40 is not an engineer's PR.
    assert values["team_prs_reviewed"].raw_value == 1


def test_review_spread_ignores_engineers_who_opened_no_prs():
    value = metrics(member("t", "tech_lead"))["review_spread"]

    # a and b opened PRs in W, and t reviewed one of a's; e opened none.
    assert value.raw_value == 0.5
    assert value.evidence == {"engineers_with_prs": ["a", "b"], "engineers_reviewed": ["a"]}


def test_review_spread_without_engineer_prs_is_missing():
    data = ReviewData.build([pr(40, "pm")], REVIEWS, [], [], SOURCE_RUNS)

    value = metrics(member("t", "tech_lead"), data=data)["review_spread"]

    assert value.missing_reason == "no_engineer_prs"


def test_an_excluded_review_bucket_writes_no_rows():
    excluded = member("b", excluded_buckets=("review_collaboration",))

    assert metrics(excluded) == {}


def test_a_project_without_repositories_is_missing_not_zero():
    empty = replace(PROJECT, repositories=(), source_runs={})

    values = metrics(member("b"), project=empty)

    assert {value.missing_reason for value in values.values()} == {"no_project_repositories"}


def test_events_outside_the_project_or_window_are_ignored():
    elsewhere = pr(12, "a", repo=OTHER)
    data = ReviewData.build(
        [elsewhere, pr(60, "a", created="2026-08-01")],
        [review(12, "b", "APPROVED", ("2026-11-02", 16), repo=OTHER),
         review(60, "b", "APPROVED", ("2026-08-15",))],  # before W start
        [], [], SOURCE_RUNS,
    )

    assert metrics(member("b"), data=data)["prs_reviewed"].raw_value == 0


def test_a_whole_run_writes_json_evidence_for_every_row():
    members = [member("a"), member("b"), member("t", "tech_lead")]

    values = compute_run_review_metrics(members, {"p1": PROJECT}, ROSTER, AS_OF, RUBRIC, DATA)

    assert len(values) == 3 + 3 + 3
    for value in values:
        json.dumps(value.evidence)


def test_the_window_runs_from_midnight_to_the_earlier_of_as_of_and_the_end():
    window = review_window(WINDOW_START, SEMESTER_END, at("2026-12-20"))

    assert window.start == datetime(2026, 8, 31, tzinfo=NY)
    assert window.end.date() == SEMESTER_END and window.end.hour == 23
    with pytest.raises(ValueError, match="timezone-aware"):
        review_window(WINDOW_START, SEMESTER_END, datetime(2026, 11, 8))
