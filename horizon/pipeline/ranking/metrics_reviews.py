"""Pull request review and collaboration metrics (T4.3): pure functions over plain rows.

Reads T1.1's latest-state PR tables, so every event is filtered by time:
W start is midnight on window_start in New York and E is the earlier of as_of
and the last instant of the project's real window end. PR authors, reviewers
and requested reviewers arrive already resolved to Authentik pks by T1.1.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, datetime, time, timezone
from statistics import median

from .members import CLUB_TIMEZONE, ProjectMemberRow, RankedMember
from .metrics_code import (
    NO_PROJECT_REPOSITORIES,
    WINDOW_NOT_STARTED,
    Measurement,
    MetricValue,
    ProjectContext,
    slug,
)
from .rubric import RoleRubric, Rubric

NO_REVIEW_REQUESTS = "no_review_requests"
NO_ENGINEER_PRS = "no_engineer_prs"

COUNTING_STATES = frozenset({"APPROVED", "REQUEST_CHANGES", "COMMENT"})

# A Co-authored-by trailer line (T4.3): "Co-authored-by: Name <email>".
CO_AUTHOR_TRAILER = re.compile(r"^co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$", re.IGNORECASE | re.MULTILINE)


def _utc(moment: datetime | None) -> datetime | None:
    """The same instant in UTC.

    Python compares and subtracts two datetimes that share a tzinfo by their
    wall-clock fields, so across a daylight-saving change two New York times
    are an hour off. psycopg returns New York datetimes whenever the database
    session's TimeZone is America/New_York, so every timestamp is normalized
    to UTC before it is compared or subtracted.
    """

    return None if moment is None else moment.astimezone(timezone.utc)

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
    message: str = ""


@dataclass(frozen=True)
class ReviewWindow:
    start: datetime  # W start: midnight on window_start in New York
    end: datetime  # E: min(as_of, the last instant of the window end)

    @property
    def started(self) -> bool:
        return self.end >= self.start

    def contains(self, moment: datetime | None) -> bool:
        return moment is not None and self.start <= moment <= self.end


def review_window(window_start: date, window_end: date, as_of: datetime) -> ReviewWindow:
    if as_of.tzinfo is None:
        raise ValueError("as_of must be timezone-aware")
    return ReviewWindow(
        start=_utc(datetime.combine(window_start, time.min, CLUB_TIMEZONE)),
        end=_utc(min(as_of, datetime.combine(window_end, time.max, CLUB_TIMEZONE))),
    )


@dataclass(frozen=True)
class ReviewData:
    """One run's PR events, indexed by pull request."""

    pull_requests: Mapping[PullRequestKey, PullRequestRow]
    reviews: Mapping[PullRequestKey, tuple[ReviewRow, ...]]
    requests: tuple[ReviewRequestRow, ...]
    commit_authors: Mapping[PullRequestKey, frozenset[str]]
    # Roster members named in the PR's Co-authored-by trailers, by pk.
    co_authors: Mapping[PullRequestKey, frozenset[str]] = field(default_factory=dict)
    # Every pk on the season roster; None when no roster was given (no filter).
    roster_pks: frozenset[str] | None = None

    @classmethod
    def build(
        cls,
        pull_requests: Iterable[PullRequestRow],
        reviews: Iterable[ReviewRow],
        requests: Iterable[ReviewRequestRow],
        commits: Iterable[PullRequestCommitRow],
        source_runs: Mapping[str, str],
        roster: Sequence[ProjectMemberRow] | None = None,
    ) -> ReviewData:
        """Commits count only from the run recorded for their repository.

        With a roster, trailer emails resolve to roster members by their
        directory email (case-insensitive), and contributors are limited to
        roster pks, as T4.3 specifies.
        """

        by_pr: dict[PullRequestKey, list[ReviewRow]] = {}
        for review in reviews:
            review = replace(review, submitted_at=_utc(review.submitted_at))
            by_pr.setdefault((review.organization, review.repository, review.pr_number), []).append(
                review
            )
        by_email = {
            row.email.strip().casefold(): row.authentik_user_pk
            for row in roster or ()
            if row.email and row.email.strip()
        }
        authors: dict[PullRequestKey, set[str]] = {}
        co_authors: dict[PullRequestKey, set[str]] = {}
        for commit in commits:
            repository = (commit.organization, commit.repository)
            if source_runs.get(slug(repository)) != commit.dagster_run_id:
                continue
            key = (*repository, commit.pull_request_number)
            if commit.authentik_user_pk:
                authors.setdefault(key, set()).add(commit.authentik_user_pk)
            for _name, email in CO_AUTHOR_TRAILER.findall(commit.message or ""):
                pk = by_email.get(email.strip().casefold())
                if pk:
                    co_authors.setdefault(key, set()).add(pk)
        return cls(
            pull_requests={
                pr.key: replace(pr, created_at=_utc(pr.created_at), merged_at=_utc(pr.merged_at))
                for pr in pull_requests
            },
            reviews={key: tuple(rows) for key, rows in by_pr.items()},
            requests=tuple(replace(request, requested_at=_utc(request.requested_at)) for request in requests),
            commit_authors={key: frozenset(pks) for key, pks in authors.items()},
            co_authors={key: frozenset(pks) for key, pks in co_authors.items()},
            roster_pks=None if roster is None else frozenset(row.authentik_user_pk for row in roster),
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

    Contributors are the PR author, the resolved authors of the PR's commits and
    the roster members named in its Co-authored-by trailers, limited to the
    season roster.
    """

    collaborative = []
    for pr in data.project_pull_requests(project):
        if not (pr.merged and window.contains(pr.merged_at)):
            continue
        contributors = {
            pr.author_pk, *data.commit_authors.get(pr.key, ()), *data.co_authors.get(pr.key, ())
        } - {None}
        if data.roster_pks is not None:
            contributors &= data.roster_pks
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
        if not window.started:
            # An as_of before window_start leaves nothing to count; a 0 would
            # read as "reviewed nothing".
            return Measurement(
                None, WINDOW_NOT_STARTED, {"window_start": member.window_start.isoformat()}
            )
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
