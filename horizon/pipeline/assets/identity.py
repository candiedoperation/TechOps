"""Identity mapping from Git authors to canonical Authentik member IDs."""

# Keep annotations evaluated at decoration time; Dagster uses them to resolve
# asset inputs and resources.
import json
from dataclasses import asdict

from dagster import AssetExecutionContext, MetadataValue, TableRecord, asset

from ..blame_parser import BlameRecord
from ..identity import IdentityCluster, resolve_git_identities
from ..metadata import table_schema_from
from ..resources import AuthentikRoster, PullRequestCommit


IDENTITY_CLUSTER_SCHEMA = table_schema_from(
    IdentityCluster,
    {
        "author_name": ("string", "Raw Git author name, retained for traceability."),
        "author_email": ("string", "Raw Git author email, matched exactly to the roster."),
        "authentik_user_pk": ("string?", "Canonical Authentik user PK; null unless the exact email matched once."),
        "match_method": ("string", "directory_email, ambiguous_email, or unmatched."),
        "candidate_count": ("int", "Number of exact-email roster matches."),
        "evidence_sources": (
            "string",
            "JSON-encoded Git source surfaces containing this identity.",
        ),
        "blame_line_count": ("int", "Blamed lines carrying this Git author identity."),
        "pull_request_commit_count": ("int", "PR-linked commits carrying this identity."),
        "source_name": ("string", "Roster source used for this identity resolution."),
        "source_retrieved_at": ("datetime", "UTC time of the roster snapshot used."),
    },
)


@asset(
    group_name="04_identity",
    kinds={"python"},
    description=(
        "Maps each distinct raw Git author identity to an Authentik user PK only "
        "when the Git author email exactly matches one People Portal-managed "
        "Authentik email. Missing and duplicate matches remain visible and null."
    ),
    metadata={
        "dagster/column_schema": IDENTITY_CLUSTER_SCHEMA,
        "grain": "one row per run and distinct Git author name/email pair",
        "source": "blame_records + gitea_pull_request_commits + authentik_users",
        "automatic_match": "exact email, exactly one roster user",
    },
)
def identity_clusters(
    context: AssetExecutionContext,
    blame_records: list[BlameRecord],
    authentik_users: AuthentikRoster,
    gitea_pull_request_commits: list[PullRequestCommit],
) -> list[IdentityCluster]:
    rows = resolve_git_identities(
        blame_records,
        authentik_users,
        gitea_pull_request_commits,
    )

    resolved = sum(row.authentik_user_pk is not None for row in rows)
    ambiguous = sum(row.match_method == "ambiguous_email" for row in rows)
    unmatched = sum(row.match_method == "unmatched" for row in rows)
    context.add_output_metadata(
        {
            "rows": MetadataValue.int(len(rows)),
            "resolved": MetadataValue.int(resolved),
            "ambiguous": MetadataValue.int(ambiguous),
            "unmatched": MetadataValue.int(unmatched),
            "blame_identities": MetadataValue.int(
                sum(row.blame_line_count > 0 for row in rows)
            ),
            "pr_commit_identities": MetadataValue.int(
                sum(row.pull_request_commit_count > 0 for row in rows)
            ),
            "roster_users": MetadataValue.int(len(authentik_users.users)),
            "roster_retrieved_at": MetadataValue.text(
                authentik_users.retrieved_at.isoformat()
            ),
            "sample": MetadataValue.table(
                records=[
                    TableRecord(
                        {
                            **asdict(row),
                            "evidence_sources": json.dumps(row.evidence_sources),
                            "source_retrieved_at": row.source_retrieved_at.isoformat(),
                        }
                    )
                    for row in rows[:10]
                ],
                schema=IDENTITY_CLUSTER_SCHEMA,
            ),
        }
    )
    return rows
