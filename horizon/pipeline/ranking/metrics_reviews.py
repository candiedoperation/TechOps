"""Pull request review and collaboration metrics (T4.3): pure functions over plain rows.

Reads T1.1's latest-state PR tables, so every event is filtered by time:
W start is midnight on window_start in New York and E is the earlier of as_of
and the last instant of the project's real window end. PR authors, reviewers
and requested reviewers arrive already resolved to Authentik pks by T1.1.
"""

from __future__ import annotations

from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time
from statistics import median

from .members import CLUB_TIMEZONE, ProjectMemberRow, RankedMember
from .metrics_code import Measurement, MetricValue, ProjectContext, slug
from .rubric import RoleRubric, Rubric

NO_REVIEW_REQUESTS = "no_review_requests"
NO_ENGINEER_PRS = "no_engineer_prs"
NO_PROJECT_REPOSITORIES = "no_project_repositories"

COUNTING_STATES = frozenset({"APPROVED", "REQUEST_CHANGES", "COMMENT"})

# Every review metric this module writes, for either role.
METRIC_KEYS = (
    "prs_reviewed",
    "review_turnaround_hours",
    "collaborative_prs",
    "team_prs_reviewed",
    "review_spread",
)

PullRequestKey = tuple[str, str, int]


@dataclass(frozen=True)
class PullRequestRow:
    """The columns of ``horizon_gt_features.gitea_pull_requests`` (T1.1) read here."""

    organization: str
    repository: str
    number: int
    author_login: str
    author_pk: str | None
    merged: bool
    created_at: datetime
    merged_at: datetime | None

    @property
    def key(self) -> PullRequestKey:
        return self.organization, self.repository, self.number

    @property
    def label(self) -> str:
        return f"{self.organization}/{self.repository}#{self.number}"


@dataclass(frozen=True)
class ReviewRow:
    """The columns of ``horizon_gt_features.gitea_pr_reviews`` (T1.1) read here."""

    organization: str
    repository: str
    pr_number: int
    review_id: int
    reviewer_login: str
    reviewer_pk: str | None
    state: str
    submitted_at: datetime | None


@dataclass(frozen=True)
class ReviewRequestRow:
    """The columns of ``horizon_gt_features.gitea_pr_review_requests`` (T1.1) read here."""

    organization: str
    repository: str
    pr_number: int
    event_id: int
    requested_login: str
    requested_pk: str | None
    requested_at: datetime


@dataclass(frozen=True)
class PullRequestCommitRow:
    """The columns of ``horizon_gt_features.pr_linked_commit_messages`` (T2.4) read here."""

    organization: str
    repository: str
    pull_request_number: int
    commit_sha: str
    authentik_user_pk: str | None
    dagster_run_id: str


@dataclass(frozen=True)
class ReviewWindow:
    start: datetime  # W start: midnight on window_start in New York
    end: datetime  # E: min(as_of, the last instant of the window end)

    def contains(self, moment: datetime | None) -> bool:
        return moment is not None and self.start <= moment <= self.end


def review_window(window_start: date, window_end: date, as_of: datetime) -> ReviewWindow:
    if as_of.tzinfo is None:
        raise ValueError("as_of must be timezone-aware")
    return ReviewWindow(
        start=datetime.combine(window_start, time.min, CLUB_TIMEZONE),
        end=min(as_of, datetime.combine(window_end, time.max, CLUB_TIMEZONE)),
    )


@dataclass(frozen=True)
class ReviewData:
    """One run's PR events, indexed by pull request."""

    pull_requests: Mapping[PullRequestKey, PullRequestRow]
    reviews: Mapping[PullRequestKey, tuple[ReviewRow, ...]]
    requests: tuple[ReviewRequestRow, ...]
    commit_authors: Mapping[PullRequestKey, frozenset[str]]

    @classmethod
    def build(
        cls,
        pull_requests: Iterable[PullRequestRow],
        reviews: Iterable[ReviewRow],
        requests: Iterable[ReviewRequestRow],
        commits: Iterable[PullRequestCommitRow],
        source_runs: Mapping[str, str],
    ) -> ReviewData:
        """Commits count only from the run recorded for their repository."""

        by_pr: dict[PullRequestKey, list[ReviewRow]] = {}
        for review in reviews:
            by_pr.setdefault((review.organization, review.repository, review.pr_number), []).append(
                review
            )
        authors: dict[PullRequestKey, set[str]] = {}
        for commit in commits:
            repository = (commit.organization, commit.repository)
            if commit.authentik_user_pk and source_runs.get(slug(repository)) == commit.dagster_run_id:
                key = (*repository, commit.pull_request_number)
                authors.setdefault(key, set()).add(commit.authentik_user_pk)
        return cls(
            pull_requests={pr.key: pr for pr in pull_requests},
            reviews={key: tuple(rows) for key, rows in by_pr.items()},
            requests=tuple(requests),
            commit_authors={key: frozenset(pks) for key, pks in authors.items()},
        )

    def project_pull_requests(self, project: ProjectContext) -> list[PullRequestRow]:
        return sorted(
            (pr for pr in self.pull_requests.values()
             if project.has_repository(pr.organization, pr.repository)),
            key=lambda pr: pr.key,
        )


def is_counting_review(review: ReviewRow, pr: PullRequestRow) -> bool:
    """A submitted review by someone other than the PR's author; PENDING never counts."""

    if review.state not in COUNTING_STATES or review.submitted_at is None:
        return False
    if review.reviewer_pk is not None and pr.author_pk is not None:
        return review.reviewer_pk != pr.author_pk
    return review.reviewer_login.casefold() != pr.author_login.casefold()


def _counting_reviews_by(
    reviewer_pk: str, pr: PullRequestRow, data: ReviewData
) -> list[ReviewRow]:
    return [
        review
        for review in data.reviews.get(pr.key, ())
        if review.reviewer_pk == reviewer_pk and is_counting_review(review, pr)
    ]


def _reviewed_in_window(
    reviewer_pk: str, pr: PullRequestRow, data: ReviewData, window: ReviewWindow
) -> bool:
    return any(
        window.contains(review.submitted_at)
        for review in _counting_reviews_by(reviewer_pk, pr, data)
    )


def prs_reviewed_by(
    reviewer_pk: str,
    authors: Iterable[str],
    project: ProjectContext,
    data: ReviewData,
    window: ReviewWindow,
) -> Measurement:
    """PRs authored by one of ``authors`` with a counting review by the reviewer in W.

    prs_reviewed passes the member's teammates; team_prs_reviewed the project's
    engineers.
    """

    authors = set(authors)
    reviewed = [
        pr.label
        for pr in data.project_pull_requests(project)
        if pr.author_pk in authors and _reviewed_in_window(reviewer_pk, pr, data, window)
    ]
    return Measurement(len(reviewed), evidence={"pull_requests": reviewed})


def review_turnaround_hours(
    member_pk: str, project: ProjectContext, data: ReviewData, window: ReviewWindow
) -> Measurement:
    """Median hours from each review request to the member's first review after it.

    A request still unanswered at E counts as E minus the request time. A
    re-request after a review is its own request.
    """

    waits = []
    for request in data.requests:
        pr = data.pull_requests.get(
            (request.organization, request.repository, request.pr_number)
        )
        if (
            pr is None
            or request.requested_pk != member_pk
            or not project.has_repository(pr.organization, pr.repository)
            or not window.contains(request.requested_at)
            or pr.author_pk == member_pk
            or pr.author_login.casefold() == request.requested_login.casefold()
        ):
            continue
        answered = min(
            (
                review.submitted_at
                for review in _counting_reviews_by(member_pk, pr, data)
                if review.submitted_at >= request.requested_at
            ),
            default=None,
        )
        if answered is not None and answered <= window.end:
            hours, done = (answered - request.requested_at).total_seconds() / 3600, True
        else:
            hours, done = (window.end - request.requested_at).total_seconds() / 3600, False
        waits.append(
            {
                "pull_request": pr.label,
                "requested_at": request.requested_at.isoformat(),
                "hours": hours,
                "answered": done,
            }
        )
    if not waits:
        return Measurement(None, NO_REVIEW_REQUESTS, {"requests": []})
    return Measurement(median(wait["hours"] for wait in waits), evidence={"requests": waits})


def collaborative_prs(
    member_pk: str, project: ProjectContext, data: ReviewData, window: ReviewWindow
) -> Measurement:
    """Merged PRs in W that the member contributed to, with at least two contributors.

    Contributors are the PR author and the resolved authors of the PR's commits.
    Co-authored-by trailers are not read (a scoping decision for the pilot).
    """

    collaborative = []
    for pr in data.project_pull_requests(project):
        if not (pr.merged and window.contains(pr.merged_at)):
            continue
        contributors = {pr.author_pk, *data.commit_authors.get(pr.key, ())} - {None}
        if member_pk in contributors and len(contributors) >= 2:
            collaborative.append(pr.label)
    return Measurement(len(collaborative), evidence={"pull_requests": collaborative})


def review_spread(
    lead_pk: str,
    engineers: Iterable[str],
    project: ProjectContext,
    data: ReviewData,
    window: ReviewWindow,
) -> Measurement:
    """Share of the project's engineers with a PR in W whose PR the lead reviewed."""

    engineers = set(engineers)
    with_prs: set[str] = set()
    reviewed: set[str] = set()
    for pr in data.project_pull_requests(project):
        if pr.author_pk not in engineers or not window.contains(pr.created_at):
            continue
        with_prs.add(pr.author_pk)
        if _reviewed_in_window(lead_pk, pr, data, window):
            reviewed.add(pr.author_pk)
    evidence = {
        "engineers_with_prs": sorted(with_prs),
        "engineers_reviewed": sorted(reviewed),
    }
    if not with_prs:
        return Measurement(None, NO_ENGINEER_PRS, evidence)
    return Measurement(len(reviewed) / len(with_prs), evidence=evidence)


def compute_member_review_metrics(
    member: RankedMember,
    project: ProjectContext,
    project_members: Sequence[ProjectMemberRow],
    as_of: datetime,
    role_rubric: RoleRubric,
    data: ReviewData,
) -> list[MetricValue]:
    """The member's review rows for their role rubric, skipping excluded buckets.

    Teammates are every other member of the project, any role; the engineers
    are its members with the engineer role, minus the member themself.
    """

    pk = member.authentik_user_pk
    window = review_window(member.window_start, project.semester_end, as_of)
    others = [row for row in project_members if row.authentik_user_pk != pk]
    teammates = [row.authentik_user_pk for row in others]
    engineers = [row.authentik_user_pk for row in others if "engineer" in row.roles]

    def measure(metric_key: str) -> Measurement:
        if not project.repositories:
            return Measurement(None, NO_PROJECT_REPOSITORIES, {})
        if metric_key == "prs_reviewed":
            return prs_reviewed_by(pk, teammates, project, data, window)
        if metric_key == "team_prs_reviewed":
            return prs_reviewed_by(pk, engineers, project, data, window)
        if metric_key == "review_turnaround_hours":
            return review_turnaround_hours(pk, project, data, window)
        if metric_key == "collaborative_prs":
            return collaborative_prs(pk, project, data, window)
        return review_spread(pk, engineers, project, data, window)

    return rubric_rows(member, role_rubric, METRIC_KEYS, measure)


def rubric_rows(
    member: RankedMember,
    role_rubric: RoleRubric,
    metric_keys: Collection[str],
    measure: Callable[[str], Measurement],
) -> list[MetricValue]:
    """One row per rubric metric in ``metric_keys``; buckets the run excluded get none."""

    rows = []
    for bucket in role_rubric.buckets:
        if bucket.key in member.excluded_buckets:
            continue
        for metric in bucket.metrics:
            if metric.key not in metric_keys:
                continue
            measured = measure(metric.key)
            rows.append(
                MetricValue(
                    authentik_user_pk=member.authentik_user_pk,
                    project_pk=member.project_pk,
                    bucket_key=bucket.key,
                    metric_key=metric.key,
                    raw_value=measured.raw_value,
                    missing_reason=measured.missing_reason,
                    evidence=measured.evidence,
                )
            )
    return rows


def compute_run_review_metrics(
    members: Sequence[RankedMember],
    projects: Mapping[str, ProjectContext],
    project_members: Sequence[ProjectMemberRow],
    as_of: datetime,
    rubric: Rubric,
    data: ReviewData,
) -> list[MetricValue]:
    by_project: dict[str, list[ProjectMemberRow]] = {}
    for row in project_members:
        by_project.setdefault(row.project_pk, []).append(row)
    values = []
    for member in members:
        values.extend(
            compute_member_review_metrics(
                member,
                projects[member.project_pk],
                by_project.get(member.project_pk, []),
                as_of,
                rubric.roles[member.role],
                data,
            )
        )
    return values
