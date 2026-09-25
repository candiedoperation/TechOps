"""Pure ownership calculations over parsed git-blame records.

The calculations deliberately stay separate from Dagster and SQLite.  That
keeps the definitions easy to test and gives the eventual database migration a
small boundary: change the store, not the metric definitions.

The numbers describe surviving lines in the current snapshot.  A surviving
commit is a distinct commit SHA that still owns at least one surviving line;
this is not the same thing as counting every commit created during a semester.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, replace

from .blame_parser import BlameRecord


@dataclass(frozen=True)
class FileOwnership:
    """A member's surviving-line share of one file."""

    organization: str
    repository: str
    file_path: str
    author_name: str
    author_email: str
    surviving_lines: int
    file_lines: int
    ownership_share: float


@dataclass(frozen=True)
class MemberRepositoryOwnership:
    """A member's surviving-line share of one repository."""

    organization: str
    repository: str
    author_name: str
    author_email: str
    surviving_lines: int
    repository_lines: int
    ownership_share: float
    files_owned: int
    majority_owned_files: int
    rank: int


@dataclass(frozen=True)
class MemberOwnership:
    """A member's aggregate surviving contribution across the snapshot."""

    organization: str
    author_name: str
    author_email: str
    surviving_lines: int
    surviving_commits: int
    files_owned: int
    repositories: int
    majority_owned_files: int
    average_file_share: float


Identity = tuple[str, str]
FileKey = tuple[str, str, str]
RepositoryKey = tuple[str, str]


def calculate_file_ownership(records: list[BlameRecord]) -> list[FileOwnership]:
    """Count surviving lines by file and author, then calculate file share."""

    file_lines: dict[FileKey, int] = defaultdict(int)
    author_lines: dict[tuple[FileKey, Identity], int] = defaultdict(int)

    for record in records:
        file_key = (record.organization, record.repository, record.blamed_file_path)
        identity = (record.author_name, record.author_email)
        file_lines[file_key] += 1
        author_lines[(file_key, identity)] += 1

    rows = [
        FileOwnership(
            organization=organization,
            repository=repository,
            file_path=file_path,
            author_name=author_name,
            author_email=author_email,
            surviving_lines=lines,
            file_lines=file_lines[(organization, repository, file_path)],
            ownership_share=lines / file_lines[(organization, repository, file_path)],
        )
        for (
            (organization, repository, file_path),
            (author_name, author_email),
        ), lines in author_lines.items()
    ]
    return sorted(
        rows,
        key=lambda row: (
            row.organization,
            row.repository,
            row.file_path,
            -row.surviving_lines,
            row.author_email,
            row.author_name,
        ),
    )


def calculate_member_repository_ownership(
    file_rows: list[FileOwnership],
) -> list[MemberRepositoryOwnership]:
    """Aggregate file rows into one ownership row per member and repository."""

    repository_lines: dict[RepositoryKey, int] = defaultdict(int)
    seen_files: set[FileKey] = set()
    for row in file_rows:
        file_key = (row.organization, row.repository, row.file_path)
        if file_key not in seen_files:
            repository_lines[(row.organization, row.repository)] += row.file_lines
            seen_files.add(file_key)

    grouped: dict[
        tuple[str, str, str, str], list[FileOwnership]
    ] = defaultdict(list)
    for row in file_rows:
        grouped[
            (row.organization, row.repository, row.author_name, row.author_email)
        ].append(row)

    rows = []
    for (organization, repository, author_name, author_email), member_rows in grouped.items():
        rows.append(
            MemberRepositoryOwnership(
                organization=organization,
                repository=repository,
                author_name=author_name,
                author_email=author_email,
                surviving_lines=sum(row.surviving_lines for row in member_rows),
                repository_lines=repository_lines[(organization, repository)],
                ownership_share=(
                    sum(row.surviving_lines for row in member_rows)
                    / repository_lines[(organization, repository)]
                ),
                files_owned=len({row.file_path for row in member_rows}),
                majority_owned_files=sum(
                    1 for row in member_rows if row.ownership_share > 0.5
                ),
                rank=0,
            )
        )

    ranked: list[MemberRepositoryOwnership] = []
    for repository in sorted({(row.organization, row.repository) for row in rows}):
        repository_rows = sorted(
            (
                row
                for row in rows
                if (row.organization, row.repository) == repository
            ),
            key=lambda row: (-row.surviving_lines, row.author_email, row.author_name),
        )
        ranked.extend(
            replace(row, rank=rank)
            for rank, row in enumerate(repository_rows, start=1)
        )
    return ranked


def calculate_member_ownership(
    records: list[BlameRecord],
    file_rows: list[FileOwnership],
    repository_rows: list[MemberRepositoryOwnership],
) -> list[MemberOwnership]:
    """Aggregate ownership and distinct surviving commit counts."""

    commits: dict[tuple[str, Identity], set[tuple[str, str]]] = defaultdict(set)
    for record in records:
        commits[(record.organization, (record.author_name, record.author_email))].add(
            (record.repository, record.commit_sha)
        )

    grouped: dict[tuple[str, str, str], list[MemberRepositoryOwnership]] = defaultdict(list)
    for row in repository_rows:
        grouped[(row.organization, row.author_name, row.author_email)].append(row)

    rows = [
        MemberOwnership(
            organization=organization,
            author_name=author_name,
            author_email=author_email,
            surviving_lines=sum(row.surviving_lines for row in member_rows),
            surviving_commits=len(
                commits[(organization, (author_name, author_email))]
            ),
            files_owned=sum(row.files_owned for row in member_rows),
            repositories=len(member_rows),
            majority_owned_files=sum(row.majority_owned_files for row in member_rows),
            average_file_share=0.0,
        )
        for (organization, author_name, author_email), member_rows in grouped.items()
    ]

    shares: dict[tuple[str, str, str], list[float]] = defaultdict(list)
    for row in file_rows:
        shares[(row.organization, row.author_name, row.author_email)].append(
            row.ownership_share
        )

    return sorted(
        [
            replace(
                row,
                average_file_share=sum(
                    shares[(row.organization, row.author_name, row.author_email)]
                )
                / len(shares[(row.organization, row.author_name, row.author_email)]),
            )
            for row in rows
        ],
        key=lambda row: (
            row.organization,
            -row.surviving_lines,
            row.author_email,
            row.author_name,
        ),
    )

