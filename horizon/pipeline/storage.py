"""Postgres storage boundary for the Horizon feature tables."""

from __future__ import annotations

import json
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING

import psycopg
from pydantic import Field
from psycopg.types.json import Jsonb
from dagster import ConfigurableResource

from .config import PipelineConfigError
from .ownership import FileOwnership, MemberOwnership, MemberRepositoryOwnership
from .pull_requests import MemberPRReviewCount, PRLinkedCommitMessage

if TYPE_CHECKING:
    from .project_sources import ProjectRepositoryRow, ProjectSources, PullRequestSources
    from .ownership import EligibleFileOwnership, EngineeringContribution
    from .identity import IdentityCluster
    from .blame_parser import BlameRecord
    from .assets.capture import BlameCapture
    from .resources import AuthentikRoster


class PostgresResource(ConfigurableResource):
    """Transactional Postgres backend for Horizon's persistence assets.

    The connection URL is supplied at runtime. The legacy deployment variable
    ``GITEA_ANALYTICS_DATABASE_URL`` is accepted by ``PipelineSettings`` and is
    intentionally never written into the repository.
    """

    database_url: str | None = Field(default=None, repr=False)

    @contextmanager
    def connect(self) -> Iterator[psycopg.Connection]:
        """Open one transaction and commit only after the caller succeeds."""

        with psycopg.connect(
            self._require_database_url(),
            connect_timeout=10,
            application_name="horizon-dagster",
        ) as connection:
            yield connection

    def ensure_schema(self) -> None:
        """Create or safely upgrade the Horizon feature tables."""

        statements = (Path(__file__).parent / "schema.sql").read_text()
        with self.connect() as connection:
            # Serialize deploy-time DDL so concurrent first runs do not race on
            # CREATE INDEX / constraint migrations.
            connection.execute("SELECT pg_advisory_xact_lock(%s)", (0x484F52495A4F4E,))
            connection.execute(statements)

    def start_pipeline_run(
        self, run_id: str, capture: BlameCapture, roster: AuthentikRoster
    ) -> None:
        """Record source provenance before writing run-scoped rows."""

        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO horizon_gt_features.pipeline_runs (
                    run_id, status, organization, repository, default_branch,
                    source_commit_sha, source_retrieved_at, files_tracked,
                    files_captured, files_skipped_binary, files_empty, files_failed,
                    roster_source, roster_retrieved_at, started_at, completed_at,
                    persisted_counts
                ) VALUES (
                    %s, 'incomplete', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    'peopleportal_authentik_onboarded_users', %s,
                    CURRENT_TIMESTAMP, NULL, '{}'::jsonb
                )
                ON CONFLICT (run_id) DO UPDATE SET
                    status = 'incomplete', organization = EXCLUDED.organization,
                    repository = EXCLUDED.repository,
                    default_branch = EXCLUDED.default_branch,
                    source_commit_sha = EXCLUDED.source_commit_sha,
                    source_retrieved_at = EXCLUDED.source_retrieved_at,
                    files_tracked = EXCLUDED.files_tracked,
                    files_captured = EXCLUDED.files_captured,
                    files_skipped_binary = EXCLUDED.files_skipped_binary,
                    files_empty = EXCLUDED.files_empty,
                    files_failed = EXCLUDED.files_failed,
                    roster_source = EXCLUDED.roster_source,
                    roster_retrieved_at = EXCLUDED.roster_retrieved_at,
                    started_at = CURRENT_TIMESTAMP, completed_at = NULL,
                    persisted_counts = '{}'::jsonb
                """,
                (
                    run_id, capture.org, capture.repo, capture.default_branch,
                    capture.source_commit_sha, capture.retrieved_at,
                    capture.files_tracked, capture.files_captured,
                    capture.files_skipped_binary, capture.files_empty,
                    capture.files_failed, roster.retrieved_at,
                ),
            )

    def complete_pipeline_run(self, run_id: str, counts: dict[str, int]) -> None:
        """Mark a run consumable only after all persistence assets succeed."""

        run_scoped_tables = {
            "blame_records": ("blame_records", "run_id"),
            "member_roster_snapshot": ("member_roster_snapshot", "run_id"),
            "git_identity_mapping": ("git_identity_mapping", "run_id"),
            "file_ownership": ("file_ownership", "run_id"),
            "member_repository_ownership": ("member_repository_ownership", "run_id"),
            "member_ownership": ("member_ownership", "run_id"),
            "eligible_file_ownership": ("eligible_file_ownership", "run_id"),
            "engineering_contribution": ("engineering_contribution", "run_id"),
            "member_pr_review_counts": ("member_pr_review_counts", "dagster_run_id"),
            "pr_linked_commit_messages": (
                "pr_linked_commit_messages",
                "dagster_run_id",
            ),
        }
        if set(counts) != set(run_scoped_tables):
            raise ValueError("pipeline completion counts do not cover every persisted table")

        with self.connect() as connection:
            manifest = connection.execute(
                """
                SELECT status, files_tracked, files_captured, files_failed
                FROM horizon_gt_features.pipeline_runs
                WHERE run_id = %s
                """,
                (run_id,),
            ).fetchone()
            if manifest is None or manifest[0] != "incomplete":
                raise RuntimeError(
                    f"Cannot complete pipeline run {run_id!r}: "
                    "the incomplete run manifest is missing."
                )
            if (
                manifest[2] <= 0
                or manifest[3] != 0
                or counts["blame_records"] <= 0
                or counts["member_roster_snapshot"] <= 0
            ):
                raise RuntimeError(
                    f"Cannot complete pipeline run {run_id!r}: "
                    f"capture has {manifest[2]} captured file(s), "
                    f"{manifest[3]} failure(s), {counts['blame_records']} blame row(s), "
                    f"and {counts['member_roster_snapshot']} roster row(s)."
                )
            with connection.cursor() as cursor:
                for metric, (table, run_column) in run_scoped_tables.items():
                    cursor.execute(
                        f"SELECT count(*) FROM horizon_gt_features.{table} "
                        f"WHERE {run_column} = %s",
                        (run_id,),
                    )
                    actual = cursor.fetchone()[0]
                    if actual != counts[metric]:
                        raise RuntimeError(
                            f"Cannot complete pipeline run {run_id!r}: "
                            f"{table} has {actual} row(s), expected {counts[metric]}."
                        )
            cursor = connection.execute(
                """
                UPDATE horizon_gt_features.pipeline_runs
                SET status = 'complete', completed_at = CURRENT_TIMESTAMP,
                    persisted_counts = %s
                WHERE run_id = %s AND status = 'incomplete'
                """,
                (Jsonb(counts), run_id),
            )
            if cursor.rowcount != 1:
                raise RuntimeError(
                    f"Cannot complete pipeline run {run_id!r}: no incomplete manifest exists."
                )

    def write_blame_records(
        self,
        run_id: str,
        records: Sequence[BlameRecord],
        identities: Sequence[IdentityCluster],
    ) -> int:
        """Bulk-load parsed blame lines with their resolved or review identity."""

        identity_by_raw = {
            (item.author_name, item.author_email): item for item in identities
        }
        if len(identity_by_raw) != len(identities):
            raise ValueError("identity clusters contain duplicate raw Git identities")
        missing = {
            (record.author_name, record.author_email)
            for record in records
            if (record.author_name, record.author_email) not in identity_by_raw
        }
        if missing:
            raise ValueError(
                f"identity clusters do not cover {len(missing)} parsed blame identity(ies)"
            )

        statement = """
            COPY horizon_gt_features.blame_records (
                run_id, organization, repository, blamed_file_path,
                line_number_in_file, commit_sha, commit_summary,
                consecutive_line_count, line_number_at_origin, author_name,
                author_email, authored_at_epoch, author_utc_offset,
                committer_name, committer_email, committed_at_epoch,
                committer_utc_offset, origin_file_path, previous_commit_sha,
                previous_file_path, reaches_history_boundary,
                authentik_user_pk, identity_resolution
            ) FROM STDIN
        """
        with self.connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT organization, repository
                    FROM horizon_gt_features.pipeline_runs
                    WHERE run_id = %s AND status = 'incomplete'
                    """,
                    (run_id,),
                )
                source = cursor.fetchone()
                if source is None:
                    raise RuntimeError(
                        f"Cannot persist blame records for {run_id!r}: "
                        "the incomplete run manifest is missing."
                    )
                expected_repo = (source[0], source[1])
                mismatched_records = sum(
                    (row.organization, row.repository) != expected_repo for row in records
                )
                if mismatched_records:
                    raise ValueError(
                        f"{mismatched_records} blame record(s) do not match the "
                        "repository in the run manifest."
                    )
                cursor.execute(
                    "DELETE FROM horizon_gt_features.blame_records WHERE run_id = %s",
                    (run_id,),
                )
                if records:
                    with cursor.copy(statement) as copy:
                        for row in records:
                            identity = identity_by_raw[(row.author_name, row.author_email)]
                            copy.write_row(
                                (
                                    run_id, row.organization, row.repository,
                                    row.blamed_file_path, row.line_number_in_file,
                                    row.commit_sha, row.commit_summary,
                                    row.consecutive_line_count, row.line_number_at_origin,
                                    row.author_name, row.author_email,
                                    row.authored_at_epoch, row.author_utc_offset,
                                    row.committer_name, row.committer_email,
                                    row.committed_at_epoch, row.committer_utc_offset,
                                    row.origin_file_path, row.previous_commit_sha,
                                    row.previous_file_path, row.reaches_history_boundary,
                                    identity.authentik_user_pk, identity.match_method,
                                )
                            )
        return len(records)

    def write_authentik_roster_snapshot(self, run_id: str, roster: AuthentikRoster) -> int:
        """Persist the complete People Portal-managed Authentik roster snapshot."""

        values = [
            (
                run_id,
                user.authentik_user_pk,
                user.username,
                user.email,
                user.name,
                user.active,
                roster.retrieved_at,
                "peopleportal_authentik_onboarded_users",
            )
            for user in roster.users
        ]
        with self.connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM horizon_gt_features.member_roster_snapshot WHERE run_id = %s",
                    (run_id,),
                )
                if values:
                    cursor.executemany(
                        """
                        INSERT INTO horizon_gt_features.member_roster_snapshot (
                            run_id, authentik_user_pk, username, email, display_name,
                            is_active, retrieved_at, source_name
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (run_id, authentik_user_pk) DO UPDATE SET
                            username = EXCLUDED.username,
                            email = EXCLUDED.email,
                            display_name = EXCLUDED.display_name,
                            is_active = EXCLUDED.is_active,
                            retrieved_at = EXCLUDED.retrieved_at,
                            source_name = EXCLUDED.source_name
                        """,
                        values,
                    )
        return len(values)

    def write_identity_clusters(
        self, run_id: str, rows: Sequence[IdentityCluster]
    ) -> int:
        """Persist Git author identities and their exact-email PK resolution."""

        values = [
            (
                run_id,
                row.author_name,
                row.author_email,
                row.authentik_user_pk,
                row.match_method,
                row.candidate_count,
                list(row.evidence_sources),
                row.blame_line_count,
                row.pull_request_commit_count,
                row.source_name,
                row.source_retrieved_at,
            )
            for row in rows
        ]
        with self.connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM horizon_gt_features.git_identity_mapping WHERE run_id = %s",
                    (run_id,),
                )
                if values:
                    cursor.executemany(
                        """
                        INSERT INTO horizon_gt_features.git_identity_mapping (
                            run_id, author_name, author_email, authentik_user_pk,
                            match_method, candidate_count, evidence_sources,
                            blame_line_count, pull_request_commit_count, source_name,
                            source_retrieved_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (run_id, author_name, author_email) DO UPDATE SET
                            authentik_user_pk = EXCLUDED.authentik_user_pk,
                            match_method = EXCLUDED.match_method,
                            candidate_count = EXCLUDED.candidate_count,
                            evidence_sources = EXCLUDED.evidence_sources,
                            blame_line_count = EXCLUDED.blame_line_count,
                            pull_request_commit_count = EXCLUDED.pull_request_commit_count,
                            source_name = EXCLUDED.source_name,
                            source_retrieved_at = EXCLUDED.source_retrieved_at
                        """,
                        values,
                    )
        return len(values)

    def write_file_ownership(
        self, run_id: str, rows: Sequence[FileOwnership]
    ) -> int:
        values = [
            (
                run_id,
                row.organization,
                row.repository,
                row.file_path,
                row.author_name,
                row.author_email,
                row.surviving_lines,
                row.file_lines,
                row.ownership_share,
            )
            for row in rows
        ]
        with self.connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM horizon_gt_features.file_ownership WHERE run_id = %s",
                    (run_id,),
                )
                if values:
                    cursor.executemany(
                        """
                        INSERT INTO horizon_gt_features.file_ownership (
                            run_id, organization, repository, file_path,
                            author_name, author_email, surviving_lines, file_lines,
                            ownership_share
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (
                            run_id, organization, repository, file_path,
                            author_name, author_email
                        ) DO UPDATE SET
                            surviving_lines = EXCLUDED.surviving_lines,
                            file_lines = EXCLUDED.file_lines,
                            ownership_share = EXCLUDED.ownership_share
                        """,
                        values,
                    )
        return len(values)

    def write_member_repository_ownership(
        self, run_id: str, rows: Sequence[MemberRepositoryOwnership]
    ) -> int:
        values = [
            (
                run_id,
                row.organization,
                row.repository,
                row.author_name,
                row.author_email,
                row.surviving_lines,
                row.repository_lines,
                row.ownership_share,
                row.files_owned,
                row.majority_owned_files,
                row.rank,
            )
            for row in rows
        ]
        with self.connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM horizon_gt_features.member_repository_ownership "
                    "WHERE run_id = %s",
                    (run_id,),
                )
                if values:
                    cursor.executemany(
                        """
                        INSERT INTO horizon_gt_features.member_repository_ownership (
                            run_id, organization, repository, author_name, author_email,
                            surviving_lines, repository_lines, ownership_share,
                            files_owned, majority_owned_files, rank
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (
                            run_id, organization, repository, author_name, author_email
                        ) DO UPDATE SET
                            surviving_lines = EXCLUDED.surviving_lines,
                            repository_lines = EXCLUDED.repository_lines,
                            ownership_share = EXCLUDED.ownership_share,
                            files_owned = EXCLUDED.files_owned,
                            majority_owned_files = EXCLUDED.majority_owned_files,
                            rank = EXCLUDED.rank
                        """,
                        values,
                    )
        return len(values)

    def write_member_ownership(
        self, run_id: str, rows: Sequence[MemberOwnership]
    ) -> int:
        values = [
            (
                run_id,
                row.organization,
                row.author_name,
                row.author_email,
                row.surviving_lines,
                row.surviving_commits,
                row.files_owned,
                row.repositories,
                row.majority_owned_files,
                row.average_file_share,
            )
            for row in rows
        ]
        with self.connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM horizon_gt_features.member_ownership WHERE run_id = %s",
                    (run_id,),
                )
                if values:
                    cursor.executemany(
                        """
                        INSERT INTO horizon_gt_features.member_ownership (
                            run_id, organization, author_name, author_email,
                            surviving_lines, surviving_commits, files_owned,
                            repositories, majority_owned_files, average_file_share
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (
                            run_id, organization, author_name, author_email
                        ) DO UPDATE SET
                            surviving_lines = EXCLUDED.surviving_lines,
                            surviving_commits = EXCLUDED.surviving_commits,
                            files_owned = EXCLUDED.files_owned,
                            repositories = EXCLUDED.repositories,
                            majority_owned_files = EXCLUDED.majority_owned_files,
                            average_file_share = EXCLUDED.average_file_share
                        """,
                        values,
                    )
        return len(values)

    def write_member_pr_review_counts(
        self, run_id: str, rows: Sequence[MemberPRReviewCount]
    ) -> int:
        """Upsert one cumulative review-count snapshot per member and run."""

        if len({row.member_id for row in rows}) != len(rows):
            raise ValueError("member PR review counts contain duplicate member IDs.")
        values = [
            (
                row.member_id,
                run_id,
                row.reviews_written_count,
                row.approvals_given_count,
                row.changes_requested_count,
            )
            for row in rows
        ]
        with self.connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM horizon_gt_features.member_pr_review_counts "
                    "WHERE dagster_run_id = %s",
                    (run_id,),
                )
                if values:
                    cursor.executemany(
                        """
                        INSERT INTO horizon_gt_features.member_pr_review_counts (
                            member_id, dagster_run_id, reviews_written_count,
                            approvals_given_count, changes_requested_count
                        ) VALUES (%s, %s, %s, %s, %s)
                        ON CONFLICT (member_id, dagster_run_id) DO UPDATE SET
                            reviews_written_count = EXCLUDED.reviews_written_count,
                            approvals_given_count = EXCLUDED.approvals_given_count,
                            changes_requested_count = EXCLUDED.changes_requested_count
                        """,
                        values,
                    )
        return len(values)

    def write_pr_linked_commit_messages(
        self,
        run_id: str,
        organization: str,
        repository: str,
        rows: Sequence[PRLinkedCommitMessage],
    ) -> int:
        """Replace only this run's PR-commit snapshot for one repository."""

        keys = [
            (
                row.organization,
                row.repository,
                row.pull_request_number,
                row.commit_sha,
            )
            for row in rows
        ]
        if len(set(keys)) != len(keys):
            raise ValueError("PR-linked commit messages contain duplicate PR/commit keys.")
        if any(
            row.dagster_run_id != run_id
            or row.organization != organization
            or row.repository != repository
            for row in rows
        ):
            raise ValueError(
                "PR-linked commit rows do not match the run or configured repository."
            )
        values = [
            (
                row.organization,
                row.repository,
                row.pull_request_number,
                row.commit_sha,
                row.author_name,
                row.author_email,
                row.authentik_user_pk,
                row.identity_resolution,
                row.candidate_count,
                row.committed_at,
                row.message,
                run_id,
            )
            for row in rows
        ]
        with self.connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM horizon_gt_features.pr_linked_commit_messages "
                    "WHERE dagster_run_id = %s AND organization = %s AND repository = %s",
                    (run_id, organization, repository),
                )
                if values:
                    cursor.executemany(
                        """
                        INSERT INTO horizon_gt_features.pr_linked_commit_messages (
                            organization, repository, pull_request_number, commit_sha,
                            author_name, author_email, authentik_user_pk,
                            identity_resolution, candidate_count, committed_at,
                            message, dagster_run_id
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (
                            dagster_run_id, organization, repository,
                            pull_request_number, commit_sha
                        ) DO UPDATE SET
                            author_name = EXCLUDED.author_name,
                            author_email = EXCLUDED.author_email,
                            authentik_user_pk = EXCLUDED.authentik_user_pk,
                            identity_resolution = EXCLUDED.identity_resolution,
                            candidate_count = EXCLUDED.candidate_count,
                            committed_at = EXCLUDED.committed_at,
                            message = EXCLUDED.message
                        """,
                        values,
                    )
        return len(values)

    def write_eligible_file_ownership(
        self, run_id: str, rows: Sequence[EligibleFileOwnership]
    ) -> int:
        """Upsert file ownership grouped by canonical member or unresolved identity."""

        values = [
            (
                run_id,
                row.organization,
                row.repository,
                row.file_path,
                row.authentik_user_pk,
                row.identity_resolution,
                _identity_key(row.authentik_user_pk, row.raw_author_identities_json),
                Jsonb(row.raw_author_identities_json),
                row.eligible_source_lines,
                row.eligible_file_lines,
                row.non_boundary_source_lines,
                row.ownership_share,
                row.non_boundary_ownership_share,
            )
            for row in rows
        ]
        with self.connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM horizon_gt_features.eligible_file_ownership "
                    "WHERE run_id = %s",
                    (run_id,),
                )
                if values:
                    cursor.executemany(
                        """
                        INSERT INTO horizon_gt_features.eligible_file_ownership (
                            run_id, organization, repository, file_path, authentik_user_pk,
                            identity_resolution, identity_key, raw_author_identities_json,
                            eligible_source_lines, eligible_file_lines,
                            non_boundary_source_lines, ownership_share,
                            non_boundary_ownership_share
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (
                            run_id, organization, repository, file_path,
                            identity_resolution, identity_key
                        ) DO UPDATE SET
                            authentik_user_pk = EXCLUDED.authentik_user_pk,
                            raw_author_identities_json = EXCLUDED.raw_author_identities_json,
                            eligible_source_lines = EXCLUDED.eligible_source_lines,
                            eligible_file_lines = EXCLUDED.eligible_file_lines,
                            non_boundary_source_lines = EXCLUDED.non_boundary_source_lines,
                            ownership_share = EXCLUDED.ownership_share,
                            non_boundary_ownership_share = EXCLUDED.non_boundary_ownership_share
                        """,
                        values,
                    )
        return len(values)

    def write_engineering_contribution(
        self, run_id: str, rows: Sequence[EngineeringContribution]
    ) -> int:
        """Upsert member/repository engineering metrics with raw identity audit data."""

        values = [
            (
                run_id,
                row.organization,
                row.repository,
                row.authentik_user_pk,
                row.identity_resolution,
                _identity_key(row.authentik_user_pk, row.raw_author_identities_json),
                Jsonb(row.raw_author_identities_json),
                row.eligible_source_lines,
                row.non_boundary_surviving_lines,
                row.log_non_boundary_surviving_lines,
                row.eligible_repository_lines,
                row.non_boundary_repository_lines,
                row.repository_ownership_share,
                row.non_boundary_repository_share,
                row.files_owned,
                row.majority_owned_files,
                row.surviving_commits,
                row.eligible_repository_files,
            )
            for row in rows
        ]
        with self.connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM horizon_gt_features.engineering_contribution "
                    "WHERE run_id = %s",
                    (run_id,),
                )
                if values:
                    cursor.executemany(
                        """
                        INSERT INTO horizon_gt_features.engineering_contribution (
                            run_id, organization, repository, authentik_user_pk,
                            identity_resolution, identity_key, raw_author_identities_json,
                            eligible_source_lines, non_boundary_surviving_lines,
                            log_non_boundary_surviving_lines, eligible_repository_lines,
                            non_boundary_repository_lines, repository_ownership_share,
                            non_boundary_repository_share, files_owned,
                            majority_owned_files, surviving_commits,
                            eligible_repository_files
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (
                            run_id, organization, repository, identity_resolution,
                            identity_key
                        ) DO UPDATE SET
                            authentik_user_pk = EXCLUDED.authentik_user_pk,
                            raw_author_identities_json = EXCLUDED.raw_author_identities_json,
                            eligible_source_lines = EXCLUDED.eligible_source_lines,
                            non_boundary_surviving_lines = EXCLUDED.non_boundary_surviving_lines,
                            log_non_boundary_surviving_lines = EXCLUDED.log_non_boundary_surviving_lines,
                            eligible_repository_lines = EXCLUDED.eligible_repository_lines,
                            non_boundary_repository_lines = EXCLUDED.non_boundary_repository_lines,
                            repository_ownership_share = EXCLUDED.repository_ownership_share,
                            non_boundary_repository_share = EXCLUDED.non_boundary_repository_share,
                            files_owned = EXCLUDED.files_owned,
                            majority_owned_files = EXCLUDED.majority_owned_files,
                            surviving_commits = EXCLUDED.surviving_commits,
                            eligible_repository_files = EXCLUDED.eligible_repository_files
                        """,
                        values,
                    )
        return len(values)

    def write_project_sources(
        self,
        sources: ProjectSources,
        repositories: Sequence[ProjectRepositoryRow],
        pull_requests: PullRequestSources,
        *,
        dagster_run_id: str,
    ) -> dict[str, int]:
        """Upsert the six T1.1 latest-state tables in one transaction.

        Rows are upserted by primary key, so re-running changes only
        retrieved_at and rows whose values changed. Members and repositories
        that left a project in this snapshot are removed for that project, so
        the roster never keeps people who are no longer on the team.
        """

        def ensure_unique(label: str, values: Sequence[tuple]) -> None:
            if len(set(values)) != len(values):
                raise ValueError(f"T1.1 snapshot contains duplicate {label} keys.")

        ensure_unique("project", [(project.project_pk,) for project in sources.projects])
        ensure_unique(
            "project member",
            [(member.project_pk, member.authentik_user_pk) for member in sources.members],
        )
        ensure_unique("repository", [(repo.organization, repo.repository) for repo in repositories])
        ensure_unique(
            "pull request",
            [(row.organization, row.repository, row.number) for row in pull_requests.pull_requests],
        )
        ensure_unique(
            "PR review",
            [(row.organization, row.repository, row.pr_number, row.review_id) for row in pull_requests.reviews],
        )
        ensure_unique(
            "PR review request",
            [(row.organization, row.repository, row.pr_number, row.event_id) for row in pull_requests.review_requests],
        )

        at = sources.retrieved_at
        pr_at = pull_requests.retrieved_at or at
        project_pks = [project.project_pk for project in sources.projects]
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO horizon_gt_features.projects (
                    project_pk, season_type, season_year, name, gitea_org,
                    friendly_name, window_start, window_end, archived, retrieved_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (project_pk) DO UPDATE SET
                    season_type = EXCLUDED.season_type, season_year = EXCLUDED.season_year,
                    name = EXCLUDED.name, gitea_org = EXCLUDED.gitea_org,
                    friendly_name = EXCLUDED.friendly_name,
                    window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
                    archived = EXCLUDED.archived, retrieved_at = EXCLUDED.retrieved_at
                """,
                [
                    (p.project_pk, p.season_type, p.season_year, p.name, p.gitea_org,
                     p.friendly_name, p.window_start, p.window_end, p.archived, at)
                    for p in sources.projects
                ],
            )
            member_keys = [(m.project_pk, m.authentik_user_pk) for m in sources.members]
            cursor.execute(
                """
                DELETE FROM horizon_gt_features.project_members
                WHERE project_pk = ANY(%s)
                  AND (project_pk, authentik_user_pk) NOT IN (
                      SELECT * FROM unnest(%s::text[], %s::text[]))
                """,
                (project_pks, [k[0] for k in member_keys], [k[1] for k in member_keys]),
            )
            cursor.executemany(
                """
                INSERT INTO horizon_gt_features.project_members (
                    project_pk, authentik_user_pk, username, email, display_name, roles,
                    role_titles, tenure_semesters, role_mapping_version, retrieved_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (project_pk, authentik_user_pk) DO UPDATE SET
                    username = EXCLUDED.username, email = EXCLUDED.email,
                    display_name = EXCLUDED.display_name, roles = EXCLUDED.roles,
                    role_titles = EXCLUDED.role_titles,
                    tenure_semesters = EXCLUDED.tenure_semesters,
                    role_mapping_version = EXCLUDED.role_mapping_version,
                    retrieved_at = EXCLUDED.retrieved_at
                """,
                [
                    (m.project_pk, m.authentik_user_pk, m.username, m.email, m.display_name,
                     list(m.roles), Jsonb(m.role_titles), m.tenure_semesters,
                     m.role_mapping_version, at)
                    for m in sources.members
                ],
            )
            repo_keys = [(r.organization, r.repository) for r in repositories]
            cursor.execute(
                """
                DELETE FROM horizon_gt_features.project_repositories
                WHERE project_pk = ANY(%s)
                  AND (organization, repository) NOT IN (
                      SELECT * FROM unnest(%s::text[], %s::text[]))
                """,
                (project_pks, [k[0] for k in repo_keys], [k[1] for k in repo_keys]),
            )
            cursor.executemany(
                """
                INSERT INTO horizon_gt_features.project_repositories (
                    project_pk, organization, repository, default_branch, retrieved_at
                ) VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (organization, repository) DO UPDATE SET
                    project_pk = EXCLUDED.project_pk,
                    default_branch = EXCLUDED.default_branch,
                    retrieved_at = EXCLUDED.retrieved_at
                """,
                [(r.project_pk, r.organization, r.repository, r.default_branch, at)
                 for r in repositories],
            )
            cursor.executemany(
                """
                INSERT INTO horizon_gt_features.gitea_pull_requests (
                    organization, repository, number, title, body, author_login,
                    author_pk, state, merged, created_at, merged_at, closed_at,
                    base_branch, head_branch, html_url, retrieved_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (organization, repository, number) DO UPDATE SET
                    title = EXCLUDED.title, body = EXCLUDED.body,
                    author_login = EXCLUDED.author_login, author_pk = EXCLUDED.author_pk,
                    state = EXCLUDED.state, merged = EXCLUDED.merged,
                    created_at = EXCLUDED.created_at, merged_at = EXCLUDED.merged_at,
                    closed_at = EXCLUDED.closed_at, base_branch = EXCLUDED.base_branch,
                    head_branch = EXCLUDED.head_branch, html_url = EXCLUDED.html_url,
                    retrieved_at = EXCLUDED.retrieved_at
                """,
                [
                    (p.organization, p.repository, p.number, p.title, p.body, p.author_login,
                     p.author_pk, p.state, p.merged, p.created_at, p.merged_at, p.closed_at,
                     p.base_branch, p.head_branch, p.html_url, pr_at)
                    for p in pull_requests.pull_requests
                ],
            )
            cursor.executemany(
                """
                INSERT INTO horizon_gt_features.gitea_pr_reviews (
                    organization, repository, pr_number, review_id, reviewer_login,
                    reviewer_pk, state, submitted_at, retrieved_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (organization, repository, pr_number, review_id) DO UPDATE SET
                    reviewer_login = EXCLUDED.reviewer_login,
                    reviewer_pk = EXCLUDED.reviewer_pk, state = EXCLUDED.state,
                    submitted_at = EXCLUDED.submitted_at, retrieved_at = EXCLUDED.retrieved_at
                """,
                [
                    (r.organization, r.repository, r.pr_number, r.review_id, r.reviewer_login,
                     r.reviewer_pk, r.state, r.submitted_at, pr_at)
                    for r in pull_requests.reviews
                ],
            )
            cursor.executemany(
                """
                INSERT INTO horizon_gt_features.gitea_pr_review_requests (
                    organization, repository, pr_number, event_id, requested_login,
                    requested_pk, requested_at, retrieved_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (organization, repository, pr_number, event_id) DO UPDATE SET
                    requested_login = EXCLUDED.requested_login,
                    requested_pk = EXCLUDED.requested_pk,
                    requested_at = EXCLUDED.requested_at, retrieved_at = EXCLUDED.retrieved_at
                """,
                [
                    (r.organization, r.repository, r.pr_number, r.event_id, r.requested_login,
                     r.requested_pk, r.requested_at, pr_at)
                    for r in pull_requests.review_requests
                ],
            )
            repo_orgs = [org for org, _ in repo_keys]
            repo_names = [repo for _, repo in repo_keys]
            def persisted_count(table: str, predicate: str, params: tuple) -> int:
                cursor.execute(
                    f"SELECT count(*) FROM horizon_gt_features.{table} WHERE {predicate}",
                    params,
                )
                return cursor.fetchone()[0]

            repo_predicate = (
                "(organization, repository) IN "
                "(SELECT * FROM unnest(%s::text[], %s::text[]))"
            )
            counts = {
                "projects": persisted_count("projects", "project_pk = ANY(%s)", (project_pks,)),
                "project_members": persisted_count("project_members", "project_pk = ANY(%s)", (project_pks,)),
                "project_repositories": persisted_count("project_repositories", "project_pk = ANY(%s)", (project_pks,)),
                "gitea_pull_requests": persisted_count("gitea_pull_requests", repo_predicate, (repo_orgs, repo_names)),
                "gitea_pr_reviews": persisted_count("gitea_pr_reviews", repo_predicate, (repo_orgs, repo_names)),
                "gitea_pr_review_requests": persisted_count("gitea_pr_review_requests", repo_predicate, (repo_orgs, repo_names)),
            }
            cursor.execute(
                """
                INSERT INTO horizon_gt_features.project_source_runs (
                    dagster_run_id, season_type, season_year, status, started_at,
                    completed_at, persisted_counts
                ) VALUES (%s, %s, %s, 'complete', %s,
                          CURRENT_TIMESTAMP, %s)
                ON CONFLICT (dagster_run_id) DO UPDATE SET
                    completed_at = EXCLUDED.completed_at,
                    persisted_counts = EXCLUDED.persisted_counts
                """,
                (dagster_run_id, sources.season_type, sources.season_year,
                 sources.retrieved_at, Jsonb(counts)),
            )
        return counts

    def read_project_repositories(
        self, season_type: str, season_year: int
    ) -> list[tuple[str, str]]:
        """(organization, repository) of the season's non-archived projects."""

        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT r.organization, r.repository
                FROM horizon_gt_features.project_repositories AS r
                JOIN horizon_gt_features.projects AS p USING (project_pk)
                WHERE p.season_type = %s AND p.season_year = %s AND NOT p.archived
                ORDER BY r.organization, r.repository
                """,
                (season_type, season_year),
            ).fetchall()
        return [(row[0], row[1]) for row in rows]

    def _require_database_url(self) -> str:
        if not (self.database_url or "").strip():
            raise PipelineConfigError(
                "HORIZON_DATABASE_URL is not set. Set it to the legacy Horizon "
                "Supabase Postgres URL before materializing the feature assets."
            )
        return self.database_url.strip()


def _identity_key(
    authentik_user_pk: str | None,
    raw_identities: list[dict[str, str | int | None]],
) -> str:
    """Build a stable SQL key for resolved members and unresolved raw aliases."""

    if authentik_user_pk is not None:
        return f"member:{authentik_user_pk}"
    canonical_rows = sorted(
        raw_identities,
        key=lambda item: json.dumps(
            item,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ),
    )
    canonical_json = json.dumps(
        canonical_rows,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return f"unresolved:{canonical_json}"
