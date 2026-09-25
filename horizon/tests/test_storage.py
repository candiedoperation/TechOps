import sqlite3

from pipeline.ownership import FileOwnership, MemberOwnership, MemberRepositoryOwnership
from pipeline.storage import SQLiteResource


def test_sqlite_store_creates_and_writes_ownership_tables(tmp_path):
    store = SQLiteResource(database_path=str(tmp_path / "horizon.sqlite3"))
    file_row = FileOwnership("org", "repo", "a.py", "Alice", "a@example.com", 2, 2, 1.0)
    repository_row = MemberRepositoryOwnership(
        "org", "repo", "Alice", "a@example.com", 2, 2, 1.0, 1, 1, 1
    )
    member_row = MemberOwnership(
        "org", "Alice", "a@example.com", 2, 1, 1, 1, 1, 1.0
    )

    assert store.write_file_ownership("run-1", [file_row]) == 1
    assert store.write_member_repository_ownership("run-1", [repository_row]) == 1
    assert store.write_member_ownership("run-1", [member_row]) == 1

    with store.connect() as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {
            "file_ownership",
            "member_repository_ownership",
            "member_ownership",
        } <= tables
        assert connection.execute(
            "SELECT surviving_lines FROM member_ownership WHERE run_id = ?",
            ("run-1",),
        ).fetchone()[0] == 2
