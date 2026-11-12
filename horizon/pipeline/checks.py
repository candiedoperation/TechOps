"""Asset checks: the places where "it ran" is not the same as "it worked".

Every check here exists because the legacy run passed without one. It recorded
``blame_lines: 0`` for all 132 members and reported ``blame_status: complete``,
because nothing threw -- so completeness was inferred from the absence of an
exception rather than from the presence of data. These assert the presence of
data.
"""

# No `from __future__ import annotations` in this module: Dagster resolves the
# context and asset-input annotations at decoration time, and PEP 563 turns them
# into strings it then refuses.
from dagster import AssetCheckResult, AssetCheckSeverity, AssetIn, asset_check

from .assets import (
    BlameCapture,
    authentik_users,
    blame_capture,
    blame_records,
    identity_clusters,
    member_pr_review_counts,
)
from .blame_parser import BlameRecord
from .identity import IdentityCluster
from .pull_requests import PullRequestReviewCounts
from .resources import AuthentikRoster


@asset_check(
    asset=authentik_users,
    description="The People Portal-managed Authentik roster contains members.",
)
def roster_is_non_empty(authentik_users: AuthentikRoster) -> AssetCheckResult:
    count = len(authentik_users.users)
    return AssetCheckResult(
        passed=count > 0,
        severity=AssetCheckSeverity.ERROR,
        description=(
            f"Roster contains {count} user(s)."
            if count
            else "The roster is empty; refusing to treat this as a valid member snapshot."
        ),
        metadata={"users": count, "retrieved_at": authentik_users.retrieved_at.isoformat()},
    )


@asset_check(
    asset=identity_clusters,
    description=(
        "Unmatched and ambiguous Git author emails stay visible for human review."
    ),
)
def git_identity_mappings_need_review(
    identity_clusters: list[IdentityCluster],
) -> AssetCheckResult:
    unresolved = [row for row in identity_clusters if row.authentik_user_pk is None]
    unmatched = sum(row.match_method == "unmatched" for row in unresolved)
    ambiguous = sum(row.match_method == "ambiguous_email" for row in unresolved)
    passed = bool(identity_clusters) and not unresolved
    return AssetCheckResult(
        passed=passed,
        severity=AssetCheckSeverity.WARN,
        description=(
            f"All {len(identity_clusters)} Git identities resolve to one roster PK."
            if passed
            else f"{unmatched} unmatched and {ambiguous} ambiguous Git identity(ies) need review."
        ),
        metadata={
            "identities": len(identity_clusters),
            "resolved": len(identity_clusters) - len(unresolved),
            "unmatched": unmatched,
            "ambiguous": ambiguous,
        },
    )


@asset_check(
    asset=member_pr_review_counts,
    description=(
        "Submitted PR reviews map to a unique Authentik username; unresolved "
        "Gitea logins stay visible for manual review."
    ),
)
def pr_reviewers_resolve_or_need_review(
    member_pr_review_counts: PullRequestReviewCounts,
) -> AssetCheckResult:
    unresolved = member_pr_review_counts.unresolved_reviewers
    logins = sorted({review.reviewer_login for review in unresolved})
    return AssetCheckResult(
        passed=not unresolved,
        severity=AssetCheckSeverity.WARN,
        description=(
            "Every submitted review maps to one roster member."
            if not unresolved
            else f"{len(unresolved)} submitted review(s) from {len(logins)} "
            "unresolved or ambiguous Gitea login(s) need review."
        ),
        metadata={
            "unresolved_reviews": len(unresolved),
            "unresolved_reviewer_logins": logins,
            "submitted_reviews_observed": member_pr_review_counts.submitted_reviews_observed,
        },
    )


@asset_check(
    asset=blame_capture,
    description="A capture that blamed no files at all is a failure, not an empty repo.",
)
def capture_is_non_empty(blame_capture: BlameCapture) -> AssetCheckResult:
    passed = blame_capture.files_captured > 0 and blame_capture.files_failed == 0

    if passed:
        description = (
            f"{blame_capture.files_captured} of {blame_capture.files_tracked} tracked "
            f"files captured ({blame_capture.files_skipped_binary} binary, "
            f"{blame_capture.files_empty} empty, 0 failed; "
            f"{blame_capture.bytes_written} bytes)."
        )
    else:
        description = (
            f"{blame_capture.slug} has an unusable capture: "
            f"{blame_capture.files_tracked} tracked files "
            f"({blame_capture.files_captured} captured, "
            f"{blame_capture.files_skipped_binary} binary, "
            f"{blame_capture.files_empty} empty, "
            f"{blame_capture.files_failed} failed). A failed or empty capture "
            "cannot be used for attribution."
        )

    return AssetCheckResult(
        passed=passed,
        severity=AssetCheckSeverity.ERROR,
        description=description,
        metadata={
            "files_tracked": blame_capture.files_tracked,
            "files_captured": blame_capture.files_captured,
            "files_skipped_binary": blame_capture.files_skipped_binary,
            "files_empty": blame_capture.files_empty,
            "files_failed": blame_capture.files_failed,
            "bytes_written": blame_capture.bytes_written,
        },
    )


@asset_check(
    asset=blame_capture,
    description="Every tracked path is accounted for exactly once in the capture result.",
)
def capture_accounts_for_every_tracked_file(
    blame_capture: BlameCapture,
) -> AssetCheckResult:
    accounted = (
        blame_capture.files_captured
        + blame_capture.files_skipped_binary
        + blame_capture.files_empty
        + blame_capture.files_failed
    )
    passed = (
        accounted == blame_capture.files_tracked
        and len(blame_capture.captured_paths) == blame_capture.files_captured
    )
    return AssetCheckResult(
        passed=passed,
        severity=AssetCheckSeverity.ERROR,
        description=(
            f"{accounted} of {blame_capture.files_tracked} tracked files accounted for; "
            f"{len(blame_capture.captured_paths)} captured paths recorded."
        ),
        metadata={
            "files_tracked": blame_capture.files_tracked,
            "files_accounted_for": accounted,
            "captured_paths": len(blame_capture.captured_paths),
        },
    )


# The 14 fields git blame emits that the coverage matrix maps to a column.
# Required fields must be present on every blamed line. The parser rejects
# missing porcelain keys; these checks also catch invalid values after parsing.
_REQUIRED_FIELDS = {
    "header sha": lambda r: bool(r.commit_sha),
    "final line number": lambda r: r.line_number_in_file > 0,
    "origin line number": lambda r: r.line_number_at_origin > 0,
    "author": lambda r: bool(r.author_name.strip()),
    "author-mail": lambda r: bool(r.author_email.strip()),
    "author-time": lambda r: r.authored_at_epoch is not None,
    "author-tz": lambda r: bool(r.author_utc_offset.strip()),
    "committer": lambda r: bool(r.committer_name.strip()),
    "committer-mail": lambda r: bool(r.committer_email.strip()),
    "committer-time": lambda r: r.committed_at_epoch is not None,
    "committer-tz": lambda r: bool(r.committer_utc_offset.strip()),
    "filename": lambda r: bool(r.origin_file_path),
    "blamed path": lambda r: bool(r.blamed_file_path),
}

# The other two are conditional on the repository's shape, not on the parser.
# `previous` is absent when every surviving line comes from a commit with no
# parent -- true of any young repo. `boundary` is absent when no surviving line
# reaches the root commit. Failing a run for either would mean a correct parse
# of a small repository reports as broken, so they warn instead.
_CONDITIONAL_FIELDS = {
    "previous": lambda r: r.previous_commit_sha,
    "boundary": lambda r: r.reaches_history_boundary,
}


@asset_check(
    asset=blame_records,
    description="Every git blame field the schema stores is populated by at least one record.",
)
def records_carry_every_field(blame_records: list[BlameRecord]) -> AssetCheckResult:
    if not blame_records:
        return AssetCheckResult(
            passed=False,
            severity=AssetCheckSeverity.ERROR,
            description="no records at all, so no field is populated.",
        )

    def invalid_required(fields):
        return sorted(
            name
            for name, read in fields.items()
            if not all(read(record) for record in blame_records)
        )

    missing = invalid_required(_REQUIRED_FIELDS)
    absent = sorted(
        name
        for name, read in _CONDITIONAL_FIELDS.items()
        if not any(read(record) for record in blame_records)
    )

    if missing:
        description = f"never populated: {', '.join(missing)}."
    elif absent:
        description = (
            f"all {len(_REQUIRED_FIELDS)} always-present fields populated; "
            f"{', '.join(absent)} absent, which this repository's history can "
            "explain -- no surviving line has one."
        )
    else:
        description = (
            f"all {len(_REQUIRED_FIELDS) + len(_CONDITIONAL_FIELDS)} blame fields populated."
        )

    return AssetCheckResult(
        passed=not missing,
        severity=AssetCheckSeverity.ERROR if missing else AssetCheckSeverity.WARN,
        description=description,
        metadata={
            "records": len(blame_records),
            "fields_required": len(_REQUIRED_FIELDS),
            "fields_invalid_or_missing": len(missing),
            "conditional_fields_absent": ", ".join(absent) if absent else "none",
        },
    )


@asset_check(
    asset=blame_records,
    additional_ins={"blame_capture": AssetIn("blame_capture")},
    description="Every file the capture wrote a section for yields at least one record.",
)
def records_parse_completely(
    blame_records: list[BlameRecord],
    blame_capture: BlameCapture,
) -> AssetCheckResult:
    """A file that reached the capture but parsed to nothing is a parser bug.

    The capture layer already drops files that blame to nothing, so every
    section it wrote must come back out. Counting sections rather than trusting
    the record count is the point: 36,653 records from 240 of 241 files looks
    like a success until someone asks about the missing file.
    """

    parsed_paths = {record.blamed_file_path for record in blame_records}
    expected_paths = set(blame_capture.captured_paths)
    missing_paths = expected_paths - parsed_paths
    unexpected_paths = parsed_paths - expected_paths
    passed = not missing_paths and not unexpected_paths
    expected = len(expected_paths)

    return AssetCheckResult(
        passed=passed,
        severity=AssetCheckSeverity.ERROR,
        description=(
            f"All {expected} captured files parsed."
            if passed
            else (
                f"Capture/parser path mismatch: {len(missing_paths)} captured file(s) "
                f"yielded no records and {len(unexpected_paths)} unexpected path(s) parsed."
            )
        ),
        metadata={
            "records": len(blame_records),
            "files_captured": expected,
            "files_parsed": len(parsed_paths),
            "missing_paths": sorted(missing_paths)[:20],
            "unexpected_paths": sorted(unexpected_paths)[:20],
        },
    )
