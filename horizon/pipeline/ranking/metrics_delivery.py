"""Delivery against the SOW metrics (T4.4): mean completion of the due SOW tasks.

Task status comes from Track 5's project run recorded in
``ranking_runs.project_run_id`` (T5.4's ``sow_task_status``), with the latest
``sow_task_overrides`` row set by the ranking run's as_of applied on top.
Owners are already resolved Authentik pks, so nothing is matched here.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from statistics import fmean

from .members import RankedMember
from .metrics_code import Measurement, MetricValue, local_date
from .metrics_reviews import rubric_rows
from .rubric import RoleRubric, Rubric

NO_SOW = "no_sow"
NO_OWNED_TASKS = "no_owned_tasks"
NO_DUE_TASKS = "no_due_tasks"

# T5.4's mapping from a task's completion to its value.
COMPLETION_VALUES = {"done": 1.0, "partial": 0.5, "not_done": 0.0}

METRIC_KEYS = ("verified_completion", "team_verified_completion")


@dataclass(frozen=True)
class TaskStatusRow:
    """A ``horizon_projects.sow_task_status`` row joined to its ``sow_tasks`` row."""

    task_id: str
    project_pk: str
    task_key: str
    due_date: date | None
    completion: str
    completion_value: float
    owner_pks: Sequence[str]


@dataclass(frozen=True)
class TaskOverrideRow:
    """The columns of ``horizon_projects.sow_task_overrides`` read here."""

    override_id: str
    task_id: str
    completion: str | None  # NULL keeps the status row's completion
    owner_pks: Sequence[str] | None  # NULL keeps the status row's owners
    set_at: datetime


@dataclass(frozen=True)
class TaskMatchRow:
    """The columns of ``horizon_projects.sow_task_matches`` read here."""

    task_id: str
    organization: str
    repository: str
    pr_number: int


@dataclass(frozen=True)
class TaskState:
    """A task as delivery counts it, after the latest override."""

    project_pk: str
    task_key: str
    due_date: date | None
    completion: str
    completion_value: float
    owner_pks: frozenset[str]
    pull_requests: tuple[str, ...] = ()
    overridden: bool = False

    def evidence(self) -> dict:
        return {
            "task_key": self.task_key,
            "completion": self.completion,
            "completion_value": self.completion_value,
            "due_date": self.due_date.isoformat() if self.due_date else None,
            "overridden": self.overridden,
            "pull_requests": list(self.pull_requests),
        }


def apply_overrides(
    statuses: Iterable[TaskStatusRow],
    overrides: Iterable[TaskOverrideRow],
    as_of: datetime,
    matches: Iterable[TaskMatchRow] = (),
) -> list[TaskState]:
    """Each task's state, with the latest override set at or before as_of replacing
    the fields it sets. Overrides set at the same moment (set_at defaults to
    now(), so one transaction's rows tie) are ordered by override_id, so the
    winner doesn't depend on row order."""

    latest: dict[str, TaskOverrideRow] = {}
    for override in overrides:
        if override.set_at > as_of:
            continue
        current = latest.get(override.task_id)
        if current is None or (override.set_at, override.override_id) > (
            current.set_at, current.override_id
        ):
            latest[override.task_id] = override

    pull_requests: dict[str, set[str]] = defaultdict(set)
    for match in matches:
        pull_requests[match.task_id].add(
            f"{match.organization}/{match.repository}#{match.pr_number}"
        )

    tasks = []
    for status in statuses:
        override = latest.get(status.task_id)
        completion, value, owners = status.completion, status.completion_value, status.owner_pks
        if override is not None:
            if override.completion is not None:
                completion = override.completion
                value = COMPLETION_VALUES[completion]
            if override.owner_pks is not None:
                owners = override.owner_pks
        tasks.append(
            TaskState(
                project_pk=status.project_pk,
                task_key=status.task_key,
                due_date=status.due_date,
                completion=completion,
                completion_value=value,
                owner_pks=frozenset(owners),
                pull_requests=tuple(sorted(pull_requests[status.task_id])),
                overridden=override is not None,
            )
        )
    return sorted(tasks, key=lambda task: (task.project_pk, task.task_key))


def due_tasks(tasks: Iterable[TaskState], today: date, semester_end: date) -> list[TaskState]:
    """Tasks due by today; a task without a due date is due once the semester ends."""

    return [
        task
        for task in tasks
        if (task.due_date <= today if task.due_date is not None else today >= semester_end)
    ]


def mean_completion(tasks: Sequence[TaskState]) -> float | None:
    return fmean(task.completion_value for task in tasks) if tasks else None


def _measured(tasks: Sequence[TaskState], reason: str, today: date) -> Measurement:
    evidence = {"today": today.isoformat(), "tasks": [task.evidence() for task in tasks]}
    value = mean_completion(tasks)
    if value is None:
        return Measurement(None, reason, evidence)
    return Measurement(value, evidence=evidence)


def verified_completion(member_pk: str, due: Sequence[TaskState], today: date) -> Measurement:
    owned = [task for task in due if member_pk in task.owner_pks]
    return _measured(owned, NO_OWNED_TASKS, today)


def team_verified_completion(due: Sequence[TaskState], today: date) -> Measurement:
    return _measured(due, NO_DUE_TASKS, today)


def compute_member_delivery_metrics(
    member: RankedMember,
    role_rubric: RoleRubric,
    tasks: Sequence[TaskState],
    *,
    project_run_id: str | None,
    today: date,
    semester_end: date,
) -> list[MetricValue]:
    """``tasks`` are the member's project's tasks in the project run."""

    def measure(key: str) -> Measurement:
        if project_run_id is None or not tasks:
            return Measurement(None, NO_SOW, {"project_run_id": project_run_id})
        due = due_tasks(tasks, today, semester_end)
        if key == "verified_completion":
            measured = verified_completion(member.authentik_user_pk, due, today)
        else:
            measured = team_verified_completion(due, today)
        measured.evidence.update(project_run_id=project_run_id, due_task_count=len(due))
        return measured

    return rubric_rows(member, role_rubric, METRIC_KEYS, measure)


def compute_run_delivery_metrics(
    members: Sequence[RankedMember],
    rubric: Rubric,
    as_of: datetime,
    project_run_id: str | None,
    semester_ends: Mapping[str, date],
    statuses: Iterable[TaskStatusRow],
    overrides: Iterable[TaskOverrideRow],
    matches: Iterable[TaskMatchRow],
) -> list[MetricValue]:
    """``semester_ends`` is each project's real ``projects.window_end``, not the
    member's window end capped at as_of."""

    by_project: dict[str, list[TaskState]] = defaultdict(list)
    for task in apply_overrides(statuses, overrides, as_of, matches):
        by_project[task.project_pk].append(task)
    today = local_date(as_of)
    return [
        value
        for member in members
        for value in compute_member_delivery_metrics(
            member,
            rubric.roles[member.role],
            by_project.get(member.project_pk, []),
            project_run_id=project_run_id,
            today=today,
            semester_end=semester_ends[member.project_pk],
        )
    ]
