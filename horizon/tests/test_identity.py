from datetime import datetime, timezone

from pipeline.blame_parser import parse_blame_capture
from pipeline.identity import resolve_git_identities
from pipeline.pull_requests import materialize_pr_linked_commit_messages
from pipeline.resources import (
    AuthentikRoster,
    AuthentikUser,
    PullRequestCommit,
)


def _blame_line(sha: str, line_number: int, name: str, email: str) -> str:
    return (
        f"{sha} {line_number} {line_number}\n"
        f"author {name}\n"
        f"author-mail <{email}>\n"
        "author-time 1710000000\n"
        "author-tz +0000\n"
        f"committer {name}\n"
        f"committer-mail <{email}>\n"
        "committer-time 1710000000\n"
        "committer-tz +0000\n"
        "summary add source\n"
        "filename src/app.py\n"
        f"\tline {line_number}\n"
    )


def test_identity_resolution_covers_blame_and_pr_only_authors_exactly():
    roster_time = datetime(2026, 10, 26, tzinfo=timezone.utc)
    roster = AuthentikRoster(
        users=[
            AuthentikUser("pk-alice", "alice", "alice@example.test", "Alice", True, roster_time),
            AuthentikUser("pk-shared-a", "shared-a", "shared@example.test", "Shared A", True, roster_time),
            AuthentikUser("pk-shared-b", "shared-b", "shared@example.test", "Shared B", True, roster_time),
        ],
        retrieved_at=roster_time,
    )
    sha = "a" * 40
    capture = (
        "===== git blame --line-porcelain -w -M -C -- org/repo:src/app.py =====\n"
        + _blame_line(sha, 1, "Alice", "alice@example.test")
        + _blame_line(sha, 2, "Shared", "shared@example.test")
    )
    blame = parse_blame_capture(capture)
    commits = [
        PullRequestCommit(
            "org", "repo", 7, "b" * 40, "Alice", "alice@example.test",
            roster_time, "Alice's PR commit",
        ),
        PullRequestCommit(
            "org", "repo", 8, "c" * 40, "PR Only", "pr@example.test",
            roster_time, "PR-only identity",
        ),
    ]

    rows = resolve_git_identities(blame, roster, commits)
    by_raw = {(row.author_name, row.author_email): row for row in rows}

    alice = by_raw[("Alice", "alice@example.test")]
    assert alice.authentik_user_pk == "pk-alice"
    assert alice.evidence_sources == ("git_blame", "gitea_pr_commit")
    assert alice.blame_line_count == 1
    assert alice.pull_request_commit_count == 1

    shared = by_raw[("Shared", "shared@example.test")]
    assert shared.authentik_user_pk is None
    assert shared.match_method == "ambiguous_email"
    assert shared.candidate_count == 2

    pr_only = by_raw[("PR Only", "pr@example.test")]
    assert pr_only.authentik_user_pk is None
    assert pr_only.match_method == "unmatched"
    assert pr_only.pull_request_commit_count == 1

    linked = materialize_pr_linked_commit_messages(commits, rows, "run-1")
    assert linked[0].authentik_user_pk == "pk-alice"
    assert linked[1].identity_resolution == "unmatched"
