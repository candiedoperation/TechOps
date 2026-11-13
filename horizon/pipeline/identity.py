"""Pure mapping from raw Git author identities to Authentik member IDs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from collections import Counter
from collections.abc import Sequence

from .blame_parser import BlameRecord
from .resources import AuthentikRoster, PullRequestCommit


@dataclass(frozen=True)
class IdentityCluster:
    """One distinct raw Git author identity and its exact-email resolution."""

    author_name: str
    author_email: str
    authentik_user_pk: str | None
    match_method: str
    candidate_count: int
    evidence_sources: tuple[str, ...]
    blame_line_count: int
    pull_request_commit_count: int
    source_name: str
    source_retrieved_at: datetime


PEOPLEPORTAL_ROSTER_SOURCE = "peopleportal_authentik_onboarded_users"


def resolve_git_identities(
    blame_records: list[BlameRecord],
    roster: AuthentikRoster,
    pull_request_commits: Sequence[PullRequestCommit] = (),
) -> list[IdentityCluster]:
    """Resolve only a unique, exact Git-email to Authentik-email match.

    Missing email matches and duplicate directory emails stay in the output with
    a null PK and an explicit status so downstream consumers can review them.
    Display names, usernames, inactive status, and fuzzy/alias matching never
    affect the result.
    """

    users_by_email: dict[str, list[str]] = {}
    for user in roster.users:
        if user.email:
            users_by_email.setdefault(user.email, []).append(user.authentik_user_pk)

    evidence: dict[tuple[str, str], Counter[str]] = {}
    for record in blame_records:
        identity = (record.author_name, record.author_email)
        evidence.setdefault(identity, Counter())["git_blame"] += 1
    for commit in pull_request_commits:
        identity = (commit.author_name, commit.author_email)
        evidence.setdefault(identity, Counter())["gitea_pr_commit"] += 1

    raw_identities = sorted(
        evidence,
        key=lambda identity: (identity[1], identity[0]),
    )
    clusters: list[IdentityCluster] = []
    for author_name, author_email in raw_identities:
        candidates = users_by_email.get(author_email, []) if author_email else []
        if len(candidates) == 1:
            authentik_user_pk = candidates[0]
            match_method = "directory_email"
        else:
            authentik_user_pk = None
            match_method = "ambiguous_email" if candidates else "unmatched"

        clusters.append(
            IdentityCluster(
                author_name=author_name,
                author_email=author_email,
                authentik_user_pk=authentik_user_pk,
                match_method=match_method,
                candidate_count=len(candidates),
                evidence_sources=tuple(sorted(evidence[(author_name, author_email)])),
                blame_line_count=evidence[(author_name, author_email)]["git_blame"],
                pull_request_commit_count=evidence[(author_name, author_email)][
                    "gitea_pr_commit"
                ],
                source_name=PEOPLEPORTAL_ROSTER_SOURCE,
                source_retrieved_at=roster.retrieved_at,
            )
        )
    return clusters
