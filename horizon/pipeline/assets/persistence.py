"""Database persistence: one Dagster boundary for all Postgres writes.

Every computation asset returns rows in memory and remains independent of the
database. This layer creates the feature schema once, then persists each asset
output in a separately visible Dagster step so connection and SQL failures are
easy to locate and retry.
"""

from dagster import AssetExecutionContext, Failure, MetadataValue, asset

from ..identity import IdentityCluster
from ..ownership import (
    EligibleFileOwnership,
    EngineeringContribution,
    FileOwnership,
    MemberOwnership,
    MemberRepositoryOwnership,
)
from ..pull_requests import (
    PRLinkedCommitMessage,
    PullRequestReviewCounts,
)
from ..blame_parser import BlameRecord
from .capture import BlameCapture
from ..resources import AuthentikRoster, Repository
from ..storage import PostgresResource

_SCHEMA_NAME = "horizon_gt_features"


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description=(
        "Creates the Horizon feature tables and indexes once before any data is "
        "written. A schema failure is isolated from source and calculation steps."
    ),
    metadata={"schema": _SCHEMA_NAME, "ddl_source": "pipeline/schema.sql"},
)
def feature_store_schema(
    context: AssetExecutionContext,
    postgres: PostgresResource,
) -> str:
    postgres.ensure_schema()
    context.add_output_metadata({"schema": MetadataValue.text(_SCHEMA_NAME)})
    return _SCHEMA_NAME


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description=(
        "Opens a run manifest with the exact repository commit, capture totals, "
        "and roster source timestamp. A run remains non-consumable until the "
        "completion asset marks every write successful."
    ),
    metadata={"table": f"{_SCHEMA_NAME}.pipeline_runs"},
)
def pipeline_run_started(
    context: AssetExecutionContext,
    feature_store_schema: str,
    blame_capture: BlameCapture,
    authentik_users: AuthentikRoster,
    postgres: PostgresResource,
) -> str:
    _check_schema(feature_store_schema)
    run_id = context.run.run_id
    postgres.start_pipeline_run(run_id, blame_capture, authentik_users)
    context.add_output_metadata(
        {
            "table": MetadataValue.text(f"{_SCHEMA_NAME}.pipeline_runs"),
            "run_id": MetadataValue.text(run_id),
            "source_commit_sha": MetadataValue.text(blame_capture.source_commit_sha),
            "source_retrieved_at": MetadataValue.text(
                blame_capture.retrieved_at.isoformat()
            ),
            "roster_retrieved_at": MetadataValue.text(
                authentik_users.retrieved_at.isoformat()
            ),
            "status": MetadataValue.text("incomplete"),
        }
    )
    return run_id


def _check_schema(schema_name: str) -> None:
    if schema_name != _SCHEMA_NAME:
        raise Failure(
            description=(
                f"Expected the {_SCHEMA_NAME} schema setup step before persistence; "
                f"received {schema_name!r}."
            )
        )


def _check_run(context: AssetExecutionContext, run_id: str) -> None:
    if run_id != context.run.run_id:
        raise Failure(
            description=(
                f"Persistence run ID {run_id!r} does not match Dagster run "
                f"{context.run.run_id!r}."
            )
        )


def _finish(context: AssetExecutionContext, table: str, rows: int) -> int:
    context.add_output_metadata(
        {
            "table": MetadataValue.text(f"{_SCHEMA_NAME}.{table}"),
            "persisted_rows": MetadataValue.int(rows),
        }
    )
    return rows


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description="Stores the complete Authentik roster snapshot used by this run.",
    metadata={"table": f"{_SCHEMA_NAME}.member_roster_snapshot"},
)
def persist_authentik_roster_snapshot(
    context: AssetExecutionContext,
    feature_store_schema: str,
    pipeline_run_started: str,
    authentik_users: AuthentikRoster,
    postgres: PostgresResource,
) -> int:
    _check_schema(feature_store_schema)
    _check_run(context, pipeline_run_started)
    rows = postgres.write_authentik_roster_snapshot(context.run.run_id, authentik_users)
    return _finish(context, "member_roster_snapshot", rows)


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description=(
        "Bulk-loads one row per parsed blamed source line with its resolved "
        "Authentik PK or explicit unmatched/ambiguous status."
    ),
    metadata={"table": f"{_SCHEMA_NAME}.blame_records", "write_method": "Postgres COPY"},
)
def persist_blame_records(
    context: AssetExecutionContext,
    feature_store_schema: str,
    pipeline_run_started: str,
    blame_records: list[BlameRecord],
    identity_clusters: list[IdentityCluster],
    postgres: PostgresResource,
) -> int:
    _check_schema(feature_store_schema)
    _check_run(context, pipeline_run_started)
    rows = postgres.write_blame_records(
        pipeline_run_started,
        blame_records,
        identity_clusters,
    )
    return _finish(context, "blame_records", rows)


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description="Stores exact Git author email to Authentik PK resolutions and review cases.",
    metadata={"table": f"{_SCHEMA_NAME}.git_identity_mapping"},
)
def persist_git_identity_mapping(
    context: AssetExecutionContext,
    feature_store_schema: str,
    pipeline_run_started: str,
    identity_clusters: list[IdentityCluster],
    postgres: PostgresResource,
) -> int:
    _check_schema(feature_store_schema)
    _check_run(context, pipeline_run_started)
    rows = postgres.write_identity_clusters(context.run.run_id, identity_clusters)
    return _finish(context, "git_identity_mapping", rows)


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description="Stores file-level surviving-line ownership metrics.",
    metadata={"table": f"{_SCHEMA_NAME}.file_ownership"},
)
def persist_file_ownership(
    context: AssetExecutionContext,
    feature_store_schema: str,
    pipeline_run_started: str,
    file_ownership: list[FileOwnership],
    postgres: PostgresResource,
) -> int:
    _check_schema(feature_store_schema)
    _check_run(context, pipeline_run_started)
    rows = postgres.write_file_ownership(context.run.run_id, file_ownership)
    return _finish(context, "file_ownership", rows)


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description="Stores repository-level surviving-line ownership metrics.",
    metadata={"table": f"{_SCHEMA_NAME}.member_repository_ownership"},
)
def persist_member_repository_ownership(
    context: AssetExecutionContext,
    feature_store_schema: str,
    pipeline_run_started: str,
    member_repository_ownership: list[MemberRepositoryOwnership],
    postgres: PostgresResource,
) -> int:
    _check_schema(feature_store_schema)
    _check_run(context, pipeline_run_started)
    rows = postgres.write_member_repository_ownership(
        context.run.run_id,
        member_repository_ownership,
    )
    return _finish(context, "member_repository_ownership", rows)


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description="Stores cross-repository ownership totals for the run.",
    metadata={"table": f"{_SCHEMA_NAME}.member_ownership"},
)
def persist_member_ownership(
    context: AssetExecutionContext,
    feature_store_schema: str,
    pipeline_run_started: str,
    member_ownership: list[MemberOwnership],
    postgres: PostgresResource,
) -> int:
    _check_schema(feature_store_schema)
    _check_run(context, pipeline_run_started)
    rows = postgres.write_member_ownership(context.run.run_id, member_ownership)
    return _finish(context, "member_ownership", rows)


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description="Stores eligible-code file ownership and member identity audit rows.",
    metadata={"table": f"{_SCHEMA_NAME}.eligible_file_ownership"},
)
def persist_eligible_file_ownership(
    context: AssetExecutionContext,
    feature_store_schema: str,
    pipeline_run_started: str,
    eligible_file_ownership: list[EligibleFileOwnership],
    postgres: PostgresResource,
) -> int:
    _check_schema(feature_store_schema)
    _check_run(context, pipeline_run_started)
    rows = postgres.write_eligible_file_ownership(
        context.run.run_id,
        eligible_file_ownership,
    )
    return _finish(context, "eligible_file_ownership", rows)


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description="Stores repository-scoped engineering contribution inputs for scoring.",
    metadata={"table": f"{_SCHEMA_NAME}.engineering_contribution"},
)
def persist_engineering_contribution(
    context: AssetExecutionContext,
    feature_store_schema: str,
    pipeline_run_started: str,
    engineering_contribution: list[EngineeringContribution],
    postgres: PostgresResource,
) -> int:
    _check_schema(feature_store_schema)
    _check_run(context, pipeline_run_started)
    rows = postgres.write_engineering_contribution(
        context.run.run_id,
        engineering_contribution,
    )
    return _finish(context, "engineering_contribution", rows)


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description="Stores a per-run review-count snapshot keyed by Authentik PK.",
    metadata={"table": f"{_SCHEMA_NAME}.member_pr_review_counts"},
)
def persist_member_pr_review_counts(
    context: AssetExecutionContext,
    feature_store_schema: str,
    pipeline_run_started: str,
    member_pr_review_counts: PullRequestReviewCounts,
    postgres: PostgresResource,
) -> int:
    _check_schema(feature_store_schema)
    _check_run(context, pipeline_run_started)
    rows = postgres.write_member_pr_review_counts(
        context.run.run_id,
        member_pr_review_counts.rows,
    )
    return _finish(context, "member_pr_review_counts", rows)


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description="Stores PR-linked commit messages with run provenance.",
    metadata={"table": f"{_SCHEMA_NAME}.pr_linked_commit_messages"},
)
def persist_pr_linked_commit_messages(
    context: AssetExecutionContext,
    feature_store_schema: str,
    pipeline_run_started: str,
    gitea_repository: Repository,
    pr_linked_commit_messages: list[PRLinkedCommitMessage],
    postgres: PostgresResource,
) -> int:
    _check_schema(feature_store_schema)
    _check_run(context, pipeline_run_started)
    rows = postgres.write_pr_linked_commit_messages(
        context.run.run_id,
        gitea_repository.org,
        gitea_repository.name,
        pr_linked_commit_messages,
    )
    return _finish(context, "pr_linked_commit_messages", rows)


@asset(
    group_name="07_database",
    kinds={"postgres"},
    description=(
        "Marks the manifest complete only after every source, feature, and "
        "persistence asset has succeeded. Consumers can safely filter complete runs."
    ),
    metadata={"table": f"{_SCHEMA_NAME}.pipeline_runs"},
)
def pipeline_run_completed(
    context: AssetExecutionContext,
    pipeline_run_started: str,
    persist_blame_records: int,
    persist_authentik_roster_snapshot: int,
    persist_git_identity_mapping: int,
    persist_file_ownership: int,
    persist_member_repository_ownership: int,
    persist_member_ownership: int,
    persist_eligible_file_ownership: int,
    persist_engineering_contribution: int,
    persist_member_pr_review_counts: int,
    persist_pr_linked_commit_messages: int,
    postgres: PostgresResource,
) -> str:
    counts = {
        "blame_records": persist_blame_records,
        "member_roster_snapshot": persist_authentik_roster_snapshot,
        "git_identity_mapping": persist_git_identity_mapping,
        "file_ownership": persist_file_ownership,
        "member_repository_ownership": persist_member_repository_ownership,
        "member_ownership": persist_member_ownership,
        "eligible_file_ownership": persist_eligible_file_ownership,
        "engineering_contribution": persist_engineering_contribution,
        "member_pr_review_counts": persist_member_pr_review_counts,
        "pr_linked_commit_messages": persist_pr_linked_commit_messages,
    }
    postgres.complete_pipeline_run(pipeline_run_started, counts)
    context.add_output_metadata(
        {
            "table": MetadataValue.text(f"{_SCHEMA_NAME}.pipeline_runs"),
            "run_id": MetadataValue.text(pipeline_run_started),
            "status": MetadataValue.text("complete"),
            "persisted_counts": MetadataValue.json(counts),
        }
    )
    return pipeline_run_started


__all__ = [
    "feature_store_schema",
    "pipeline_run_started",
    "pipeline_run_completed",
    "persist_blame_records",
    "persist_authentik_roster_snapshot",
    "persist_engineering_contribution",
    "persist_eligible_file_ownership",
    "persist_file_ownership",
    "persist_git_identity_mapping",
    "persist_member_ownership",
    "persist_member_pr_review_counts",
    "persist_member_repository_ownership",
    "persist_pr_linked_commit_messages",
]
