"""Pure ownership calculations over parsed git-blame records.

The calculations deliberately stay separate from Dagster and Postgres.  That
keeps the definitions easy to test and gives the eventual database migration a
small boundary: change the store, not the metric definitions.

The numbers describe surviving lines in the current snapshot.  A surviving
commit is a distinct commit SHA that still owns at least one surviving line;
this is not the same thing as counting every commit created during a semester.
"""

from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass, replace
from pathlib import PurePosixPath
from typing import TYPE_CHECKING

from .blame_parser import BlameRecord

if TYPE_CHECKING:
    from .identity import IdentityCluster


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


@dataclass(frozen=True)
class EligibleFileOwnership:
    """Eligible source-code ownership for one member in one current file.

    Only source files admitted by :func:`classify_source_path` appear here.
    Boundary lines remain in the file share and majority calculation so those
    measures describe the complete current snapshot; the separate non-boundary
    count is the de-scaffolded line input used by the engineering rubric. Exact
    email aliases resolve to one Authentik PK; unresolved identities remain
    separate and carry a null PK. The raw identity payload keeps every alias
    available for audit.
    """

    organization: str
    repository: str
    file_path: str
    authentik_user_pk: str | None
    identity_resolution: str
    raw_author_identities_json: list[dict[str, str | int | None]]
    eligible_source_lines: int
    eligible_file_lines: int
    non_boundary_source_lines: int
    ownership_share: float
    non_boundary_ownership_share: float


@dataclass(frozen=True)
class EngineeringContribution:
    """Auditable, repository-scoped inputs to the engineering rubric.

    Rows deliberately stay at repository grain. A downstream scoring layer can
    compare within its approved cohort without treating line totals from a
    small repository as equivalent to the same totals from a much larger one.
    """

    organization: str
    repository: str
    authentik_user_pk: str | None
    identity_resolution: str
    raw_author_identities_json: list[dict[str, str | int | None]]
    eligible_source_lines: int
    non_boundary_surviving_lines: int
    log_non_boundary_surviving_lines: float
    eligible_repository_lines: int
    non_boundary_repository_lines: int
    repository_ownership_share: float
    non_boundary_repository_share: float
    files_owned: int
    majority_owned_files: int
    surviving_commits: int
    eligible_repository_files: int


Identity = tuple[str, str]
FileKey = tuple[str, str, str]
RepositoryKey = tuple[str, str]
IdentityGroup = tuple[str, str, str]


SOURCE_CODE_SUFFIXES = frozenset(
    {
        ".c", ".h", ".cc", ".hh", ".cpp", ".hpp", ".cxx", ".hxx",
        ".m", ".mm", ".cs", ".fs", ".fsi", ".fsx", ".vb",
        ".py", ".pyi", ".pyx", ".pxd", ".pxi",
        ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
        ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".sc", ".groovy",
        ".php", ".rb", ".rake", ".ex", ".exs", ".erl", ".hrl",
        ".hs", ".lhs", ".lua", ".pl", ".pm", ".r", ".swift", ".dart",
        ".vue", ".svelte", ".astro", ".sql", ".sh", ".bash", ".zsh",
        ".ps1", ".psm1", ".bat", ".cmd", ".html", ".htm", ".css",
        ".scss", ".sass", ".less", ".graphql", ".gql", ".proto",
    }
)

_LOCKFILE_NAMES = frozenset(
    {
        "bun.lock", "bun.lockb", "cargo.lock", "composer.lock",
        "deno.lock", "flake.lock", "gemfile.lock", "go.sum",
        "gradle.lockfile", "mix.lock", "npm-shrinkwrap.json",
        "package-lock.json", "pipfile.lock", "poetry.lock",
        "pnpm-lock.yaml", "uv.lock", "yarn.lock",
    }
)
_VENDORED_DIRECTORIES = frozenset(
    {
        "vendor", "vendors", "third_party", "third-party", "thirdparty",
        "bower_components", "node_modules",
    }
)
_GENERATED_DIRECTORIES = frozenset(
    {
        "generated", "__generated__", "autogenerated", "auto-generated",
        "build", "dist", "target", "coverage", "site-packages", "obj",
        ".next", ".nuxt", ".venv", "venv", "out",
    }
)
_GENERATED_FILE_RE = re.compile(
    r"(?:\.generated|_generated|\.gen|_gen|\.pb|_pb2|\.min)\.[^.]+$|\.designer\.cs$",
    re.IGNORECASE,
)


def classify_source_path(path: str) -> tuple[bool, str]:
    """Return whether a tracked path is eligible code and why.

    This is intentionally a deterministic path-based policy: files without a
    recognized source suffix are excluded, as are common generated, vendored,
    and dependency-lock paths. It does not claim to detect every generated
    file; teams can extend the policy when repository conventions are known.
    """

    normalized = path.replace("\\", "/")
    parsed = PurePosixPath(normalized)
    parts = tuple(part.casefold() for part in parsed.parts)
    basename = parsed.name.casefold()

    if basename in _LOCKFILE_NAMES or basename.endswith(".lock"):
        return False, "lockfile"
    if any(part in _VENDORED_DIRECTORIES for part in parts[:-1]):
        return False, "vendored"
    if any(part in _GENERATED_DIRECTORIES for part in parts[:-1]) or _GENERATED_FILE_RE.search(
        basename
    ):
        return False, "generated"
    if parsed.suffix.casefold() not in SOURCE_CODE_SUFFIXES:
        return False, "non_source"
    return True, "source_code"


def _validate_unique_blame_lines(records: list[BlameRecord]) -> None:
    """Fail rather than inflate metrics if one current line appears twice."""

    seen: set[tuple[str, str, str, int]] = set()
    for record in records:
        key = (
            record.organization,
            record.repository,
            record.blamed_file_path,
            record.line_number_in_file,
        )
        if key in seen:
            raise ValueError(
                "duplicate blame record for current line "
                f"{record.organization}/{record.repository}:{record.blamed_file_path}:"
                f"{record.line_number_in_file}"
            )
        seen.add(key)


def classify_source_paths(records: list[BlameRecord]) -> dict[str, int]:
    """Count unique captured files by eligibility class for run-level audit."""

    paths = {
        (record.organization, record.repository, record.blamed_file_path)
        for record in records
    }
    counts: dict[str, int] = defaultdict(int)
    for _, _, path in paths:
        _, category = classify_source_path(path)
        counts[category] += 1
    return dict(sorted(counts.items()))


def _identity_group(cluster: IdentityCluster) -> IdentityGroup:
    """Canonicalize a uniquely resolved identity; isolate every unresolved one."""

    if cluster.authentik_user_pk is not None:
        return ("member", cluster.authentik_user_pk, "")
    return ("raw", cluster.author_name, cluster.author_email)


def _identity_clusters_by_raw_identity(
    records: list[BlameRecord],
    identity_clusters: list[IdentityCluster],
) -> dict[Identity, IdentityCluster]:
    """Validate the exact one-row-per-raw-identity mapping from the identity asset."""

    expected = {(record.author_name, record.author_email) for record in records}
    result: dict[Identity, IdentityCluster] = {}
    for cluster in identity_clusters:
        key = (cluster.author_name, cluster.author_email)
        if key in result:
            raise ValueError(f"duplicate identity-cluster row for {key!r}")
        if cluster.authentik_user_pk is not None:
            if cluster.match_method != "directory_email" or cluster.candidate_count != 1:
                raise ValueError(
                    "a canonical member PK requires one exact directory-email match"
                )
        elif cluster.match_method == "directory_email" or cluster.candidate_count == 1:
            raise ValueError(
                "a unique exact directory-email match must carry its canonical member PK"
            )
        result[key] = cluster

    missing = expected - set(result)
    if missing:
        raise ValueError(
            "identity-cluster rows do not cover all raw Git identities "
            "in parsed blame"
        )
    return result


def _raw_identity_payload(
    identities: set[Identity],
    clusters: dict[Identity, IdentityCluster],
) -> list[dict[str, str | int | None]]:
    """Return stable JSON-compatible raw identity evidence for one member row."""

    return [
        {
            "author_name": name,
            "author_email": email,
            "authentik_user_pk": clusters[(name, email)].authentik_user_pk,
            "match_method": clusters[(name, email)].match_method,
            "candidate_count": clusters[(name, email)].candidate_count,
        }
        for name, email in sorted(identities, key=lambda identity: (identity[1], identity[0]))
    ]


def _row_identity_group(row: EligibleFileOwnership) -> IdentityGroup:
    """Recover the grouping key and reject malformed audit payloads."""

    if row.authentik_user_pk is not None:
        if row.identity_resolution != "directory_email":
            raise ValueError("resolved member row has an unexpected resolution status")
        if not row.raw_author_identities_json:
            raise ValueError("resolved member row is missing its raw identity audit list")
        if any(
            item.get("authentik_user_pk") != row.authentik_user_pk
            or item.get("match_method") != "directory_email"
            or item.get("candidate_count") != 1
            for item in row.raw_author_identities_json
        ):
            raise ValueError("resolved member row contains an identity not mapped uniquely to its PK")
        return ("member", row.authentik_user_pk, "")

    if row.identity_resolution not in {"unmatched", "ambiguous_email"}:
        raise ValueError("unresolved member row has an unexpected resolution status")
    if len(row.raw_author_identities_json) != 1:
        raise ValueError("unresolved identities must remain separate and have one raw identity")
    raw = row.raw_author_identities_json[0]
    name = raw.get("author_name")
    email = raw.get("author_email")
    if not isinstance(name, str) or not isinstance(email, str):
        raise ValueError("raw identity audit entry is missing its Git name or email")
    if raw.get("authentik_user_pk") is not None or raw.get("match_method") != row.identity_resolution:
        raise ValueError("unresolved identity audit entry conflicts with its row status")
    return ("raw", name, email)


def calculate_eligible_file_ownership(
    records: list[BlameRecord],
    identity_clusters: list[IdentityCluster],
) -> list[EligibleFileOwnership]:
    """Calculate eligible file shares grouped by resolved member identity."""

    _validate_unique_blame_lines(records)
    clusters = _identity_clusters_by_raw_identity(records, identity_clusters)
    file_lines: dict[FileKey, int] = defaultdict(int)
    file_non_boundary_lines: dict[FileKey, int] = defaultdict(int)
    member_lines: dict[tuple[FileKey, IdentityGroup], int] = defaultdict(int)
    member_non_boundary_lines: dict[tuple[FileKey, IdentityGroup], int] = defaultdict(int)
    raw_identities: dict[tuple[FileKey, IdentityGroup], set[Identity]] = defaultdict(set)

    for record in records:
        eligible, _ = classify_source_path(record.blamed_file_path)
        if not eligible:
            continue
        file_key = (record.organization, record.repository, record.blamed_file_path)
        raw_identity = (record.author_name, record.author_email)
        cluster = clusters[raw_identity]
        group = _identity_group(cluster)
        key = (file_key, group)
        file_lines[file_key] += 1
        member_lines[key] += 1
        raw_identities[key].add(raw_identity)
        if not record.reaches_history_boundary:
            file_non_boundary_lines[file_key] += 1
            member_non_boundary_lines[key] += 1

    rows = []
    for (file_key, group), lines in member_lines.items():
        organization, repository, file_path = file_key
        total_lines = file_lines[(organization, repository, file_path)]
        non_boundary_lines = member_non_boundary_lines[(file_key, group)]
        all_non_boundary_lines = file_non_boundary_lines[file_key]
        payload = _raw_identity_payload(raw_identities[(file_key, group)], clusters)
        representative = clusters[
            (payload[0]["author_name"], payload[0]["author_email"])
        ]
        rows.append(
            EligibleFileOwnership(
                organization=organization,
                repository=repository,
                file_path=file_path,
                authentik_user_pk=representative.authentik_user_pk,
                identity_resolution=representative.match_method,
                raw_author_identities_json=payload,
                eligible_source_lines=lines,
                eligible_file_lines=total_lines,
                non_boundary_source_lines=non_boundary_lines,
                ownership_share=lines / total_lines,
                non_boundary_ownership_share=(
                    non_boundary_lines / all_non_boundary_lines
                    if all_non_boundary_lines
                    else 0.0
                ),
            )
        )
    return sorted(
        rows,
        key=lambda row: (
            row.organization,
            row.repository,
            row.file_path,
            -row.eligible_source_lines,
            row.authentik_user_pk or "",
            json.dumps(row.raw_author_identities_json, sort_keys=True),
        ),
    )


def calculate_engineering_contribution(
    records: list[BlameRecord],
    file_rows: list[EligibleFileOwnership],
    identity_clusters: list[IdentityCluster],
) -> list[EngineeringContribution]:
    """Build repository-scoped contribution rows grouped by canonical member."""

    _validate_unique_blame_lines(records)
    clusters = _identity_clusters_by_raw_identity(records, identity_clusters)
    repo_lines: dict[RepositoryKey, int] = defaultdict(int)
    repo_non_boundary_lines: dict[RepositoryKey, int] = defaultdict(int)
    repo_files: dict[RepositoryKey, set[str]] = defaultdict(set)
    repo_member_commits: dict[tuple[RepositoryKey, IdentityGroup], set[str]] = defaultdict(set)
    repo_member_raw_identities: dict[
        tuple[RepositoryKey, IdentityGroup], set[Identity]
    ] = defaultdict(set)
    for record in records:
        eligible, _ = classify_source_path(record.blamed_file_path)
        if not eligible:
            continue
        repo_key = (record.organization, record.repository)
        raw_identity = (record.author_name, record.author_email)
        group = _identity_group(clusters[raw_identity])
        repo_lines[repo_key] += 1
        repo_files[repo_key].add(record.blamed_file_path)
        if not record.reaches_history_boundary:
            repo_non_boundary_lines[repo_key] += 1
        repo_member_commits[(repo_key, group)].add(record.commit_sha)
        repo_member_raw_identities[(repo_key, group)].add(raw_identity)

    by_member: dict[
        tuple[RepositoryKey, IdentityGroup], list[EligibleFileOwnership]
    ] = defaultdict(list)
    for row in file_rows:
        group = _row_identity_group(row)
        by_member[((row.organization, row.repository), group)].append(row)

    expected_file_rows: dict[tuple[FileKey, IdentityGroup], tuple[int, int]] = {}
    expected_file_totals: dict[FileKey, int] = defaultdict(int)
    expected_file_non_boundary_totals: dict[FileKey, int] = defaultdict(int)
    expected_file_raw_identities: dict[
        tuple[FileKey, IdentityGroup], set[Identity]
    ] = defaultdict(set)
    for record in records:
        eligible, _ = classify_source_path(record.blamed_file_path)
        if not eligible:
            continue
        file_key = (record.organization, record.repository, record.blamed_file_path)
        raw_identity = (record.author_name, record.author_email)
        group = _identity_group(clusters[raw_identity])
        row_key = (file_key, group)
        lines, non_boundary = expected_file_rows.get(row_key, (0, 0))
        expected_file_rows[row_key] = (
            lines + 1,
            non_boundary + (0 if record.reaches_history_boundary else 1),
        )
        expected_file_raw_identities[row_key].add(raw_identity)
        expected_file_totals[file_key] += 1
        if not record.reaches_history_boundary:
            expected_file_non_boundary_totals[file_key] += 1

    actual_file_rows = {
        (
            (row.organization, row.repository, row.file_path),
            _row_identity_group(row),
        ): row
        for row in file_rows
    }
    if len(actual_file_rows) != len(file_rows) or set(actual_file_rows) != set(expected_file_rows):
        raise ValueError(
            "eligible file ownership rows do not cover exactly the eligible "
            "blame identities"
        )
    for row_key, (lines, non_boundary) in expected_file_rows.items():
        row = actual_file_rows[row_key]
        file_key, group = row_key
        expected_raw_payload = _raw_identity_payload(
            expected_file_raw_identities[row_key], clusters
        )
        if (
            row.eligible_file_lines != expected_file_totals[file_key]
            or row.eligible_source_lines != lines
            or row.non_boundary_source_lines != non_boundary
            or row.raw_author_identities_json != expected_raw_payload
            or not math.isclose(
                row.ownership_share,
                lines / expected_file_totals[file_key],
                rel_tol=0.0,
                abs_tol=1e-12,
            )
            or not math.isclose(
                row.non_boundary_ownership_share,
                (
                    non_boundary / expected_file_non_boundary_totals[file_key]
                    if expected_file_non_boundary_totals[file_key]
                    else 0.0
                ),
                rel_tol=0.0,
                abs_tol=1e-12,
            )
        ):
            raise ValueError(
                "eligible file ownership row does not match parsed blame for "
                f"{row.organization}/{row.repository}:{row.file_path}"
            )

    rows: list[EngineeringContribution] = []
    for (repo_key, group), member_rows in by_member.items():
        organization, repository = repo_key
        representative_identity = min(
            repo_member_raw_identities[(repo_key, group)],
            key=lambda identity: (identity[1], identity[0]),
        )
        representative = clusters[representative_identity]
        repo_key = (organization, repository)
        member_lines = sum(row.eligible_source_lines for row in member_rows)
        member_non_boundary = sum(row.non_boundary_source_lines for row in member_rows)
        boundary_aware_repo_lines = repo_lines[repo_key]
        non_boundary_repo_lines = repo_non_boundary_lines[repo_key]
        rows.append(
            EngineeringContribution(
                organization=organization,
                repository=repository,
                authentik_user_pk=representative.authentik_user_pk,
                identity_resolution=representative.match_method,
                raw_author_identities_json=_raw_identity_payload(
                    repo_member_raw_identities[(repo_key, group)], clusters
                ),
                eligible_source_lines=member_lines,
                non_boundary_surviving_lines=member_non_boundary,
                log_non_boundary_surviving_lines=math.log1p(member_non_boundary),
                eligible_repository_lines=boundary_aware_repo_lines,
                non_boundary_repository_lines=non_boundary_repo_lines,
                repository_ownership_share=member_lines / boundary_aware_repo_lines,
                non_boundary_repository_share=(
                    member_non_boundary / non_boundary_repo_lines
                    if non_boundary_repo_lines
                    else 0.0
                ),
                files_owned=len({row.file_path for row in member_rows}),
                majority_owned_files=sum(
                    1 for row in member_rows if row.ownership_share > 0.5
                ),
                surviving_commits=len(
                    repo_member_commits[(repo_key, group)]
                ),
                eligible_repository_files=len(repo_files[repo_key]),
            )
        )
    return sorted(
        rows,
        key=lambda row: (
            row.organization,
            row.repository,
            -row.eligible_source_lines,
            row.authentik_user_pk or "",
            json.dumps(row.raw_author_identities_json, sort_keys=True),
        ),
    )


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
