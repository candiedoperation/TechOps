"""Gitea pull request review and linked-commit assets."""

# Keep annotations evaluated at decoration time; Dagster resolves them as graph
# inputs and resources.
from dataclasses import asdict

from dagster import AssetExecutionContext, MetadataValue, TableRecord, asset

from ..metadata import table_schema_from
from ..pull_requests import (
    MemberPRReviewCount,
    PRLinkedCommitMessage,
    PullRequestReviewCounts,
    aggregate_member_pr_review_counts,
    materialize_pr_linked_commit_messages,
)
from ..identity import IdentityCluster
from ..resources import (
    AuthentikRoster,
    GiteaClient,
    PullRequestCommit,
    PullRequestReview,
    PullRequestReviewSnapshot,
    Repository,
)


PULL_REQUEST_REVIEW_SCHEMA = table_schema_from(
    PullRequestReview,
    {
        "pull_request_number": ("int", "Source pull request number."),
        "review_id": ("int", "Stable Gitea review ID."),
        "reviewer_login": ("string", "Gitea login, retained for exact roster resolution."),
        "state": ("string", "Gitea review state."),
        "submitted_at": ("datetime?", "UTC submission time; null for pending events."),
    },
)

REVIEW_COUNT_SCHEMA = table_schema_from(
    MemberPRReviewCount,
    {
        "member_id": ("string", "Canonical Authentik user PK."),
        "reviews_written_count": ("int", "Cumulative submitted reviews observed."),
        "approvals_given_count": ("int", "Submitted reviews with state APPROVED."),
        "changes_requested_count": (
            "int",
            "Submitted reviews with state REQUEST_CHANGES.",
        ),
    },
)

PULL_REQUEST_COMMIT_SCHEMA = table_schema_from(
    PullRequestCommit,
    {
        "organization": ("string", "Gitea organization."),
        "repository": ("string", "Gitea repository."),
        "pull_request_number": ("int", "Source pull request number."),
        "commit_sha": ("string", "Commit SHA attached to the pull request."),
        "author_name": ("string", "Git commit author name."),
        "author_email": ("string", "Git commit author email."),
        "committed_at": ("datetime", "UTC committer timestamp from the commit object."),
        "message": ("string", "Full commit message from the PR-linked commit object."),
    },
)

PR_LINKED_COMMIT_MESSAGE_SCHEMA = table_schema_from(
    PRLinkedCommitMessage,
    {
        "organization": ("string", "Gitea organization."),
        "repository": ("string", "Gitea repository."),
        "pull_request_number": ("int", "Source pull request number."),
        "commit_sha": ("string", "Commit SHA attached to the pull request."),
        "author_name": ("string", "Git commit author name."),
        "author_email": ("string", "Git commit author email."),
        "authentik_user_pk": ("string?", "Canonical PK when the author email matches uniquely."),
        "identity_resolution": ("string", "Exact-email match result for this commit author."),
        "candidate_count": ("int", "Number of exact roster email matches."),
        "committed_at": ("datetime", "UTC committer timestamp from the commit object."),
        "message": ("string", "Full commit message available as SOW evidence."),
        "dagster_run_id": ("string", "Latest Dagster run that observed the record."),
    },
)


def _empty_preview(schema):
    return MetadataValue.table(records=[], schema=schema)


def _sample(rows, schema, *, serialize_datetime: bool = False):
    records = []
    for row in rows[:10]:
        item = asdict(row)
        if serialize_datetime:
            for key, value in item.items():
                if hasattr(value, "isoformat"):
                    item[key] = value.isoformat()
        records.append(TableRecord(item))
    return MetadataValue.table(records=records, schema=schema)


@asset(
    group_name="01_sources",
    kinds={"gitea"},
    description=(
        "Fetches every open and closed pull request and all review pages for the "
        "configured repository. Gitea-reported totals and page links are checked "
        "so incomplete snapshots fail the source asset."
    ),
    metadata={
        "endpoint": "GET /repos/{owner}/{repo}/pulls and /pulls/{index}/reviews",
        "pagination": "all pages; X-Total-Count and contiguous Link pages required",
        "state": "all",
    },
)
def gitea_pull_request_reviews(
    context: AssetExecutionContext,
    gitea_repository: Repository,
    gitea: GiteaClient,
) -> PullRequestReviewSnapshot:
    snapshot = gitea.get_pull_request_reviews(gitea_repository)
    context.add_output_metadata(
        {
            "organization": MetadataValue.text(snapshot.organization),
            "repository": MetadataValue.text(snapshot.repository),
            "pull_requests_scanned": MetadataValue.int(snapshot.pull_request_count),
            "review_events_observed": MetadataValue.int(len(snapshot.reviews)),
            "submitted_reviews_observed": MetadataValue.int(
                sum(review.is_submitted for review in snapshot.reviews)
            ),
            "retrieved_at": MetadataValue.text(snapshot.retrieved_at.isoformat()),
            "sample": _sample(
                snapshot.reviews,
                PULL_REQUEST_REVIEW_SCHEMA,
                serialize_datetime=True,
            ),
        }
    )
    return snapshot


@asset(
    group_name="06_pr_metrics",
    kinds={"python"},
    description=(
        "Counts submitted pull request reviews per Authentik member by an exact, "
        "unique username-to-Gitea-login match, then upserts one row per member/run."
    ),
    metadata={
        "dagster/column_schema": REVIEW_COUNT_SCHEMA,
        "preview": _empty_preview(REVIEW_COUNT_SCHEMA),
        "table": "member_pr_review_counts",
        "grain": "one row per member and Dagster run",
        "source": "gitea_pull_request_reviews + authentik_users",
        "identity_match": "exact Gitea reviewer login to unique Authentik username",
    },
)
def member_pr_review_counts(
    context: AssetExecutionContext,
    gitea_pull_request_reviews: PullRequestReviewSnapshot,
    authentik_users: AuthentikRoster,
) -> PullRequestReviewCounts:
    result = aggregate_member_pr_review_counts(
        gitea_pull_request_reviews,
        authentik_users,
    )
    unresolved_logins = sorted(
        {review.reviewer_login for review in result.unresolved_reviewers}
    )
    context.add_output_metadata(
        {
            "rows": MetadataValue.int(len(result.rows)),
            "pull_requests_scanned": MetadataValue.int(result.pull_requests_scanned),
            "review_events_observed": MetadataValue.int(result.review_events_observed),
            "submitted_reviews_observed": MetadataValue.int(
                result.submitted_reviews_observed
            ),
            "unresolved_review_count": MetadataValue.int(
                len(result.unresolved_reviewers)
            ),
            "unresolved_reviewer_logins": MetadataValue.json(unresolved_logins),
            "source_retrieved_at": MetadataValue.text(
                result.retrieved_at.isoformat()
            ),
            "sample": _sample(result.rows, REVIEW_COUNT_SCHEMA),
        }
    )
    return result


@asset(
    group_name="01_sources",
    kinds={"gitea"},
    description=(
        "Fetches only commits returned by Gitea's pull-request commit endpoint; "
        "it does not ingest a repository-wide commit feed."
    ),
    metadata={
        "dagster/column_schema": PULL_REQUEST_COMMIT_SCHEMA,
        "endpoint": "GET /repos/{owner}/{repo}/pulls/{index}/commits",
        "pagination": "all pages; X-Total-Count and contiguous Link pages required",
        "scope": "PR-linked commits only",
    },
)
def gitea_pull_request_commits(
    context: AssetExecutionContext,
    gitea_repository: Repository,
    gitea: GiteaClient,
) -> list[PullRequestCommit]:
    rows = gitea.get_pull_request_commits(gitea_repository)
    context.add_output_metadata(
        {
            "rows": MetadataValue.int(len(rows)),
            "pull_requests_with_commits": MetadataValue.int(
                len({row.pull_request_number for row in rows})
            ),
            "sample": _sample(
                rows,
                PULL_REQUEST_COMMIT_SCHEMA,
                serialize_datetime=True,
            ),
        }
    )
    return rows


@asset(
    group_name="06_pr_metrics",
    kinds={"python"},
    description=(
        "Persists commit messages attached to pull requests as traceable evidence "
        "for future SOW progress analysis, with the Git author mapped through the "
        "same exact-email identity resolver as blame lines."
    ),
    metadata={
        "dagster/column_schema": PR_LINKED_COMMIT_MESSAGE_SCHEMA,
        "preview": _empty_preview(PR_LINKED_COMMIT_MESSAGE_SCHEMA),
        "table": "pr_linked_commit_messages",
        "grain": "one row per organization, repository, pull request, and commit SHA",
        "source": "gitea_pull_request_commits + identity_clusters",
        "upsert_key": "organization, repository, pull_request_number, commit_sha",
    },
)
def pr_linked_commit_messages(
    context: AssetExecutionContext,
    gitea_pull_request_commits: list[PullRequestCommit],
    identity_clusters: list[IdentityCluster],
) -> list[PRLinkedCommitMessage]:
    rows = materialize_pr_linked_commit_messages(
        gitea_pull_request_commits,
        identity_clusters,
        context.run.run_id,
    )
    context.add_output_metadata(
        {
            "rows": MetadataValue.int(len(rows)),
            "pull_requests_with_commits": MetadataValue.int(
                len({row.pull_request_number for row in rows})
            ),
            "sample": _sample(
                rows,
                PR_LINKED_COMMIT_MESSAGE_SCHEMA,
                serialize_datetime=True,
            ),
        }
    )
    return rows


__all__ = [
    "PULL_REQUEST_COMMIT_SCHEMA",
    "PULL_REQUEST_REVIEW_SCHEMA",
    "PR_LINKED_COMMIT_MESSAGE_SCHEMA",
    "REVIEW_COUNT_SCHEMA",
    "gitea_pull_request_commits",
    "gitea_pull_request_reviews",
    "member_pr_review_counts",
    "pr_linked_commit_messages",
]
