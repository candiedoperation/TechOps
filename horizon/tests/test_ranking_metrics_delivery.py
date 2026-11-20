from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from pipeline.ranking.members import RankedMember
from pipeline.ranking.metrics_delivery import (
    TaskMatchRow,
    TaskOverrideRow,
    TaskStatusRow,
    apply_overrides,
    compute_run_delivery_metrics,
    due_tasks,
    mean_completion,
)
from pipeline.ranking.rubric import load_rubric

NY = ZoneInfo("America/New_York")
AS_OF = datetime(2026, 11, 8, 12, tzinfo=NY)  # today = 2026-11-08
SEMESTER_END = date(2026, 12, 11)
RUBRIC = load_rubric("v1").rubric


def member(pk, role="engineer", project="p1"):
    return RankedMember(
        authentik_user_pk=pk,
        project_pk=project,
        role=role,
        display_name=pk,
        role_title=None,
        project_name="SpaceApp",
        comparison_group="club:tech_lead" if role == "tech_lead" else f"project:{project}:engineer",
        tenure_semesters=1,
        window_start=date(2026, 8, 31),
        window_end=min(SEMESTER_END, AS_OF.date()),  # capped at as_of, as in ranked_members
    )


def status(key, due, completion, owners, *, project="p1"):
    value = {"done": 1.0, "partial": 0.5, "not_done": 0.0}[completion]
    return TaskStatusRow(
        task_id=f"id-{key}",
        project_pk=project,
        task_key=key,
        due_date=date.fromisoformat(due) if due else None,
        completion=completion,
        completion_value=value,
        owner_pks=list(owners),
    )


def override(key, set_at, *, completion=None, owners=None, override_id=None):
    return TaskOverrideRow(
        override_id=override_id or f"o-{key}-{set_at}",
        task_id=f"id-{key}",
        completion=completion,
        owner_pks=owners,
        set_at=datetime.fromisoformat(set_at).replace(tzinfo=NY),
    )


# The card's worked example.
TASKS = [
    status("T1", "2026-10-01", "done", ["A"]),
    status("T2", "2026-10-15", "done", ["A", "B"]),
    status("T3", "2026-11-01", "partial", ["B"]),
    status("T4", "2026-11-05", "not_done", []),
    status("T5", "2026-12-01", "done", ["A"]),  # not due yet
]
MEMBERS = [member("A"), member("B"), member("C"), member("L", "tech_lead")]


def run(members=MEMBERS, statuses=TASKS, overrides=(), matches=(), *, project_run_id="pr-1",
        as_of=AS_OF, semester_end=SEMESTER_END):
    values = compute_run_delivery_metrics(
        members, RUBRIC, as_of, project_run_id, {"p1": semester_end, "p2": semester_end},
        statuses, overrides, matches,
    )
    return {(value.authentik_user_pk, value.metric_key): value for value in values}


def test_the_worked_example():
    values = run()

    assert values["A", "verified_completion"].raw_value == 1.0
    assert values["B", "verified_completion"].raw_value == 0.75
    assert values["L", "team_verified_completion"].raw_value == 0.625
    assert values["L", "team_verified_completion"].evidence["due_task_count"] == 4
    assert [task["task_key"] for task in values["A", "verified_completion"].evidence["tasks"]] == [
        "T1", "T2",
    ]


def test_partial_credit_counts_half():
    tasks = apply_overrides(TASKS, [], AS_OF)

    assert mean_completion([task for task in tasks if task.task_key == "T3"]) == 0.5
    assert mean_completion([]) is None


def test_each_role_gets_its_own_delivery_row_and_bucket():
    values = run()

    assert {key for key in values} == {
        ("A", "verified_completion"),
        ("B", "verified_completion"),
        ("C", "verified_completion"),
        ("L", "team_verified_completion"),
    }
    assert values["A", "verified_completion"].bucket_key == "delivery"
    assert values["L", "team_verified_completion"].bucket_key == "team_delivery"


def test_an_override_replaces_completion_and_owners():
    values = run(overrides=[override("T4", "2026-11-07", completion="done", owners=["C"])])

    assert values["C", "verified_completion"].raw_value == 1.0
    assert values["L", "team_verified_completion"].raw_value == 0.875  # (1 + 1 + 0.5 + 1) / 4
    assert values["C", "verified_completion"].evidence["tasks"][0]["overridden"] is True


def test_an_override_set_after_as_of_is_ignored():
    values = run(overrides=[override("T4", "2026-11-09", completion="done", owners=["C"])])

    assert values["C", "verified_completion"].missing_reason == "no_owned_tasks"
    assert values["L", "team_verified_completion"].raw_value == 0.625


def test_the_latest_override_wins():
    overrides = [
        override("T3", "2026-11-06", completion="not_done"),
        override("T3", "2026-11-07", completion="done"),
        override("T3", "2026-11-05", completion="partial"),
    ]

    values = run(overrides=overrides)

    assert values["B", "verified_completion"].raw_value == 1.0  # T2 done, T3 now done


def test_partial_and_not_done_overrides_use_their_completion_values():
    values = run(overrides=[
        override("T1", "2026-11-07", completion="partial"),
        override("T2", "2026-11-07", completion="not_done"),
    ])

    assert values["A", "verified_completion"].raw_value == 0.25  # (0.5 + 0) / 2
    assert values["B", "verified_completion"].raw_value == 0.25  # (0 + 0.5) / 2


def test_an_override_set_exactly_at_as_of_counts():
    values = run(overrides=[override("T4", "2026-11-08T12:00", completion="done", owners=["C"])])

    assert values["C", "verified_completion"].raw_value == 1.0


def test_overrides_set_at_the_same_moment_have_a_fixed_winner():
    tied = [
        override("T3", "2026-11-07", completion="done", override_id="o-1"),
        override("T3", "2026-11-07", completion="not_done", override_id="o-2"),
    ]

    for overrides in (tied, tied[::-1]):
        assert run(overrides=overrides)["B", "verified_completion"].raw_value == 0.5  # (1 + 0) / 2


def test_a_completion_only_override_keeps_the_owners():
    (task,) = apply_overrides(
        [status("T3", "2026-11-01", "partial", ["B"])],
        [override("T3", "2026-11-07", completion="done")],
        AS_OF,
    )

    assert task.completion == "done" and task.completion_value == 1.0
    assert task.owner_pks == {"B"}


def test_an_empty_owner_override_removes_every_owner():
    values = run(overrides=[override("T3", "2026-11-07", owners=[])])

    assert values["B", "verified_completion"].raw_value == 1.0  # only T2 left


def test_a_task_due_today_counts_and_one_due_tomorrow_does_not():
    values = run(statuses=[
        status("D1", "2026-11-08", "done", ["A"]),
        status("D2", "2026-11-09", "not_done", ["A"]),
    ])

    assert values["A", "verified_completion"].raw_value == 1.0
    assert values["L", "team_verified_completion"].evidence["due_task_count"] == 1


def test_today_is_the_club_date_not_the_utc_date():
    # 03:00 UTC on 11-09 is still 22:00 on 11-08 in New York.
    as_of = datetime(2026, 11, 9, 3, tzinfo=timezone.utc)

    values = run(statuses=[status("D2", "2026-11-09", "done", ["A"])], as_of=as_of)

    assert values["A", "verified_completion"].missing_reason == "no_owned_tasks"
    assert values["L", "team_verified_completion"].missing_reason == "no_due_tasks"


def test_a_task_without_a_due_date_counts_only_once_the_semester_ends():
    tasks = apply_overrides([status("T6", None, "done", ["A"])], [], AS_OF)

    assert due_tasks(tasks, date(2026, 12, 10), SEMESTER_END) == []
    assert due_tasks(tasks, date(2026, 12, 11), SEMESTER_END) == tasks
    assert due_tasks(tasks, date(2026, 12, 20), SEMESTER_END) == tasks


def test_the_real_semester_end_decides_not_the_members_capped_window():
    # The member's window_end is capped at as_of (11-08), which would make the
    # undated task look due; the project's real end (12-11) has not passed.
    values = run(statuses=[status("T6", None, "done", ["A"])])

    assert values["A", "verified_completion"].missing_reason == "no_owned_tasks"
    assert values["L", "team_verified_completion"].missing_reason == "no_due_tasks"

    ended = run(statuses=[status("T6", None, "done", ["A"])], semester_end=date(2026, 11, 8))
    assert ended["A", "verified_completion"].raw_value == 1.0


def test_an_engineer_owning_no_due_tasks_has_no_value():
    value = run()["C", "verified_completion"]

    assert value.raw_value is None
    assert value.missing_reason == "no_owned_tasks"
    assert value.evidence["tasks"] == []


def test_a_null_project_run_gives_no_sow_for_both_roles():
    # Real tasks, so only the missing project run can cause no_sow.
    values = run(project_run_id=None)

    assert {value.missing_reason for value in values.values()} == {"no_sow"}
    assert all(value.raw_value is None for value in values.values())


def test_a_project_without_tasks_in_the_run_has_no_sow():
    values = run(members=[member("D", project="p2"), member("M", "tech_lead", project="p2")])

    assert values["D", "verified_completion"].missing_reason == "no_sow"
    assert values["M", "team_verified_completion"].missing_reason == "no_sow"


def test_a_project_with_nothing_due_yet_has_no_due_tasks():
    values = run(statuses=[status("T5", "2026-12-01", "done", ["A"])])

    assert values["L", "team_verified_completion"].missing_reason == "no_due_tasks"
    assert values["A", "verified_completion"].missing_reason == "no_owned_tasks"


def test_tasks_of_another_project_are_not_counted():
    values = run(statuses=[*TASKS, status("X1", "2026-10-01", "not_done", ["A"], project="p2")])

    assert values["A", "verified_completion"].raw_value == 1.0
    assert values["L", "team_verified_completion"].raw_value == 0.625


def test_evidence_lists_tasks_statuses_and_matched_prs():
    matches = [
        TaskMatchRow("id-T1", "SpaceApp", "api", 12),
        TaskMatchRow("id-T1", "SpaceApp", "web", 3),
        TaskMatchRow("id-T2", "SpaceApp", "api", 15),
    ]

    evidence = run(matches=matches)["A", "verified_completion"].evidence

    assert evidence == {
        "today": "2026-11-08",
        "project_run_id": "pr-1",
        "due_task_count": 4,
        "tasks": [
            {
                "task_key": "T1",
                "completion": "done",
                "completion_value": 1.0,
                "due_date": "2026-10-01",
                "overridden": False,
                "pull_requests": ["SpaceApp/api#12", "SpaceApp/web#3"],
            },
            {
                "task_key": "T2",
                "completion": "done",
                "completion_value": 1.0,
                "due_date": "2026-10-15",
                "overridden": False,
                "pull_requests": ["SpaceApp/api#15"],
            },
        ],
    }
