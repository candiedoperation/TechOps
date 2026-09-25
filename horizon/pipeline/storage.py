"""Storage boundary for the interim ownership analytics tables."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

from dagster import ConfigurableResource

from .ownership import FileOwnership, MemberOwnership, MemberRepositoryOwnership


class SQLiteResource(ConfigurableResource):
    """Transactional SQLite backend for the first ownership implementation.

    The assets depend on these write methods rather than on SQL statements.
    When the data volume outgrows SQLite, the resource can be replaced by a
    Postgres implementation with the same methods and the metric assets stay
    unchanged.
    """

    database_path: str = "data/horizon.sqlite3"

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        target = self.database_path
        if target != ":memory:":
            Path(target).expanduser().parent.mkdir(parents=True, exist_ok=True)

        connection = sqlite3.connect(target)
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
        except BaseException:
            connection.rollback()
            raise
        else:
            connection.commit()
        finally:
            connection.close()

    def ensure_schema(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                (Path(__file__).parent / "schema.sqlite.sql").read_text()
            )

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
        self.ensure_schema()
        with self.connect() as connection:
            connection.executemany(
                """
                INSERT OR REPLACE INTO file_ownership (
                    run_id, organization, repository, file_path,
                    author_name, author_email, surviving_lines, file_lines,
                    ownership_share
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        self.ensure_schema()
        with self.connect() as connection:
            connection.executemany(
                """
                INSERT OR REPLACE INTO member_repository_ownership (
                    run_id, organization, repository, author_name, author_email,
                    surviving_lines, repository_lines, ownership_share,
                    files_owned, majority_owned_files, rank
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        self.ensure_schema()
        with self.connect() as connection:
            connection.executemany(
                """
                INSERT OR REPLACE INTO member_ownership (
                    run_id, organization, author_name, author_email,
                    surviving_lines, surviving_commits, files_owned,
                    repositories, majority_owned_files, average_file_share
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                values,
            )
        return len(values)
