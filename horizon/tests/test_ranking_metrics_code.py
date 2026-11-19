import json
import math
from dataclasses import replace
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from pipeline.ranking import store
from pipeline.ranking.members import RankedMember
from pipeline.ranking.metrics_code import (
    METRIC_KEYS,
    BlameCommitRow,
    CommitActivityRow,
    ContributionRow,
    GitCommitRow,
    MetricValue,
    ProjectContext,
    build_project_contexts,
    compute_member_metrics,
    compute_run_metrics,
)
from pipeline.ranking.rubric import load_rubric

# The worked example from the T4.2 spec: window Mon 2026-08-31 to Fri 2026-12-11,
# as_of Sun 2026-11-08, so E = 2026-11-08 and the window has touched ISO weeks
# 36 to 45 (10 weeks). Members: a (engineer), b (tech lead), c (engineer whose
# commits never resolve). Two repositories, api and web.
NY = ZoneInfo("America/New_York")
API, WEB, OTHER = ("SpaceApp", "api"), ("SpaceApp", "web"), ("Elsewhere", "x")
SOURCE_RUNS = {"SpaceApp/api": "run-api", "SpaceApp/web": "run-web"}
WINDOW_START, SEMESTER_END, E = date(2026, 8, 31), date(2026, 12, 11), date(2026, 11, 8)
RUBRIC = load_rubric("v1").rubric


def at(day, hour=12, minute=0):
    return datetime.fromisoformat(day).replace(hour=hour, minute=minute, tzinfo=NY)


AS_OF = at("2026-11-08")
AFTER_SEMESTER = at("2026-12-12")


def member(pk, role="engineer", *, window_end=E, tenure=2):
    return RankedMember(
        authentik_user_pk=pk,
        project_pk="p1",
        role=role,
        display_name=pk,
        role_title=None,
        project_name="SpaceApp",
        comparison_group="club:tech_lead" if role == "tech_lead" else "project:p1:engineer",
        tenure_semesters=tenure,
        window_start=WINDOW_START,
        window_end=window_end,
    )


PROJECT = ProjectContext(
    project_pk="p1",
    repositories=(API, WEB),
    source_runs=SOURCE_RUNS,
    semester_end=SEMESTER_END,
    team=frozenset({"a", "b", "c"}),
)

CONTRIBUTIONS = [
    ContributionRow("run-api", *API, "a", 2, 120),
    ContributionRow("run-web", *WEB, "a", 1, 30),
    ContributionRow("run-old", *API, "a", 9, 999),  # an older run: ignored
]

BLAME = [
    BlameCommitRow("run-api", *API, "a.ts", "c1", "a", True, 10),
    BlameCommitRow("run-api", *API, "b.ts", "c1", "a", True, 5),
    BlameCommitRow("run-api", *API, "a.ts", "c2", "a", True, 3),
    BlameCommitRow("run-web", *WEB, "x.tsx", "c9", "a", True, 7),
    BlameCommitRow("run-api", *API, "package-lock.json", "c5", "a", False, 400),
    BlameCommitRow("run-old", *API, "old.ts", "c0", "a", True, 50),
]


def activity(pk, day, source="default_branch", lines=10, repo=API, credit="author", **at_kw):
    return CommitActivityRow(
        *repo, f"sha-{pk}-{day}", pk, credit, at(day, **at_kw), source,
        None if source == "pr_branch" else lines,
    )


ACTIVITY = [
    activity("a", "2026-09-02"),                     # W36, 2 days after window_start
    activity("a", "2026-09-09", lines=5),            # W37
    activity("a", "2026-09-30", credit="co_author"),  # W40
    activity("a", "2026-10-07", source="pr_branch"),  # W41, NULL eligible lines
    activity("a", "2026-11-04", lines=3),            # W45
    activity("a", "2026-11-09", source="pr_branch"),  # after E: ignored
    activity("a", "2026-10-21", lines=0),            # lockfile-only commit: ignored
    activity("a", "2026-10-14", repo=OTHER),         # not a project repository: ignored
    activity("b", "2026-09-15", lines=20),
]


def commit(pk, day, lines, repo=API, on_default_branch=True):
    return GitCommitRow(*repo, f"sha-{pk}-{day}", pk, at(day), lines, on_default_branch)


COMMITS = [
    commit("a", "2026-09-10", 150),
    commit("b", "2026-10-01", 100),
    commit("a", "2026-11-20", 50, repo=WEB),  # the day before the late window
    commit("b", "2026-11-21", 60),            # first day of the late window
    commit("a", "2026-12-11", 40),            # last day of the window
    commit("pm-1", "2026-11-25", 500),        # not on the ranked team
    commit("a", "2026-11-25", 500, on_default_branch=False),
    commit("a", "2026-12-12", 500),           # after the window
    commit("a", "2026-11-25", 500, repo=OTHER),
]


def metrics(person, *, as_of=AS_OF, project=PROJECT, **rows):
    values = compute_member_metrics(
        person,
        project,
        as_of,
        RUBRIC.roles[person.role],
        contributions=rows.get("contributions", CONTRIBUTIONS),
        blame_rows=rows.get("blame_rows", BLAME),
        activity=rows.get("activity", ACTIVITY),
        commits=rows.get("commits", COMMITS),
    )
    return {value.metric_key: value for value in values}


def test_the_worked_example_for_an_engineer():
    values = metrics(member("a"))

    assert values["files_majority_owned"].raw_value == 3
    assert values["non_boundary_lines"].raw_value == 150
    assert values["non_boundary_lines"].evidence["log1p"] == pytest.approx(math.log1p(150))
    # (api, c1) touches two files and counts once; the ineligible lockfile and
    # the older run are ignored.
    assert values["surviving_commits"].raw_value == 3
    assert values["surviving_commits"].evidence["surviving_lines"] == 25
    assert values["active_week_ratio"].raw_value == 0.5
    assert values["active_week_ratio"].evidence == {
        "source_runs": SOURCE_RUNS,
        "active_weeks": ["2026-W36", "2026-W37", "2026-W40", "2026-W41", "2026-W45"],
        "weeks_in_window": 10,
        "rows_by_source": {"default_branch": 4, "pr_branch": 1},
    }
    # Gaps 2, 7, 21, 7, 28; the 4 days from 11-04 to E do not count.
    assert values["longest_inactive_stretch"].raw_value == 28
    assert values["longest_inactive_stretch"].evidence["gap_start"] == "2026-10-07"
    assert values["longest_inactive_stretch"].evidence["gap_end"] == "2026-11-04"
    assert values["tenure_semesters"].raw_value == 2


def test_engineers_get_their_rubric_metrics_with_bucket_keys():
    values = metrics(member("a"))

    assert {key: value.bucket_key for key, value in values.items()} == {
        "files_majority_owned": "code_ownership",
        "non_boundary_lines": "code_ownership",
        "surviving_commits": "code_ownership",
        "active_week_ratio": "consistency",
        "longest_inactive_stretch": "consistency",
        "tenure_semesters": "club_engagement",
    }


def test_tech_leads_get_own_code_team_end_loading_and_tenure():
    values = metrics(member("b", "tech_lead", tenure=5))

    assert {key: value.bucket_key for key, value in values.items()} == {
        "files_majority_owned": "own_code",
        "non_boundary_lines": "own_code",
        "team_end_loading": "team_consistency",
        "tenure_semesters": "club_engagement",
    }
    # b has resolved activity but no surviving code: real zeros, not NULL.
    assert values["files_majority_owned"].raw_value == 0
    assert values["non_boundary_lines"].raw_value == 0
    assert values["tenure_semesters"].raw_value == 5


def test_team_end_loading_waits_for_the_end_of_the_semester():
    value = metrics(member("b", "tech_lead"))["team_end_loading"]

    assert value.raw_value is None
    assert value.missing_reason == "semester_not_finished"


def test_team_end_loading_after_the_semester():
    value = metrics(member("b", "tech_lead"), as_of=AFTER_SEMESTER)["team_end_loading"]

    # Late window 11-21 to 12-11: 60 + 40 of the team's 400 eligible lines.
    assert value.raw_value == 0.25
    assert value.evidence["late_start"] == "2026-11-21"
    assert value.evidence["late_lines"] == 100
    assert value.evidence["total_lines"] == 400
    assert value.evidence["commits"] == 5


def test_team_end_loading_with_no_eligible_lines():
    commits = [commit("a", "2026-10-01", 0)]

    value = metrics(member("b", "tech_lead"), as_of=AFTER_SEMESTER, commits=commits)

    assert value["team_end_loading"].missing_reason == "no_eligible_lines"


def test_a_member_whose_commits_never_resolve_is_missing_not_zero():
    values = metrics(member("c"))

    for key in ("files_majority_owned", "non_boundary_lines", "surviving_commits",
                "active_week_ratio", "longest_inactive_stretch"):
        assert values[key].raw_value is None
        assert values[key].missing_reason == "no_resolved_git_identity"
    assert values["tenure_semesters"].raw_value == 2


def test_a_lead_whose_commits_never_resolve_still_gets_the_team_metric():
    values = metrics(member("c", "tech_lead"), as_of=AFTER_SEMESTER)

    assert values["files_majority_owned"].missing_reason == "no_resolved_git_identity"
    assert values["team_end_loading"].raw_value == 0.25


def test_a_member_with_no_activity_is_inactive_for_the_whole_window():
    blame = [BlameCommitRow("run-api", *API, "old.ts", "c7", "d", True, 12)]

    values = metrics(member("d"), blame_rows=blame, activity=[])

    assert values["surviving_commits"].raw_value == 1
    assert values["active_week_ratio"].raw_value == 0
    assert values["longest_inactive_stretch"].raw_value == (E - WINDOW_START).days == 69


def test_the_gap_from_window_start_counts_and_the_trailing_gap_does_not():
    rows = [activity("a", "2026-09-20")]

    value = metrics(member("a"), activity=rows)["longest_inactive_stretch"]

    assert value.raw_value == 20  # not the 49 days from 09-20 to E
    assert value.evidence["gap_start"] == "2026-08-31"


def test_iso_weeks_use_new_york_dates():
    # 03:30 UTC on Monday 09-07 is still Sunday 09-06 in New York: week 36.
    late_sunday = CommitActivityRow(
        *API, "sha", "a", "author", datetime(2026, 9, 7, 3, 30, tzinfo=timezone.utc),
        "default_branch", 4,
    )

    value = metrics(member("a"), activity=[late_sunday])["active_week_ratio"]

    assert value.evidence["active_weeks"] == ["2026-W36"]
    assert value.raw_value == 0.1


def test_an_as_of_before_the_window_has_nothing_to_measure():
    values = metrics(member("a", window_end=date(2026, 8, 30)), as_of=at("2026-08-30"))

    assert values["active_week_ratio"].missing_reason == "window_not_started"
    assert values["longest_inactive_stretch"].missing_reason == "window_not_started"


def test_a_project_without_repositories_is_not_an_identity_problem():
    empty = replace(PROJECT, repositories=(), source_runs={})

    engineer = metrics(member("a"), project=empty)
    lead = metrics(member("b", "tech_lead"), project=empty, as_of=AFTER_SEMESTER)

    assert {value.missing_reason for key, value in engineer.items()
            if key != "tenure_semesters"} == {"no_project_repositories"}
    assert lead["team_end_loading"].missing_reason == "no_project_repositories"
    assert engineer["tenure_semesters"].raw_value == 2


def test_a_repository_without_a_source_run_is_an_error():
    with pytest.raises(ValueError, match="No source run recorded for SpaceApp/web"):
        replace(PROJECT, source_runs={"SpaceApp/api": "run-api"})


def test_project_contexts_use_the_run_snapshot_as_the_team():
    members = [member("a"), member("b", "tech_lead")]

    contexts = build_project_contexts(
        members, {"p1": [WEB, API]}, SOURCE_RUNS, {"p1": SEMESTER_END}
    )

    assert contexts["p1"].team == {"a", "b"}
    assert contexts["p1"].repositories == (API, WEB)
    with pytest.raises(ValueError, match="no projects row"):
        build_project_contexts(members, {}, SOURCE_RUNS, {})


def test_a_whole_run_writes_one_row_per_rubric_metric_with_json_evidence():
    members = [member("a"), member("b", "tech_lead"), member("c")]

    values = compute_run_metrics(
        members, {"p1": PROJECT}, AS_OF, RUBRIC,
        contributions=CONTRIBUTIONS, blame_rows=BLAME, activity=ACTIVITY, commits=COMMITS,
    )

    assert len(values) == 6 + 4 + 6
    assert {value.metric_key for value in values} <= set(METRIC_KEYS)
    for value in values:
        assert value.evidence["source_runs"] == SOURCE_RUNS
        json.dumps(value.evidence)


def test_a_metric_value_needs_exactly_one_of_value_and_reason():
    with pytest.raises(ValueError, match="exactly one"):
        MetricValue("a", "p1", "consistency", "active_week_ratio", None, None, {})
    with pytest.raises(ValueError, match="exactly one"):
        MetricValue("a", "p1", "consistency", "active_week_ratio", 0.5, "no_eligible_lines", {})


class _FakeConnection:
    """Records SQL; answers the run-status lock with a fixed status."""

    def __init__(self, status="running"):
        self.status = status
        self.statements = []
        self.batches = []

    def execute(self, statement, params=None):
        self.statements.append((" ".join(statement.split()), params))
        return self

    def fetchone(self):
        return (self.status,)

    def cursor(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def executemany(self, statement, rows):
        self.statements.append((" ".join(statement.split()), None))
        self.batches.append(list(rows))


def test_rerunning_replaces_only_this_steps_rows_for_the_run():
    connection = _FakeConnection()
    values = metrics(member("a")).values()

    written = store.replace_metric_values(connection, "run-1", METRIC_KEYS, list(values))

    lock, delete, insert = (sql for sql, _ in connection.statements)
    assert "FOR UPDATE" in lock
    assert delete.startswith("DELETE FROM horizon_ranking.metric_values")
    assert "metric_key = ANY" in delete
    assert connection.statements[1][1] == ("run-1", list(METRIC_KEYS))
    assert insert.startswith("INSERT INTO horizon_ranking.metric_values")
    assert written == len(connection.batches[0]) == 6


def test_metric_values_are_only_written_while_the_run_is_running():
    with pytest.raises(RuntimeError, match="no longer running"):
        store.replace_metric_values(_FakeConnection("failed"), "run-1", METRIC_KEYS, [])


def test_rows_outside_this_steps_metric_keys_are_rejected():
    stray = MetricValue("a", "p1", "delivery", "verified_completion", 1.0, None, {})

    with pytest.raises(ValueError, match="outside this step"):
        store.replace_metric_values(_FakeConnection(), "run-1", METRIC_KEYS, [stray])
