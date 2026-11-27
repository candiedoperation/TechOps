"""The Dagster entrypoint: ``dagster dev -m pipeline.definitions``."""

from __future__ import annotations

from dagster import AssetSelection, Definitions, define_asset_job

from .assets import (
    authentik_users,
    blame_capture,
    blame_records,
    eligible_file_ownership,
    engineering_contribution,
    file_ownership,
    gitea_pull_request_commits,
    gitea_pull_request_reviews,
    gitea_repository,
    identity_clusters,
    member_ownership,
    member_pr_review_counts,
    member_repository_ownership,
    pr_linked_commit_messages,
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
    code_and_tenure_metrics,
    delivery_metrics,
    ranked_members,
    ranking_run,
    review_and_rating_metrics,
    member_scores,
    member_scores_integrity,
    member_explanations,
    publish_ranking,
    publish_ranking_integrity,
    gitea_pull_requests,
    peopleportal_projects,
    persist_project_sources,
    project_repositories,
)
from .checks import (
    capture_is_non_empty,
    capture_accounts_for_every_tracked_file,
    git_identity_mappings_need_review,
    roster_is_non_empty,
    records_carry_every_field,
    records_parse_completely,
    pr_reviewers_resolve_or_need_review,
    project_orgs_have_repositories,
    projects_are_non_empty,
    pull_request_pages_are_complete,
)
from .resources import build_resources

PROJECT_SOURCE_ASSETS = [
    peopleportal_projects,
    project_repositories,
    gitea_pull_requests,
    persist_project_sources,
]

# T1.1: season-wide project roster and PR source tables.
ingest_project_sources = define_asset_job(
    "ingest_project_sources",
    selection=AssetSelection.assets(feature_store_schema, *PROJECT_SOURCE_ASSETS),
    description="Projects, members, repositories and every PR/review/review request (T1.1).",
)

# The per-repository blame/ownership graph; blame_run_requests() targets it.
blame_ownership = define_asset_job(
    "blame_ownership",
    selection=AssetSelection.groups(
        "01_sources", "02_capture", "03_parse", "04_identity", "05_ownership",
        "06_pr_metrics", "07_database",
    )
    - AssetSelection.assets(*PROJECT_SOURCE_ASSETS),
    description="Blame, identity, ownership and PR metrics for one repository (config: org, repo).",
)

defs = Definitions(
    jobs=[ingest_project_sources, blame_ownership],
    assets=[
        peopleportal_projects,
        project_repositories,
        gitea_pull_requests,
        persist_project_sources,
        gitea_repository,
        authentik_users,
        blame_capture,
        blame_records,
        file_ownership,
        member_repository_ownership,
        member_ownership,
        identity_clusters,
        eligible_file_ownership,
        engineering_contribution,
        gitea_pull_request_reviews,
        member_pr_review_counts,
        gitea_pull_request_commits,
        pr_linked_commit_messages,
        feature_store_schema,
        pipeline_run_started,
        persist_blame_records,
        persist_authentik_roster_snapshot,
        persist_git_identity_mapping,
        persist_file_ownership,
        persist_member_repository_ownership,
        persist_member_ownership,
        persist_eligible_file_ownership,
        persist_engineering_contribution,
        persist_member_pr_review_counts,
        persist_pr_linked_commit_messages,
        pipeline_run_completed,
        ranking_run,
        ranked_members,
        code_and_tenure_metrics,
        review_and_rating_metrics,
        delivery_metrics,
        member_scores,
        member_explanations,
        publish_ranking,
    ],
    asset_checks=[
        capture_is_non_empty,
        capture_accounts_for_every_tracked_file,
        roster_is_non_empty,
        records_carry_every_field,
        records_parse_completely,
        git_identity_mappings_need_review,
        pr_reviewers_resolve_or_need_review,
        member_scores_integrity,
        publish_ranking_integrity,
        projects_are_non_empty,
        project_orgs_have_repositories,
        pull_request_pages_are_complete,
    ],
    resources=build_resources(),
)
