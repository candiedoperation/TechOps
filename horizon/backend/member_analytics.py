"""Ingest Gitea member-analytics runs produced by ``scripts/member_analytics.py``.

The collector writes an ``analytics.json`` payload per run. This module maps
that payload onto :class:`MemberAnalyticsRunDocument` and
:class:`MemberMetricsDocument` and persists both, replacing any previous rows
for the same ``run_id`` so a re-ingest is idempotent rather than additive.

The metrics are named and per-person, unlike the aggregate-only documents used
by the rest of the backend. They are descriptive activity indicators, not a
performance score.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .artifacts import payload_digest
from .db import get_active_repository
from .gitea_evidence import exact_identity_keys, metric_snapshot
from .models import (
    MemberAnalyticsOrgSummary,
    MemberAnalyticsRepoSummary,
    MemberAnalyticsRunDocument,
    MemberMetricsDocument,
    new_id,
)

# Fields copied straight across from a payload member to the document.
_INT_FIELDS = (
    "commits", "non_merge_commits", "merge_commits", "pulls_opened", "pulls_merged",
    "pulls_closed", "reviews_submitted", "reviews_approved",
    "reviews_changes_requested", "reviews_other", "issues_opened",
    "active_days",
)
_OPTIONAL_ACTIVITY_FIELDS = (
    "commits_default_reachable", "commits_branch_only", "pulls_contributed_to",
    "pulls_merged_contributed_to", "pull_commits_authored", "merged_pull_commits_authored",
)
_OPTIONAL_METRIC_FIELDS = ("additions", "deletions", "files_changed", "unique_files")
_QUALITY_INT_FIELDS = (
    "commit_stats_complete", "commit_stats_unavailable", "commit_stats_failed",
    "file_stats_complete", "file_stats_unavailable", "file_stats_failed",
)
_OPTIONAL_INT_FIELDS = ("blame_lines", "blame_files")
_LIST_FIELDS = ("organizations", "repositories", "branches")


def _parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    except ValueError:
        return None


def _normalized_email(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().casefold()
    return normalized or None


def _looks_unmatched(login: str) -> bool:
    """Fallback for payloads collected before ``roster_member`` existed.

    The collector renders an identity it could not match to a roster member as
    ``"Name <email>"``, or ``"(unknown)"`` when it has neither. A real Gitea
    login can contain neither an angle bracket nor a space, so this recovers
    the flag for older runs without guessing at anything else.
    """
    return "<" in login or login == "(unknown)"


def _identity_alias_keys(login: Any, name: Any, email: Any) -> set[str]:
    """Build exact, typed keys for legacy alias folding.

    Names, email local-parts, and fuzzy tokens are intentionally excluded: they
    are review evidence, not safe attribution keys.
    """
    return exact_identity_keys(login, email)


#: Reviewed alias file. Each entry attributes one commit-author identity to one
#: roster login. It is deliberately a checked-in file rather than a runtime
#: table: attributing a person's work is a human judgement that feeds recruiting
#: rank, so it belongs somewhere with an author, a diff and a review -- not
#: somewhere a job can quietly write.
#:
#: It lives at the project root rather than under ``data/`` because that whole
#: directory is gitignored as generated output; a reviewed file kept there
#: could never actually be reviewed.
IDENTITY_ALIAS_FILE = Path(__file__).resolve().parents[1] / "identity-aliases.json"


def load_confirmed_aliases(path: Path | str | None = None) -> dict[str, str]:
    """Return ``{identity key: roster login}`` for confirmed alias entries only.

    Entries missing ``confirmed_by`` are proposals and are ignored: the
    generator writes them unconfirmed on purpose so that nothing takes effect
    until a person has put their name to it.
    """

    source = Path(path) if path is not None else IDENTITY_ALIAS_FILE
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    entries = payload.get("aliases") if isinstance(payload, Mapping) else None
    if not isinstance(entries, list):
        return {}

    resolved: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        target = str(entry.get("target_login") or "").strip()
        if not target or not str(entry.get("confirmed_by") or "").strip():
            continue
        for key in exact_identity_keys(entry.get("alias_login"), entry.get("alias_email")):
            resolved[key] = target
    return resolved


def _fold_unique_aliases(
    documents: list[MemberMetricsDocument],
    confirmed_aliases: Mapping[str, str] | None = None,
) -> list[MemberMetricsDocument]:
    """Fold unambiguous commit aliases into canonical roster members.

    Older analytics artifacts can contain both a zero-valued roster row and a
    separate ``Name <email>`` commit identity. Only a unique exact login or
    full-email match is folded; ambiguous identities remain visible as
    unmatched instead of being attributed by guesswork.

    ``confirmed_aliases`` adds human-reviewed keys to that same exact-match
    index rather than bypassing it, so a reviewed entry still cannot fold an
    identity that two roster members both claim -- a typo in the file
    surfaces as an unfolded row, never as silently reassigned work.
    """
    roster = [member for member in documents if member.roster_member and not member.service_or_admin]
    roster_logins = {member.login for member in roster}
    key_targets: dict[str, set[str]] = {}
    for member in roster:
        for key in _identity_alias_keys(member.login, member.name, member.email):
            key_targets.setdefault(key, set()).add(member.login)
    for key, target in (confirmed_aliases or {}).items():
        if target in roster_logins:
            key_targets.setdefault(key, set()).add(target)

    by_login = {member.login: member for member in roster}
    folded: set[str] = set()
    for alias in documents:
        if alias.roster_member or alias.service_or_admin:
            continue
        alias_keys = _identity_alias_keys(alias.login, alias.name, alias.email)
        reviewed = any(key in (confirmed_aliases or {}) for key in alias_keys)
        if not reviewed and any(
            row.get("resolution")
            in {"heuristic_candidate_only", "ambiguous_strong_identity", "heuristic_candidates_suppressed"}
            for row in alias.identity_aliases
        ):
            continue
        matches: set[str] = set()
        for key in alias_keys:
            matches.update(key_targets.get(key, set()))
        if len(matches) != 1:
            continue
        target = by_login[next(iter(matches))]
        nonadditive = {field: (getattr(target, field), getattr(alias, field))
                       for field in ("active_days", "unique_files", "blame_files")}
        for field in (*_INT_FIELDS, *_QUALITY_INT_FIELDS):
            a, b = getattr(target, field), getattr(alias, field)
            setattr(target, field, None if a is None or b is None else a + b)
        for field in (*_OPTIONAL_METRIC_FIELDS, *_OPTIONAL_ACTIVITY_FIELDS):
            target_value = getattr(target, field)
            alias_value = getattr(alias, field)
            setattr(
                target,
                field,
                None
                if target_value is None or alias_value is None
                else int(target_value) + int(alias_value),
            )
        for field in _OPTIONAL_INT_FIELDS:
            target_value = getattr(target, field)
            alias_value = getattr(alias, field)
            setattr(
                target,
                field,
                None
                if target_value is None or alias_value is None
                else int(target_value) + int(alias_value),
            )
        # Distinct days/files overlap across aliases. Without event sets a
        # sum would invent an inflated total; keep unavailable until rebuilt.
        for field, (first, second) in nonadditive.items():
            if first and second:
                setattr(target, field, None)
        target.organizations = sorted(set(target.organizations) | set(alias.organizations))
        target.repositories = sorted(set(target.repositories) | set(alias.repositories))
        target.branches = sorted(set(target.branches) | set(alias.branches))
        if target.commit_stats_status != "complete" or alias.commit_stats_status != "complete":
            target.commit_stats_status = "partial"
        if target.file_stats_status != "complete" or alias.file_stats_status != "complete":
            target.file_stats_status = "partial"
        if target.first_activity is None or (alias.first_activity and alias.first_activity < target.first_activity):
            target.first_activity = alias.first_activity
        if target.last_activity is None or (alias.last_activity and alias.last_activity > target.last_activity):
            target.last_activity = alias.last_activity
        folded.add(alias.login)

    return [member for member in documents if member.login not in folded]


def run_id_from_payload(payload: dict[str, Any]) -> str:
    """Derive a stable run id from the payload's own generation timestamp."""
    generated = _parse_timestamp(payload.get("generated_at"))
    if generated is None:
        raise ValueError("analytics payload is missing a usable generated_at")
    return generated.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _repository_summaries(organizations: list[dict[str, Any]]) -> list[MemberAnalyticsRepoSummary]:
    summaries: list[MemberAnalyticsRepoSummary] = []
    for organization in organizations:
        org_name = str(organization.get("organization") or "")
        for repo in organization.get("repositories") or []:
            pulls = repo.get("pulls") or []
            summaries.append(
                MemberAnalyticsRepoSummary(
                    organization=str(repo.get("organization") or org_name),
                    name=str(repo.get("name") or ""),
                    default_branch=repo.get("default_branch"),
                    html_url=repo.get("html_url"),
                    branch_count=len(repo.get("branches") or []),
                    commit_count=len(repo.get("commits") or []),
                    pull_count=len(pulls),
                    merged_count=sum(1 for pull in pulls if pull.get("merged")),
                    issue_count=int(repo.get("issue_count") or 0),
                )
            )
    return summaries


def build_documents(
    payload: dict[str, Any],
    run_id: str | None = None,
) -> tuple[MemberAnalyticsRunDocument, list[MemberMetricsDocument]]:
    """Map one analytics payload onto its run and member documents."""
    if not isinstance(payload, dict) or not isinstance(payload.get("members"), list):
        raise ValueError("analytics payload requires a members array")
    resolved_run_id = run_id or payload.get("run_id") or run_id_from_payload(payload)
    generated_at = _parse_timestamp(payload.get("generated_at"))
    if generated_at is None:
        raise ValueError("analytics payload is missing a usable generated_at")

    organizations = payload.get("organizations") or []
    if not isinstance(organizations, list) or any(not isinstance(row, dict) for row in organizations):
        raise ValueError("analytics organizations must be an array of objects")
    members = payload.get("members") or []

    run = MemberAnalyticsRunDocument(
        id=new_id(),
        payload_sha256=payload_digest(payload),
        run_id=resolved_run_id,
        generated_at=generated_at,
        gitea_url=str(payload.get("gitea_url") or ""),
        history_scope=str(payload.get("history_scope") or ""),
        commit_stats_scope=payload.get("commit_stats_scope"),
        blame_status=str((payload.get("blame") or {}).get("status") or (
            "unknown" if payload.get("blame_method") else "disabled"
        )),
        blame_method=payload.get("blame_method"),
        api_calls=int(payload.get("api_calls") or 0),
        warnings=[str(warning) for warning in payload.get("warnings") or []],
        coverage=[dict(event) for event in payload.get("coverage") or [] if isinstance(event, dict)],
        organizations=[
            MemberAnalyticsOrgSummary(
                organization=str(organization.get("organization") or ""),
                member_count=int(organization.get("member_count") or 0),
                repository_count=len(organization.get("repositories") or []),
            )
            for organization in organizations
        ],
        repositories=_repository_summaries(organizations),
        member_count=len(members),
    )

    documents: list[MemberMetricsDocument] = []
    seen = set()
    for member in members:
        if not isinstance(member, dict):
            raise ValueError("analytics members must be objects")
        for field in (*_INT_FIELDS, *_OPTIONAL_ACTIVITY_FIELDS, *_OPTIONAL_METRIC_FIELDS, *_OPTIONAL_INT_FIELDS, *_QUALITY_INT_FIELDS):
            value = member.get(field)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                                      or not math.isfinite(value) or value < 0 or int(value) != value):
                raise ValueError(f"analytics {field} must be a nonnegative integer or null")
        member = metric_snapshot(member)
        login = str(member.get("login") or "")
        if not login.strip():
            raise ValueError("analytics member login is required")
        if login.casefold() in seen:
            raise ValueError("duplicate analytics login")
        seen.add(login.casefold())
        roster_member = member.get("roster_member")
        if roster_member is None:
            roster_member = not _looks_unmatched(login)
        documents.append(
            MemberMetricsDocument(
                id=new_id(),
                run_id=resolved_run_id,
                login=login,
                name=member.get("name"),
                email=_normalized_email(member.get("email")),
                admin=bool(member.get("admin")),
                active_account=bool(member.get("active_account", True)),
                roster_member=bool(roster_member),
                service_or_admin=bool(member.get("service_or_admin")),
                first_activity=_parse_timestamp(member.get("first_activity")),
                last_activity=_parse_timestamp(member.get("last_activity")),
                **{field: None if member.get(field) is None else int(member[field]) for field in _INT_FIELDS},
                **{
                    field: (None if field in member and member.get(field) is None else int(member[field]))
                    for field in _OPTIONAL_ACTIVITY_FIELDS
                    if field in member
                },
                **{
                    field: (None if member.get(field) is None else int(member[field]))
                    for field in _OPTIONAL_METRIC_FIELDS
                },
                **{field: int(member.get(field) or 0) for field in _QUALITY_INT_FIELDS},
                commit_stats_status=str(
                    member.get("commit_stats_status")
                    or ("not_applicable" if member.get("commits") == 0 else "unknown")
                ),
                file_stats_status=str(
                    member.get("file_stats_status")
                    or ("not_applicable" if member.get("commits") == 0 else "unknown")
                ),
                identity_aliases=[dict(alias) for alias in member.get("identity_aliases") or [] if isinstance(alias, dict)],
                **{
                    field: (int(member[field]) if member.get(field) is not None else None)
                    for field in _OPTIONAL_INT_FIELDS
                },
                **{field: [str(item) for item in member.get(field) or []] for field in _LIST_FIELDS},
            )
        )
    # Version 2 payloads contain the collector's explicit typed resolution and
    # candidate-only decisions. Never reinterpret them downstream. For older
    # payloads, retain only exact login/full-email compatibility folding.
    if not (payload.get("identity_resolution") or {}).get("schema"):
        documents = _fold_unique_aliases(documents, load_confirmed_aliases())
    run.member_count = len(documents)
    return run, documents


async def ingest_payload(payload: dict[str, Any], run_id: str | None = None) -> dict[str, Any]:
    """Persist one analytics payload, replacing any earlier rows for its run."""
    run, members = build_documents(payload, run_id)
    store = get_active_repository()

    async with store.transaction():
        existing = await store.member_analytics_run(run.run_id)
        if existing is not None:
            if existing.payload_sha256 != run.payload_sha256:
                raise ValueError("analytics run_id already exists with different content; use a new version")
        else:
            await store.add_many("member_metrics", members)
            await store.add("member_analytics_runs", run)

    return {
        "run_id": run.run_id,
        "generated_at": run.generated_at.isoformat(),
        "members": len(members),
        "organizations": len(run.organizations),
        "repositories": len(run.repositories),
        "warnings": len(run.warnings),
        "replaced": existing is not None,
    }


async def ingest_file(path: Path | str, run_id: str | None = None) -> dict[str, Any]:
    """Ingest an ``analytics.json`` file, or a run directory containing one."""
    resolved = Path(path)
    if resolved.is_dir():
        # A timestamped pipeline run directory names the run; prefer it over
        # deriving one. "latest" is a rolling copy of the newest run rather
        # than a run of its own, so it falls back to the payload timestamp.
        manifest_path = resolved / "manifest.json"
        if run_id is None and manifest_path.exists():
            run_id = json.loads(manifest_path.read_text(encoding="utf-8")).get("run_id")
        if run_id is None and resolved.name != "latest":
            run_id = resolved.name
        resolved = resolved / "analytics.json"
    if not resolved.exists():
        raise FileNotFoundError(f"analytics payload not found: {resolved}")
    payload = json.loads(resolved.read_text(encoding="utf-8"))
    return await ingest_payload(payload, run_id)
