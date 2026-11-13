"""Asset definitions, one module per layer of the graph.

Layers, not families of convenience: the source layer talks to Gitea, the
capture layer is the only one touching the network and the filesystem, and the
parse layer is pure. Keeping them in separate modules is what lets the pure one
be tested exhaustively without a repo anywhere in sight.

Dagster groups use ordered, plain-language stage names so the UI reads in the
order data moves through it: sources, capture, parse, identity, ownership
metrics, PR metrics, and database. Identity resolution has its own group because
it joins blame records and PR commits to the member roster. Ownership and PR
metrics stay separate because they are distinct branches with different inputs.
"""

from .capture import BlameCapture, blame_capture
from .features import (
    eligible_file_ownership,
    engineering_contribution,
    file_ownership,
    member_ownership,
    member_repository_ownership,
)
from .identity import identity_clusters
from .parse import blame_records
from .pull_requests import (
    gitea_pull_request_commits,
    gitea_pull_request_reviews,
    member_pr_review_counts,
    pr_linked_commit_messages,
)
from .persistence import (
    feature_store_schema,
    pipeline_run_completed,
    pipeline_run_started,
    persist_blame_records,
    persist_authentik_roster_snapshot,
    persist_engineering_contribution,
    persist_eligible_file_ownership,
    persist_file_ownership,
    persist_git_identity_mapping,
    persist_member_ownership,
    persist_member_pr_review_counts,
    persist_member_repository_ownership,
    persist_pr_linked_commit_messages,
)
from .source import RepositoryConfig, authentik_users, gitea_repository

__all__ = [
    "BlameCapture",
    "RepositoryConfig",
    "authentik_users",
    "blame_capture",
    "blame_records",
    "eligible_file_ownership",
    "engineering_contribution",
    "feature_store_schema",
    "pipeline_run_completed",
    "pipeline_run_started",
    "persist_blame_records",
    "file_ownership",
    "gitea_pull_request_commits",
    "gitea_pull_request_reviews",
    "gitea_repository",
    "identity_clusters",
    "member_ownership",
    "member_pr_review_counts",
    "member_repository_ownership",
    "persist_authentik_roster_snapshot",
    "persist_engineering_contribution",
    "persist_eligible_file_ownership",
    "persist_file_ownership",
    "persist_git_identity_mapping",
    "persist_member_ownership",
    "persist_member_pr_review_counts",
    "persist_member_repository_ownership",
    "persist_pr_linked_commit_messages",
    "pr_linked_commit_messages",
]
