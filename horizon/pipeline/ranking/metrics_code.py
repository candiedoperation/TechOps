"""Code, consistency and tenure metrics (T4.2): pure functions over plain rows.

Each metric follows the formula in the T4.2 spec. Blame-based inputs
(``engineering_contribution``, ``blame_commit_summary``) are pinned to the
pipeline run recorded per repository in ``ranking_runs.source_runs``; commit
history (``member_commit_activity``, ``git_commits``) is latest-state, so it is
filtered by date instead. Missing data is a NULL value with a reason, never 0.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from .members import CLUB_TIMEZONE, RankedMember
from .rubric import RoleRubric, Rubric

NO_RESOLVED_GIT_IDENTITY = "no_resolved_git_identity"
NO_ELIGIBLE_LINES = "no_eligible_lines"
SEMESTER_NOT_FINISHED = "semester_not_finished"
# Not in the spec: an as_of before window_start leaves no weeks to measure.
WINDOW_NOT_STARTED = "window_not_started"
# Not in the spec: keeps a project without repositories from reading as an
# identity problem for every member.
NO_PROJECT_REPOSITORIES = "no_project_repositories"

END_LOADING_DAYS = 21

OWN_CODE_METRICS = ("files_majority_owned", "non_boundary_lines", "surviving_commits")
ACTIVITY_METRICS = ("active_week_ratio", "longest_inactive_stretch")
# Every metric this module writes. Re-running replaces only these keys, so the
# rows of other Track 4 metric steps in the same run are left alone.
METRIC_KEYS = (*OWN_CODE_METRICS, *ACTIVITY_METRICS, "team_end_loading", "tenure_semesters")

Repository = tuple[str, str]


@dataclass(frozen=True)
class ContributionRow:
    """The columns of ``horizon_gt_features.engineering_contribution`` read here."""

    run_id: str
    organization: str
    repository: str
    authentik_user_pk: str | None
    majority_owned_files: int
    non_boundary_surviving_lines: int


@dataclass(frozen=True)
class BlameCommitRow:
    """The columns of ``horizon_gt_features.blame_commit_summary`` (T2.5) read here."""

    run_id: str
    organization: str
    repository: str
    blamed_file_path: str
    commit_sha: str
    authentik_user_pk: str | None
    eligible: bool
    line_count: int


@dataclass(frozen=True)
class CommitActivityRow:
    """The columns of the ``horizon_gt_features.member_commit_activity`` view (T2.6)."""

    organization: str
    repository: str
    commit_sha: str
    authentik_user_pk: str
    credit: str
    activity_at: datetime
    source: str
    eligible_lines_changed: int | None  # NULL for pr_branch rows


@dataclass(frozen=True)
class GitCommitRow:
    """The columns of ``horizon_gt_features.git_commits`` (T2.6) read here."""

    organization: str
    repository: str
    commit_sha: str
    authentik_user_pk: str | None
    authored_at: datetime
    eligible_lines_added: int
    on_default_branch: bool


@dataclass(frozen=True)
class ProjectContext:
    """What every metric needs to know about the member's project P."""

    project_pk: str
    repositories: tuple[Repository, ...]  # R(P)
    source_runs: Mapping[str, str]  # "org/repo" -> pipeline run id, for R(P)
    semester_end: date  # projects.window_end, the real end of the window
    team: frozenset[str]  # team(P): the run's ranked members on P

    def __post_init__(self) -> None:
        missing = [slug(repo) for repo in self.repositories if slug(repo) not in self.source_runs]
        if missing:
            raise ValueError(
                f"No source run recorded for {', '.join(missing)} in project "
                f"{self.project_pk!r}; ranking_run should have failed this run."
            )

    def has_repository(self, organization: str, repository: str) -> bool:
        return (organization, repository) in self.repositories

    def is_source_run(self, organization: str, repository: str, run_id: str) -> bool:
        return (
            self.has_repository(organization, repository)
            and self.source_runs[f"{organization}/{repository}"] == run_id
        )


@dataclass(frozen=True)
class Measurement:
    raw_value: float | None
    missing_reason: str | None = None
    evidence: dict = field(default_factory=dict)


@dataclass(frozen=True)
class MetricValue:
    """One ``horizon_ranking.metric_values`` row, minus the run id."""

    authentik_user_pk: str
    project_pk: str
    bucket_key: str
    metric_key: str
    raw_value: float | None
    missing_reason: str | None
    evidence: dict

    def __post_init__(self) -> None:
        if (self.raw_value is None) == (self.missing_reason is None):
            raise ValueError(
                f"{self.metric_key}: set exactly one of raw_value and missing_reason"
            )


def slug(repository: Repository) -> str:
    return f"{repository[0]}/{repository[1]}"


def local_date(moment: datetime) -> date:
    if moment.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return moment.astimezone(CLUB_TIMEZONE).date()


def iso_week(day: date) -> tuple[int, int]:
    year, week, _ = day.isocalendar()
    return year, week


def iso_weeks(start: date, end: date) -> set[tuple[int, int]]:
    """Every ISO week the inclusive range touches; partial weeks count."""

    return {iso_week(start + timedelta(days=offset)) for offset in range((end - start).days + 1)}


def _missing(reason: str, evidence: dict) -> Measurement:
    return Measurement(None, reason, evidence)


def _week_label(week: tuple[int, int]) -> str:
    return f"{week[0]}-W{week[1]:02d}"


# Blame-based metrics, pinned to the source runs.


def files_majority_owned(
    member_pk: str, project: ProjectContext, contributions: Iterable[ContributionRow]
) -> Measurement:
    per_repository = Counter()
    for row in contributions:
        if row.authentik_user_pk == member_pk and project.is_source_run(
            row.organization, row.repository, row.run_id
        ):
            per_repository[f"{row.organization}/{row.repository}"] += row.majority_owned_files
    return Measurement(
        sum(per_repository.values()), evidence={"per_repository": dict(per_repository)}
    )


def non_boundary_lines(
    member_pk: str, project: ProjectContext, contributions: Iterable[ContributionRow]
) -> Measurement:
    per_repository = Counter()
    for row in contributions:
        if row.authentik_user_pk == member_pk and project.is_source_run(
            row.organization, row.repository, row.run_id
        ):
            per_repository[f"{row.organization}/{row.repository}"] += (
                row.non_boundary_surviving_lines
            )
    total = sum(per_repository.values())
    # Percentiles do not change under log scaling, so ranking uses the raw sum;
    # the log value is only for display.
    return Measurement(
        total, evidence={"per_repository": dict(per_repository), "log1p": math.log1p(total)}
    )


def _surviving_rows(
    member_pk: str, project: ProjectContext, blame_rows: Iterable[BlameCommitRow]
) -> list[BlameCommitRow]:
    """S restricted to the member: eligible rows of the source runs for R(P)."""

    return [
        row
        for row in blame_rows
        if row.eligible
        and row.authentik_user_pk == member_pk
        and project.is_source_run(row.organization, row.repository, row.run_id)
    ]


def surviving_commits(
    member_pk: str, project: ProjectContext, blame_rows: Iterable[BlameCommitRow]
) -> Measurement:
    rows = _surviving_rows(member_pk, project, blame_rows)
    # A commit that touches several files counts once.
    commits = {(row.organization, row.repository, row.commit_sha) for row in rows}
    per_repository = Counter(f"{org}/{repo}" for org, repo, _ in commits)
    return Measurement(
        len(commits),
        evidence={
            "per_repository": dict(per_repository),
            "surviving_lines": sum(row.line_count for row in rows),
        },
    )


# Activity metrics, from latest-state commit history filtered by date.


def _counted_activity(
    member_pk: str,
    project: ProjectContext,
    window_start: date,
    measured_until: date,
    activity: Iterable[CommitActivityRow],
) -> list[CommitActivityRow]:
    """The rows counted in A(m). pr_branch rows always count; default_branch
    rows only when they changed eligible lines (a lockfile-only commit does not).
    """

    return [
        row
        for row in activity
        if row.authentik_user_pk == member_pk
        and project.has_repository(row.organization, row.repository)
        and window_start <= local_date(row.activity_at) <= measured_until
        and (row.source == "pr_branch" or (row.eligible_lines_changed or 0) > 0)
    ]


def active_week_ratio(
    member_pk: str,
    project: ProjectContext,
    window_start: date,
    measured_until: date,
    activity: Iterable[CommitActivityRow],
) -> Measurement:
    if measured_until < window_start:
        return _missing(WINDOW_NOT_STARTED, {"window_start": window_start.isoformat()})
    rows = _counted_activity(member_pk, project, window_start, measured_until, activity)
    window_weeks = iso_weeks(window_start, measured_until)
    active = {iso_week(local_date(row.activity_at)) for row in rows}
    return Measurement(
        len(active) / len(window_weeks),
        evidence={
            "active_weeks": [_week_label(week) for week in sorted(active)],
            "weeks_in_window": len(window_weeks),
            "rows_by_source": dict(Counter(row.source for row in rows)),
        },
    )


def longest_inactive_stretch(
    member_pk: str,
    project: ProjectContext,
    window_start: date,
    measured_until: date,
    activity: Iterable[CommitActivityRow],
) -> Measurement:
    """Longest gap in days between activity dates, counting the gap from
    window_start to the first activity date and the gap from the last one to
    the end of the measured window (E).

    The trailing gap counts because it is real inactivity: without it, a member
    active only in the first weeks scored better than one who kept going.
    """

    if measured_until < window_start:
        return _missing(WINDOW_NOT_STARTED, {"window_start": window_start.isoformat()})
    rows = _counted_activity(member_pk, project, window_start, measured_until, activity)
    dates = sorted({local_date(row.activity_at) for row in rows})
    if not dates:
        return Measurement(
            (measured_until - window_start).days,
            evidence={
                "gap_start": window_start.isoformat(),
                "gap_end": measured_until.isoformat(),
                "activity_dates": 0,
            },
        )
    longest, bounds = -1, (window_start, dates[0])
    previous = window_start
    for day in [*dates, measured_until]:
        if (day - previous).days > longest:
            longest, bounds = (day - previous).days, (previous, day)
        previous = day
    return Measurement(
        longest,
        evidence={
            "gap_start": bounds[0].isoformat(),
            "gap_end": bounds[1].isoformat(),
            "activity_dates": len(dates),
        },
    )


def team_end_loading(
    project: ProjectContext,
    window_start: date,
    as_of: datetime,
    commits: Iterable[GitCommitRow],
) -> Measurement:
    """Share of the team's eligible lines added in the last 21 days of the window."""

    window_end = project.semester_end
    late_start = window_end - timedelta(days=END_LOADING_DAYS - 1)
    window = {"late_start": late_start.isoformat(), "window_end": window_end.isoformat()}
    if local_date(as_of) < window_end:
        return _missing(SEMESTER_NOT_FINISHED, window)
    team_commits = [
        commit
        for commit in commits
        if commit.on_default_branch
        and project.has_repository(commit.organization, commit.repository)
        and commit.authentik_user_pk in project.team
        and window_start <= local_date(commit.authored_at) <= window_end
    ]
    total = sum(commit.eligible_lines_added for commit in team_commits)
    late = sum(
        commit.eligible_lines_added
        for commit in team_commits
        if local_date(commit.authored_at) >= late_start
    )
    evidence = {**window, "late_lines": late, "total_lines": total, "commits": len(team_commits)}
    if total == 0:
        return _missing(NO_ELIGIBLE_LINES, evidence)
    return Measurement(late / total, evidence=evidence)


# Putting it together for one member and one run.


def compute_member_metrics(
    member: RankedMember,
    project: ProjectContext,
    as_of: datetime,
    role_rubric: RoleRubric,
    *,
    contributions: Sequence[ContributionRow],
    blame_rows: Sequence[BlameCommitRow],
    activity: Sequence[CommitActivityRow],
    commits: Sequence[GitCommitRow],
) -> list[MetricValue]:
    """The member's rows for every metric of their role rubric that this module owns.

    ``member.window_end`` is already capped at the as_of date (E), so it bounds
    the activity metrics; team_end_loading uses the project's real window end.
    """

    pk = member.authentik_user_pk
    window_start, measured_until = member.window_start, member.window_end
    has_git_identity = bool(_surviving_rows(pk, project, blame_rows)) or any(
        row.authentik_user_pk == pk
        and project.has_repository(row.organization, row.repository)
        and row.activity_at <= as_of
        for row in activity
    )

    def measure(metric_key: str) -> Measurement:
        if metric_key == "tenure_semesters":
            return Measurement(
                member.tenure_semesters,
                evidence={"source": "project_members.tenure_semesters"},
            )
        if not project.repositories:
            return _missing(NO_PROJECT_REPOSITORIES, {})
        if metric_key == "team_end_loading":
            # A team metric: computed even when the lead's own commits do not
            # resolve, since the rest of the team's still do.
            return team_end_loading(project, window_start, as_of, commits)
        if not has_git_identity:
            return _missing(NO_RESOLVED_GIT_IDENTITY, {})
        if metric_key == "files_majority_owned":
            return files_majority_owned(pk, project, contributions)
        if metric_key == "non_boundary_lines":
            return non_boundary_lines(pk, project, contributions)
        if metric_key == "surviving_commits":
            return surviving_commits(pk, project, blame_rows)
        if metric_key == "active_week_ratio":
            return active_week_ratio(pk, project, window_start, measured_until, activity)
        return longest_inactive_stretch(pk, project, window_start, measured_until, activity)

    values = []
    for bucket in role_rubric.buckets:
        for metric in bucket.metrics:
            if metric.key not in METRIC_KEYS:
                continue
            measured = measure(metric.key)
            values.append(
                MetricValue(
                    authentik_user_pk=pk,
                    project_pk=member.project_pk,
                    bucket_key=bucket.key,
                    metric_key=metric.key,
                    raw_value=measured.raw_value,
                    missing_reason=measured.missing_reason,
                    evidence={"source_runs": dict(project.source_runs), **measured.evidence},
                )
            )
    return values


def build_project_contexts(
    members: Sequence[RankedMember],
    repositories_by_project: Mapping[str, Sequence[Repository]],
    source_runs: Mapping[str, str],
    semester_ends: Mapping[str, date],
) -> dict[str, ProjectContext]:
    """One context per project with ranked members; team(P) is the run snapshot."""

    teams: dict[str, set[str]] = defaultdict(set)
    for member in members:
        teams[member.project_pk].add(member.authentik_user_pk)
    contexts = {}
    for project_pk, team in teams.items():
        if project_pk not in semester_ends:
            raise ValueError(f"Project {project_pk!r} has ranked members but no projects row.")
        repositories = tuple(sorted(set(repositories_by_project.get(project_pk, ()))))
        contexts[project_pk] = ProjectContext(
            project_pk=project_pk,
            repositories=repositories,
            source_runs={
                slug(repo): source_runs[slug(repo)]
                for repo in repositories
                if slug(repo) in source_runs
            },
            semester_end=semester_ends[project_pk],
            team=frozenset(team),
        )
    return contexts


def compute_run_metrics(
    members: Sequence[RankedMember],
    projects: Mapping[str, ProjectContext],
    as_of: datetime,
    rubric: Rubric,
    *,
    contributions: Sequence[ContributionRow],
    blame_rows: Sequence[BlameCommitRow],
    activity: Sequence[CommitActivityRow],
    commits: Sequence[GitCommitRow],
) -> list[MetricValue]:
    """Every ranked member's code, consistency and tenure rows for one run."""

    contributions_by_member = _group_by_member(contributions)
    blame_by_member = _group_by_member(blame_rows)
    activity_by_member = _group_by_member(activity)
    values = []
    for member in members:
        pk = member.authentik_user_pk
        values.extend(
            compute_member_metrics(
                member,
                projects[member.project_pk],
                as_of,
                rubric.roles[member.role],
                contributions=contributions_by_member.get(pk, []),
                blame_rows=blame_by_member.get(pk, []),
                activity=activity_by_member.get(pk, []),
                commits=commits,
            )
        )
    return values


def _group_by_member(rows: Iterable) -> dict[str | None, list]:
    grouped = defaultdict(list)
    for row in rows:
        grouped[row.authentik_user_pk].append(row)
    return grouped
