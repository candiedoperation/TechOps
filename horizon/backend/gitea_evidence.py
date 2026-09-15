"""Shared attribution and missingness rules; no recruiting scores live here."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any


METRIC_SEMANTICS = {
    "commits": "Authored Git commits observed in the selected history; overlapping pull-commit counts must not be added",
    "commits_default_reachable": "Authored commits reachable from the native default branch; unknown reachability is unavailable",
    "commits_branch_only": "Authored commits observed only on non-default branches; unknown reachability is unavailable",
    "non_merge_commits": "Authored commits with at most one parent",
    "merge_commits": "Authored commits with multiple parents",
    "additions": "Added lines across selected authored commits; null unless line statistics are complete",
    "deletions": "Deleted lines across selected authored commits; null unless line statistics are complete",
    "files_changed": "Sum of changed-file occurrences; null unless file statistics are complete",
    "unique_files": "Distinct repository-qualified changed files; null unless file statistics are complete",
    "pulls_opened": "Pull requests authored by this identity",
    "pulls_merged": "Pull requests AUTHORED by this identity that were merged; not all merged PRs contributed to",
    "pulls_closed": "Authored pull requests reported closed without being merged",
    "pulls_contributed_to": "Distinct pull requests containing at least one commit authored by this identity",
    "pulls_merged_contributed_to": "Distinct MERGED pull requests containing at least one authored commit; the identity need not be the PR author",
    "pull_commits_authored": "Distinct repository-qualified authored commit SHAs found in pull requests",
    "merged_pull_commits_authored": "Distinct repository-qualified authored commit SHAs found in merged pull requests",
    "reviews_submitted": "Observed submitted review records; count alone does not establish consequential technical review",
    "reviews_approved": "Observed review records with APPROVED state",
    "reviews_changes_requested": "Observed review records with REQUEST_CHANGES state",
    "reviews_other": "Observed review records in other states",
    "issues_opened": "Issues authored by this identity, excluding pull requests",
    "active_days": "Distinct dates with observed activity in the selected scope; not hours worked or ability",
    "blame_lines": "Current lines attributed by the configured blame collection; not code quality or impact",
    "blame_files": "Files with lines attributed by the configured blame collection",
}
METRIC_FIELDS = tuple(METRIC_SEMANTICS)
MAX_REVIEW_CANDIDATES = 5


def exact_identity_keys(login: Any = None, email: Any = None) -> set[str]:
    """Only typed account login/full email; never names or rendered identities."""
    keys: set[str] = set()
    account = str(login or "").strip().casefold()
    if re.fullmatch(r"[a-z0-9_.-]+", account):
        keys.add(f"login:{account}")
    address = str(email or "").strip().strip('<>"\u201c\u201d\u2018\u2019').casefold()
    if re.fullmatch(r"[^\s<>@\"]+@[^\s<>@\"]+", address):
        keys.add(f"email:{address}")
    return keys


def candidate_identity_id(record: dict[str, Any]) -> str:
    identity = json.dumps([record.get("login"), record.get("email")], ensure_ascii=False)
    return "gitea-candidate:" + hashlib.sha256(identity.encode()).hexdigest()[:24]


def candidate_targets(record: dict[str, Any]) -> set[str]:
    """Union the entire record's possibilities; never select its first alias."""
    return {
        str(candidate).strip().casefold()
        for alias in record.get("identity_aliases") or []
        if alias.get("resolution") in {"heuristic_candidate_only", "ambiguous_strong_identity"}
        for candidate in alias.get("candidate_identities") or []
        if str(candidate).strip()
    }


def metric_snapshot(record: dict[str, Any], *, unlinked: bool = False) -> dict[str, Any]:
    """Keep raw subtotals separate from rankable observations and their status."""
    result = dict(record)
    availability = dict(record.get("availability") or {})
    observed = dict(record.get("observed_values") or {})
    for field in METRIC_FIELDS:
        value = record.get(field)
        status = availability.get(field)
        if unlinked:
            status = "unlinked"
        elif status is None:
            group = (
                "commit_stats_status" if field in {"additions", "deletions"}
                else "file_stats_status" if field in {"files_changed", "unique_files"}
                else None
            )
            status = record.get(group) if group else None
            status = status or ("complete" if value is not None else "unavailable")
        if status == "observed":
            status = "complete"
        if status == "complete" and value is None:
            status = "unavailable"
        if value is not None and status != "complete":
            observed[field] = value
        result[field] = value if status == "complete" else None
        availability[field] = status
    result["availability"] = availability
    result["observed_values"] = observed
    return result


def apply_collection_coverage(record: dict[str, Any], coverage: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Only invalidate metrics affected by failures in this identity's scope."""
    result = metric_snapshot(record)
    if coverage is None:
        for field in METRIC_FIELDS:
            if result["availability"][field] == "complete":
                result["observed_values"][field] = result[field]
                result[field] = None
                result["availability"][field] = "unknown"
        return result
    organizations = set(record.get("organizations") or [])
    repositories = set(record.get("repositories") or [])
    for alias in record.get("identity_aliases") or []:
        organizations.update(alias.get("organizations") or [])
        repositories.update(repo if "/" in repo else f"{org}/{repo}"
                            for org in alias.get("organizations") or []
                            for repo in alias.get("repositories") or [])
    refs: dict[str, list[int]] = {key: list(value) for key, value in (record.get("metric_coverage_refs") or {}).items()}
    for index, event in enumerate(coverage):
        status = event.get("status")
        if status not in {"failed", "partial", "unknown"}:
            continue
        parts = str(event.get("path") or "").strip("/").split("/")
        affected: set[str] = set()
        if len(parts) == 3 and parts[0] == "orgs" and parts[1] in organizations and parts[2] == "repos":
            affected.update(METRIC_FIELDS)
        elif len(parts) >= 4 and parts[0] == "repos" and (
            f"{parts[1]}/{parts[2]}" in repositories or parts[1] in organizations
        ):
            endpoint = parts[3:]
            if endpoint == ["pulls"]:
                affected.update(field for field in METRIC_FIELDS if "pull" in field or field.startswith("reviews_"))
            elif endpoint[0] == "pulls" and endpoint[-1] == "commits":
                affected.update({"pulls_contributed_to", "pulls_merged_contributed_to", "pull_commits_authored", "merged_pull_commits_authored"})
            elif endpoint[0] == "pulls" and endpoint[-1] == "reviews":
                affected.update(field for field in METRIC_FIELDS if field.startswith("reviews_"))
            elif endpoint == ["issues"]:
                affected.add("issues_opened")
            elif endpoint[0] in {"commits", "branches"}:
                affected.update({"commits", "commits_default_reachable", "commits_branch_only", "non_merge_commits", "merge_commits", "additions", "deletions", "files_changed", "unique_files"})
            if affected:
                affected.add("active_days")
        for field in affected:
            value = result.get(field)
            if value is not None:
                result["observed_values"][field] = value
            result[field] = None
            result["availability"][field] = "partial" if result["observed_values"].get(field, 0) or status == "partial" else status
            refs[field] = sorted(set(refs.get(field, [])) | {index})
    result["metric_coverage_refs"] = refs
    return result
