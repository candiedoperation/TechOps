from pipeline.blame_parser import BlameRecord
from pipeline.ownership import (
    calculate_file_ownership,
    calculate_member_ownership,
    calculate_member_repository_ownership,
)


def record(
    *,
    path: str,
    author: str,
    email: str,
    commit: str,
    repository: str = "repo-a",
) -> BlameRecord:
    return BlameRecord(
        organization="org",
        repository=repository,
        blamed_file_path=path,
        line_number_in_file=1,
        commit_sha=commit,
        commit_summary="summary",
        consecutive_line_count=None,
        line_number_at_origin=1,
        author_name=author,
        author_email=email,
        authored_at_epoch=1,
        author_utc_offset="+0000",
        committer_name=author,
        committer_email=email,
        committed_at_epoch=1,
        committer_utc_offset="+0000",
        origin_file_path=path,
        previous_commit_sha=None,
        previous_file_path=None,
        reaches_history_boundary=False,
    )


def test_ownership_calculates_file_and_repository_shares():
    records = [
        record(path="a.py", author="Alice", email="a@example.com", commit="a1"),
        record(path="a.py", author="Alice", email="a@example.com", commit="a2"),
        record(path="a.py", author="Bob", email="b@example.com", commit="b1"),
        record(path="b.py", author="Bob", email="b@example.com", commit="b1"),
    ]

    file_rows = calculate_file_ownership(records)
    assert [(row.file_path, row.author_name, row.surviving_lines, row.file_lines) for row in file_rows] == [
        ("a.py", "Alice", 2, 3),
        ("a.py", "Bob", 1, 3),
        ("b.py", "Bob", 1, 1),
    ]
    assert file_rows[0].ownership_share == 2 / 3

    repository_rows = calculate_member_repository_ownership(file_rows)
    assert [(row.author_name, row.surviving_lines, row.rank) for row in repository_rows] == [
        ("Alice", 2, 1),
        ("Bob", 2, 2),
    ]
    assert repository_rows[0].ownership_share == 2 / 4


def test_member_ownership_counts_distinct_surviving_commits():
    records = [
        record(path="a.py", author="Alice", email="a@example.com", commit="a1"),
        record(path="a.py", author="Alice", email="a@example.com", commit="a1"),
        record(path="b.py", author="Alice", email="a@example.com", commit="a2"),
        record(path="a.py", author="Bob", email="b@example.com", commit="b1"),
    ]
    file_rows = calculate_file_ownership(records)
    repository_rows = calculate_member_repository_ownership(file_rows)
    member_rows = calculate_member_ownership(records, file_rows, repository_rows)

    alice = next(row for row in member_rows if row.author_name == "Alice")
    assert alice.surviving_lines == 3
    assert alice.surviving_commits == 2
    assert alice.files_owned == 2
    assert alice.repositories == 1
    assert alice.majority_owned_files == 2
    assert alice.average_file_share == (2 / 3 + 1) / 2
