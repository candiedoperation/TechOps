"""Feature assets: surviving lines, commits, and ownership."""

# Keep annotations evaluated at decoration time; Dagster uses them to resolve
# asset inputs and resources.
import json
from dataclasses import asdict

from dagster import AssetExecutionContext, Failure, MetadataValue, TableRecord, asset

from ..blame_parser import BlameRecord
from ..identity import IdentityCluster
from ..metadata import table_schema_from
from ..ownership import (
    EligibleFileOwnership,
    EngineeringContribution,
    FileOwnership,
    MemberOwnership,
    MemberRepositoryOwnership,
    calculate_file_ownership,
    calculate_eligible_file_ownership,
    calculate_engineering_contribution,
    calculate_member_ownership,
    calculate_member_repository_ownership,
    classify_source_paths,
)
from .capture import BlameCapture


FILE_OWNERSHIP_SCHEMA = table_schema_from(
    FileOwnership,
    {
        "organization": ("string", "Gitea organization."),
        "repository": ("string", "Repository containing the file."),
        "file_path": ("string", "Path of the current file."),
        "author_name": ("string", "Git author identity that owns surviving lines."),
        "author_email": ("string", "Email portion of the Git author identity."),
        "surviving_lines": ("int", "Current lines still attributed to this author."),
        "file_lines": ("int", "Total surviving lines in the current file."),
        "ownership_share": ("float", "surviving_lines divided by file_lines."),
    },
)

MEMBER_REPOSITORY_OWNERSHIP_SCHEMA = table_schema_from(
    MemberRepositoryOwnership,
    {
        "organization": ("string", "Gitea organization."),
        "repository": ("string", "Repository being measured."),
        "author_name": ("string", "Git author identity."),
        "author_email": ("string", "Email portion of the Git author identity."),
        "surviving_lines": ("int", "Current repository lines attributed to the author."),
        "repository_lines": ("int", "Total surviving lines in the repository."),
        "ownership_share": ("float", "surviving_lines divided by repository_lines."),
        "files_owned": ("int", "Files with at least one surviving line by this author."),
        "majority_owned_files": ("int", "Files where this author owns more than half the lines."),
        "rank": ("int", "Deterministic repository rank by surviving lines."),
    },
)

MEMBER_OWNERSHIP_SCHEMA = table_schema_from(
    MemberOwnership,
    {
        "organization": ("string", "Gitea organization."),
        "author_name": ("string", "Git author identity."),
        "author_email": ("string", "Email portion of the Git author identity."),
        "surviving_lines": ("int", "Current lines still attributed to the author."),
        "surviving_commits": ("int", "Distinct commit SHAs that still own a line."),
        "files_owned": ("int", "Files with at least one surviving line."),
        "repositories": ("int", "Repositories with at least one surviving line."),
        "majority_owned_files": ("int", "Files where the author owns more than half the lines."),
        "average_file_share": ("float", "Mean ownership share across the author's files."),
    },
)

ELIGIBLE_FILE_OWNERSHIP_SCHEMA = table_schema_from(
    EligibleFileOwnership,
    {
        "organization": ("string", "Gitea organization."),
        "repository": ("string", "Repository containing the eligible source file."),
        "file_path": ("string", "Current path of the eligible source file."),
        "authentik_user_pk": (
            "string?",
            "Canonical member ID when a Git email exactly matches one roster email; otherwise null.",
        ),
        "identity_resolution": (
            "string",
            "directory_email for an exact unique match, otherwise unmatched or ambiguous_email.",
        ),
        "raw_author_identities_json": (
            "string",
            "JSON-encoded raw Git aliases and resolution evidence retained for audit.",
        ),
        "eligible_source_lines": ("int", "Eligible source-code lines surviving for this author."),
        "eligible_file_lines": ("int", "All eligible source-code lines surviving in the file."),
        "non_boundary_source_lines": (
            "int",
            "Eligible surviving lines not marked as reaching the history boundary.",
        ),
        "ownership_share": ("float", "Eligible source lines divided by eligible file lines."),
        "non_boundary_ownership_share": (
            "float",
            "Non-boundary source lines divided by non-boundary file lines; zero if none exist.",
        ),
    },
)

ENGINEERING_CONTRIBUTION_SCHEMA = table_schema_from(
    EngineeringContribution,
    {
        "organization": ("string", "Gitea organization."),
        "repository": ("string", "Repository measured; rows remain repository-scoped."),
        "authentik_user_pk": (
            "string?",
            "Canonical member ID when a Git email exactly matches one roster email; otherwise null.",
        ),
        "identity_resolution": (
            "string",
            "directory_email for an exact unique match, otherwise unmatched or ambiguous_email.",
        ),
        "raw_author_identities_json": (
            "string",
            "JSON-encoded raw Git aliases and resolution evidence retained for audit.",
        ),
        "eligible_source_lines": ("int", "Eligible source-code lines surviving for this author."),
        "non_boundary_surviving_lines": (
            "int",
            "Eligible surviving lines not marked as reaching the history boundary.",
        ),
        "log_non_boundary_surviving_lines": (
            "float",
            "Natural log of one plus non-boundary surviving source lines.",
        ),
        "eligible_repository_lines": ("int", "Eligible surviving source lines in this repository."),
        "non_boundary_repository_lines": (
            "int",
            "Eligible non-boundary surviving source lines in this repository.",
        ),
        "repository_ownership_share": (
            "float",
            "Author eligible source lines divided by the repository's eligible source lines.",
        ),
        "non_boundary_repository_share": (
            "float",
            "Author non-boundary eligible lines divided by the repository's "
            "non-boundary eligible lines.",
        ),
        "files_owned": (
            "int",
            "Eligible source files with at least one surviving line by this author.",
        ),
        "majority_owned_files": (
            "int",
            "Eligible source files where this author owns more than half of surviving lines.",
        ),
        "surviving_commits": (
            "int",
            "Distinct eligible-source commit SHAs that still own at least one line.",
        ),
        "eligible_repository_files": ("int", "Distinct eligible source files in this repository."),
    },
)


def _empty_preview(schema):
    return MetadataValue.table(records=[], schema=schema)


def _sample(rows, schema):
    records = []
    for row in rows[:10]:
        values = asdict(row)
        for name, value in values.items():
            if isinstance(value, (dict, list)):
                values[name] = json.dumps(value, sort_keys=True, separators=(",", ":"))
        records.append(TableRecord(values))
    return MetadataValue.table(
        records=records,
        schema=schema,
    )


def _feature_metadata(table: str, rows: list, schema, **counts):
    return {
        "table": MetadataValue.text(table),
        "rows": MetadataValue.int(len(rows)),
        "sample": _sample(rows, schema),
        **{name: MetadataValue.int(value) for name, value in counts.items()},
    }


@asset(
    group_name="05_ownership",
    kinds={"python"},
    description=(
        "Calculates surviving-line ownership for every current file and author. "
        "The share is the author's surviving lines divided by the file's total "
        "surviving lines."
    ),
    metadata={
        "dagster/column_schema": FILE_OWNERSHIP_SCHEMA,
        "preview": _empty_preview(FILE_OWNERSHIP_SCHEMA),
        "table": "file_ownership",
        "grain": "one row per run, repository, file, and author",
        "source": "blame_records",
    },
)
def file_ownership(
    context: AssetExecutionContext,
    blame_records: list[BlameRecord],
) -> list[FileOwnership]:
    rows = calculate_file_ownership(blame_records)
    context.add_output_metadata(
        _feature_metadata(
            "file_ownership",
            rows,
            FILE_OWNERSHIP_SCHEMA,
            files=len({(row.organization, row.repository, row.file_path) for row in rows}),
            surviving_lines=sum(row.surviving_lines for row in rows),
        )
    )
    return rows


@asset(
    group_name="05_ownership",
    kinds={"python"},
    description=(
        "Aggregates file ownership to repository ownership, including surviving "
        "lines, share, files touched, majority-owned files, and rank."
    ),
    metadata={
        "dagster/column_schema": MEMBER_REPOSITORY_OWNERSHIP_SCHEMA,
        "preview": _empty_preview(MEMBER_REPOSITORY_OWNERSHIP_SCHEMA),
        "table": "member_repository_ownership",
        "grain": "one row per run, repository, and author",
        "source": "file_ownership",
    },
)
def member_repository_ownership(
    context: AssetExecutionContext,
    file_ownership: list[FileOwnership],
) -> list[MemberRepositoryOwnership]:
    rows = calculate_member_repository_ownership(file_ownership)
    context.add_output_metadata(
        _feature_metadata(
            "member_repository_ownership",
            rows,
            MEMBER_REPOSITORY_OWNERSHIP_SCHEMA,
            repositories=len({(row.organization, row.repository) for row in rows}),
            surviving_lines=sum(row.surviving_lines for row in rows),
        )
    )
    return rows


@asset(
    group_name="05_ownership",
    kinds={"python"},
    description=(
        "Aggregates surviving lines and distinct surviving commit SHAs by author. "
        "A surviving commit is a commit that still owns at least one current line."
    ),
    metadata={
        "dagster/column_schema": MEMBER_OWNERSHIP_SCHEMA,
        "preview": _empty_preview(MEMBER_OWNERSHIP_SCHEMA),
        "table": "member_ownership",
        "grain": "one row per run, organization, and author",
        "source": "blame_records + member_repository_ownership",
    },
)
def member_ownership(
    context: AssetExecutionContext,
    blame_records: list[BlameRecord],
    file_ownership: list[FileOwnership],
    member_repository_ownership: list[MemberRepositoryOwnership],
) -> list[MemberOwnership]:
    rows = calculate_member_ownership(
        blame_records,
        file_ownership,
        member_repository_ownership,
    )
    context.add_output_metadata(
        _feature_metadata(
            "member_ownership",
            rows,
            MEMBER_OWNERSHIP_SCHEMA,
            surviving_lines=sum(row.surviving_lines for row in rows),
            surviving_commits=sum(row.surviving_commits for row in rows),
        )
    )
    return rows


@asset(
    group_name="05_ownership",
    kinds={"python"},
    description=(
        "Calculates file-level ownership for eligible source code. The deterministic "
        "path policy excludes non-source files, common generated paths, vendored "
        "directories, and dependency lockfiles; raw blame records remain available "
        "for audit and other downstream features."
    ),
    metadata={
        "dagster/column_schema": ELIGIBLE_FILE_OWNERSHIP_SCHEMA,
        "preview": _empty_preview(ELIGIBLE_FILE_OWNERSHIP_SCHEMA),
        "table": "eligible_file_ownership",
        "grain": "one row per run, repository, eligible file, and resolved member or unresolved raw identity",
        "source": "blame_records + identity_clusters",
        "eligibility_policy": "pipeline.ownership.classify_source_path",
    },
)
def eligible_file_ownership(
    context: AssetExecutionContext,
    blame_records: list[BlameRecord],
    blame_capture: BlameCapture,
    identity_clusters: list[IdentityCluster],
) -> list[EligibleFileOwnership]:
    if blame_capture.files_failed:
        raise Failure(
            description=(
                f"Cannot calculate eligible ownership for {blame_capture.slug}: "
                f"blame capture failed for {blame_capture.files_failed} tracked files. "
                "Repair the failed paths and recapture before using contribution metrics."
            )
        )
    rows = calculate_eligible_file_ownership(blame_records, identity_clusters)
    classifications = classify_source_paths(blame_records)
    context.add_output_metadata(
        {
            **_feature_metadata(
                "eligible_file_ownership",
                rows,
                ELIGIBLE_FILE_OWNERSHIP_SCHEMA,
                eligible_files=len(
                    {(row.organization, row.repository, row.file_path) for row in rows}
                ),
                eligible_lines=sum(row.eligible_source_lines for row in rows),
                non_boundary_lines=sum(row.non_boundary_source_lines for row in rows),
            ),
            "captured_file_classifications": MetadataValue.json(classifications),
        }
    )
    return rows


@asset(
    group_name="05_ownership",
    kinds={"python"},
    description=(
        "Produces repository-scoped, deterministic engineering contribution inputs: "
        "eligible-code ownership share, majority-owned files, non-boundary surviving "
        "lines and their log transform, and distinct surviving commits. It does not "
        "apply role weights or produce a member ranking."
    ),
    metadata={
        "dagster/column_schema": ENGINEERING_CONTRIBUTION_SCHEMA,
        "preview": _empty_preview(ENGINEERING_CONTRIBUTION_SCHEMA),
        "table": "engineering_contribution",
        "grain": "one row per run, repository, and resolved member or unresolved raw identity",
        "source": "blame_records + eligible_file_ownership + identity_clusters",
    },
)
def engineering_contribution(
    context: AssetExecutionContext,
    blame_records: list[BlameRecord],
    eligible_file_ownership: list[EligibleFileOwnership],
    identity_clusters: list[IdentityCluster],
) -> list[EngineeringContribution]:
    rows = calculate_engineering_contribution(
        blame_records,
        eligible_file_ownership,
        identity_clusters,
    )
    context.add_output_metadata(
        _feature_metadata(
            "engineering_contribution",
            rows,
            ENGINEERING_CONTRIBUTION_SCHEMA,
            repositories=len({(row.organization, row.repository) for row in rows}),
            eligible_lines=sum(row.eligible_source_lines for row in rows),
            non_boundary_lines=sum(row.non_boundary_surviving_lines for row in rows),
            surviving_commits=sum(row.surviving_commits for row in rows),
        )
    )
    return rows


__all__ = [
    "FILE_OWNERSHIP_SCHEMA",
    "ELIGIBLE_FILE_OWNERSHIP_SCHEMA",
    "ENGINEERING_CONTRIBUTION_SCHEMA",
    "MEMBER_OWNERSHIP_SCHEMA",
    "MEMBER_REPOSITORY_OWNERSHIP_SCHEMA",
    "eligible_file_ownership",
    "engineering_contribution",
    "file_ownership",
    "member_ownership",
    "member_repository_ownership",
]
