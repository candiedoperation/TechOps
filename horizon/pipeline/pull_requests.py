"""Deterministic review aggregation and PR-linked commit records."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .identity import IdentityCluster
    from .resources import AuthentikRoster, PullRequestCommit, PullRequestReviewSnapshot


@dataclass(frozen=True)
class MemberPRReviewCount:
    """Cumulative Gitea review counts for one canonical member."""

    member_id: str
    reviews_written_count: int
    approvals_given_count: int
    changes_requested_count: int


@dataclass(frozen=True)
class UnresolvedReviewer:
    """A submitted review whose exact Gitea-login roster match is not unique."""

    reviewer_login: str
    pull_request_number: int
    review_id: int
    state: str


@dataclass(frozen=True)
class PullRequestReviewCounts:
    """Aggregate rows plus unresolved reviewer evidence for a Dagster check."""

    rows: list[MemberPRReviewCount]
    unresolved_reviewers: list[UnresolvedReviewer]
    pull_requests_scanned: int
    review_events_observed: int
    submitted_reviews_observed: int
    retrieved_at: datetime


@dataclass(frozen=True)
class PRLinkedCommitMessage:
    """One commit message observed through a specific pull request."""

    organization: str
    repository: str
    pull_request_number: int
    commit_sha: str
    author_name: str
    author_email: str
    authentik_user_pk: str | None
    identity_resolution: str
    candidate_count: int
    committed_at: datetime
    message: str
    dagster_run_id: str


def aggregate_member_pr_review_counts(
    source: PullRequestReviewSnapshot,
    roster: AuthentikRoster,
) -> PullRequestReviewCounts:
    """Count submitted reviews by exact, unique Authentik username ↔ Gitea login.

    The roster is the member baseline, so every roster PK receives exactly one
    output row, including members with zero reviews. Duplicate or missing
    usernames never resolve and are retained in ``unresolved_reviewers``.
    """

    pks_by_username: dict[str, list[str]] = {}
    counts_by_pk: dict[str, list[int]] = {}
    for user in roster.users:
        counts_by_pk[user.authentik_user_pk] = [0, 0, 0]
        if user.username:
            pks_by_username.setdefault(user.username, []).append(user.authentik_user_pk)

    unresolved: list[UnresolvedReviewer] = []
    submitted_count = 0
    for review in source.reviews:
        if not review.is_submitted:
            continue
        submitted_count += 1
        candidates = pks_by_username.get(review.reviewer_login, [])
        if len(candidates) != 1:
            unresolved.append(
                UnresolvedReviewer(
                    reviewer_login=review.reviewer_login,
                    pull_request_number=review.pull_request_number,
                    review_id=review.review_id,
                    state=review.state,
                )
            )
            continue

        counts = counts_by_pk[candidates[0]]
        counts[0] += 1
        if review.state == "APPROVED":
            counts[1] += 1
        elif review.state == "REQUEST_CHANGES":
            counts[2] += 1

    rows = [
        MemberPRReviewCount(
            member_id=member_id,
            reviews_written_count=values[0],
            approvals_given_count=values[1],
            changes_requested_count=values[2],
        )
        for member_id, values in sorted(counts_by_pk.items())
    ]
    return PullRequestReviewCounts(
        rows=rows,
        unresolved_reviewers=unresolved,
        pull_requests_scanned=source.pull_request_count,
        review_events_observed=len(source.reviews),
        submitted_reviews_observed=submitted_count,
        retrieved_at=source.retrieved_at,
    )


def materialize_pr_linked_commit_messages(
    commits: list[PullRequestCommit],
    identity_clusters: list[IdentityCluster],
    dagster_run_id: str,
) -> list[PRLinkedCommitMessage]:
    """Attach the canonical identity resolution and observing run to each commit."""

    identities = {
        (cluster.author_name, cluster.author_email): cluster
        for cluster in identity_clusters
    }
    if len(identities) != len(identity_clusters):
        raise ValueError("identity clusters contain duplicate raw Git identities")

    missing = {
        (commit.author_name, commit.author_email)
        for commit in commits
        if (commit.author_name, commit.author_email) not in identities
    }
    if missing:
        raise ValueError(
            f"identity clusters do not cover {len(missing)} PR commit author identity(ies)"
        )

    return [
        PRLinkedCommitMessage(
            organization=commit.organization,
            repository=commit.repository,
            pull_request_number=commit.pull_request_number,
            commit_sha=commit.commit_sha,
            author_name=commit.author_name,
            author_email=commit.author_email,
            authentik_user_pk=identities[(commit.author_name, commit.author_email)].authentik_user_pk,
            identity_resolution=identities[(commit.author_name, commit.author_email)].match_method,
            candidate_count=identities[(commit.author_name, commit.author_email)].candidate_count,
            committed_at=commit.committed_at,
            message=commit.message,
            dagster_run_id=dagster_run_id,
        )
        for commit in commits
    ]
