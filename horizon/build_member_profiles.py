#!/usr/bin/env python3
"""Build local, read-only member profiles from App Dev Horizon source snapshots.

The profile artifact is intentionally derived from two immutable local inputs:
the authenticated People Portal ZIP export and one Gitea analytics JSON run.
People Portal applications remain at application grain, while the profile key
is the normalized email address requested by the Horizon design.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import zipfile
from collections import Counter, defaultdict
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

from backend.artifacts import atomic_write, payload_digest
from backend.recruiting import (
    QUANT_HEDGE_EMPLOYER_ALIASES,
    QUANT_HEDGE_TYPE_MARKERS,
    TOP_TIER_EMPLOYER_ALIASES,
)
from backend.gitea_evidence import (
    METRIC_SEMANTICS, apply_collection_coverage, candidate_identity_id,
    candidate_targets, exact_identity_keys, metric_snapshot,
)


PIPELINE_ROOT = Path(__file__).resolve().parent
DEFAULT_OUTPUT_ROOT = PIPELINE_ROOT / "data/horizon"
DEFAULT_PROFILE_OUTPUT = DEFAULT_OUTPUT_ROOT / "latest"
EMAIL_IN_ANGLE_BRACKETS = re.compile(r"<([^<>\s]+@[^<>\s]+)>")
GITEA_NUMERIC_FIELDS = (
    "commits",
    "commits_default_reachable",
    "commits_branch_only",
    "non_merge_commits",
    "merge_commits",
    "additions",
    "deletions",
    "files_changed",
    "unique_files",
    "pulls_opened",
    "pulls_merged",
    "pulls_closed",
    "pulls_contributed_to",
    "pulls_merged_contributed_to",
    "pull_commits_authored",
    "merged_pull_commits_authored",
    "reviews_submitted",
    "reviews_approved",
    "reviews_changes_requested",
    "reviews_other",
    "issues_opened",
    "active_days",
    "blame_lines",
    "blame_files",
)
GITEA_LIST_FIELDS = ("organizations", "repositories", "branches")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--peopleportal-zip",
        type=Path,
        default=None,
        help="People Portal ZIP export; defaults to the newest horizon-peopleportal-*.zip in data/horizon/",
    )
    parser.add_argument(
        "--gitea-analytics",
        type=Path,
        default=DEFAULT_PROFILE_OUTPUT / "analytics.json",
        help="Gitea analytics JSON snapshot",
    )
    parser.add_argument(
        "--gitea-manifest",
        type=Path,
        default=DEFAULT_PROFILE_OUTPUT / "manifest.json",
        help="Optional Gitea run manifest",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_PROFILE_OUTPUT,
        help="Directory for derived profile artifacts",
    )
    return parser.parse_args()


def normalize_email(value: Any) -> str:
    """Normalize only transport noise; do not apply provider-specific aliases."""

    if not isinstance(value, str):
        return ""
    value = value.strip()
    match = EMAIL_IN_ANGLE_BRACKETS.search(value)
    if match:
        value = match.group(1)
    return value.strip().casefold()


def as_list(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict) and isinstance(value.get("items"), list):
        return [item for item in value["items"] if isinstance(item, dict)]
    return []


def first_value(*values: Any) -> Any:
    for value in values:
        if value not in (None, ""):
            return value
    return None


def stage_for(application: dict[str, Any]) -> str:
    info = application.get("applicationInfo") or {}
    card = application.get("applicationCard") or {}
    value = first_value(info.get("stage"), card.get("stage"), "")
    return str(value).strip()


def app_email(application: dict[str, Any]) -> str:
    info = application.get("applicationInfo") or {}
    return normalize_email(
        first_value(
            application.get("memberEmail"),
            info.get("email"),
            application.get("email"),
        )
    )


def load_json_from_zip(archive: zipfile.ZipFile, name: str) -> Any:
    with archive.open(name) as handle:
        return json.load(handle)


def find_peopleportal_zip(output_root: Path) -> Path:
    candidates = sorted(
        output_root.glob("horizon-peopleportal-*.zip"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise FileNotFoundError(f"No horizon-peopleportal-*.zip found in {output_root}")
    return candidates[0]


def safe_resume_name(name: str) -> str:
    basename = PurePosixPath(str(name)).name
    sanitized = re.sub(r"[^A-Za-z0-9._-]", "_", basename)
    if not sanitized or sanitized in {".", ".."}:
        raise ValueError(f"Unsafe résumé filename: {name!r}")
    return sanitized


def copy_resume_files(
    archive: zipfile.ZipFile,
    resume_records: Iterable[dict[str, Any]],
    output_dir: Path,
) -> dict[str, dict[str, Any]]:
    """Copy only retrieved PDFs from the ZIP into the ignored local output tree."""

    available_entries = {
        info.filename: info
        for info in archive.infolist()
        if not info.is_dir() and info.filename.startswith("resumes/")
    }
    destination_dir = output_dir / "resumes"
    destination_dir.mkdir(parents=True, exist_ok=True)
    copied: dict[str, dict[str, Any]] = {}
    expected_filenames: set[str] = set()

    for record in resume_records:
        if not record.get("retrieved") or not record.get("fileName"):
            continue
        source_name = str(record["fileName"])
        source_info = available_entries.get(source_name)
        if source_info is None:
            source_info = available_entries.get(f"resumes/{PurePosixPath(source_name).name}")
        if source_info is None:
            continue
        filename = safe_resume_name(source_info.filename)
        payload = archive.read(source_info)
        if not payload.startswith(b"%PDF"):
            continue
        expected_filenames.add(filename)
        destination = destination_dir / filename
        destination.write_bytes(payload)
        copied[source_name] = {
            "path": f"resumes/{filename}",
            "sizeBytes": len(payload),
        }
    for stale_file in destination_dir.glob("*.pdf"):
        if stale_file.name not in expected_filenames:
            stale_file.unlink()
    return copied


def extract_resume_text(path: Path) -> tuple[str, str]:
    """Extract local-only text from every page of a retrieved résumé PDF.

    The recruiting API receives evidence snippets, never the PDF itself.  A
    status is returned alongside the text so extraction failures remain
    visible and do not silently turn into an empty résumé.
    """

    text = ""
    parsed = False
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(path))
        pages = [(page.extract_text() or "").strip() for page in reader.pages]
        text = "\n".join(page for page in pages if page)
        parsed = True
    except Exception:
        pass
    if not text.strip():
        # Some valid PDFs yield empty text or fail in pypdf. Try the local
        # Poppler parser before labelling the retrieved resume empty/failed.
        try:
            result = subprocess.run(
                ["pdftotext", "-layout", str(path), "-"],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            if result.returncode == 0:
                text = result.stdout
                parsed = True
        except (OSError, subprocess.TimeoutExpired):
            text = ""
    return text, "complete" if text.strip() else "empty" if parsed else "failed"


def _normalized_search_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()


def _contains_phrase(text: str, phrase: str) -> bool:
    return f" {_normalized_search_text(phrase)} " in f" {text} "


def resume_employment_evidence(text: str) -> list[dict[str, Any]]:
    """Find only explicit employer-policy evidence in résumé experience sections.

    This deliberately does not scan the whole résumé.  Mentions such as
    “deployed to AWS” in a project are not employment evidence; only lines in a
    clearly labelled experience/employment section can trigger this policy.
    """

    lines = [
        (re.sub(r"\s+", " ", line).strip(), len(line) - len(line.lstrip()))
        for line in text.splitlines()
    ]
    start = None
    stop_headings = {
        "education", "projects", "project experience", "skills", "technical skills",
        "leadership", "activities", "awards", "certifications", "coursework",
    }
    for index, (line, _indent) in enumerate(lines):
        heading = _normalized_search_text(line)
        if heading in {"experience", "work experience", "employment", "employment history", "professional experience", "internship experience"}:
            start = index + 1
            break
    if start is None:
        return []
    section: list[tuple[str, int]] = []
    for line, indent in lines[start:]:
        heading = _normalized_search_text(line)
        if heading in stop_headings:
            break
        if line:
            section.append((line, indent))
        if len(section) >= 160:
            break

    aliases = sorted(
        TOP_TIER_EMPLOYER_ALIASES | QUANT_HEDGE_EMPLOYER_ALIASES | QUANT_HEDGE_TYPE_MARKERS,
        key=len,
        reverse=True,
    )
    date_signal = re.compile(r"\b(?:19|20)\d{2}\b|\bpresent\b|\bsummer\s+(?:19|20)\d{2}\b", re.I)
    role_signal = re.compile(
        r"\b(?:intern|engineer|developer|analyst|scientist|researcher|manager|designer|"
        r"consultant|trader|quant|software|machine learning|data|technical|product|assistant)\b",
        re.I,
    )
    non_employment_context = re.compile(
        r"\b(?:club|student|certified|certificate|mentor(?:ed|ship)?|participant|event|"
        r"api|oauth|sheets|drive|cloud|skills?)\b",
        re.I,
    )
    evidence: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, (line, indent) in enumerate(section):
        if line.lstrip().startswith(("•", "-", "–", "—", "●", "◦", "▪", "∙")):
            continue
        if indent > 1:
            continue
        next_line, next_indent = section[index + 1] if index + 1 < len(section) else ("", 0)
        context = f"{line} {next_line}"
        # A product/tool mention in a bullet or skills line is not employment.
        # A company header followed by a dated role, or a same-line dated role,
        # is strong enough for the exclusion queue.
        employment_like = bool(
            (date_signal.search(line) and role_signal.search(line))
            or (next_indent <= 1 and date_signal.search(next_line) and role_signal.search(next_line))
            or (next_indent <= 1 and role_signal.search(next_line) and date_signal.search(context))
        )
        if not employment_like or non_employment_context.search(line):
            continue
        normalized = _normalized_search_text(line)
        quant_role = re.search(r"\b(?:quant|quantitative|trading|trader|hedge)\b", normalized)
        if quant_role and next_line and next_indent <= 1 and not next_line.lstrip().startswith(("•", "-", "–", "—", "●", "◦", "▪", "∙")):
            evidence.append(
                {
                    "employer": f"{next_line} (quantitative/trading role)",
                    "role": line[:240],
                    "supporting_text": f"{line} | {next_line}"[:800],
                    "source_field": "resume.employment_text",
                    "verification_status": "self_reported",
                }
            )
        alias_lines = [(line, False)]
        if next_indent <= 1 and next_line and not next_line.lstrip().startswith(("•", "-", "–", "—", "●", "◦", "▪", "∙")):
            alias_lines.append((next_line, True))
        for alias_line, is_next_line in alias_lines:
            alias_normalized = _normalized_search_text(alias_line)
            for alias in aliases:
                if not _contains_phrase(alias_normalized, alias):
                    continue
                alias_text = _normalized_search_text(alias)
                alias_position = alias_normalized.find(alias_text)
                before_alias = alias_line[: max(0, alias_position)]
                same_line_role_only = bool(date_signal.search(alias_line) and role_signal.search(alias_line))
                explicit_company_separator = (
                    is_next_line
                    or alias_position <= 12
                    or "—" in before_alias
                    or "–" in before_alias
                    or "|" in before_alias
                    or " at " in before_alias.casefold()
                )
                if same_line_role_only and not explicit_company_separator:
                    continue
                key = alias.casefold()
                if key in seen:
                    continue
                seen.add(key)
                evidence.append(
                    {
                        "employer": alias,
                        "supporting_text": f"{line} | {next_line}"[:800] if is_next_line else line[:800],
                        "source_field": "resume.employment_text",
                        "verification_status": "self_reported",
                    }
                )
    return evidence[:20]


def application_rating(application: dict[str, Any]) -> tuple[Any, str | None]:
    """A present detail field is authoritative, including an explicit null.

    Application cards can default unrated applications to zero. They may be
    used only when the detailed response did not supply a stars field at all.
    """
    for container_name in ("applicationInfo", "applicationCard", None):
        container = application.get(container_name) or {} if container_name else application
        if "stars" in container:
            return container["stars"], f"{container_name}/stars" if container_name else "stars"
    return None, None


def _application_evidence(applications: list[dict[str, Any]]) -> tuple[list[str], str | None, float | None]:
    evidence: list[str] = []
    summaries: list[str] = []
    ratings: list[float] = []
    for application in applications:
        info = application.get("applicationInfo") or {}
        notes = first_value(info.get("notes"), application.get("notes"))
        if notes:
            summaries.append(str(notes).strip())
            evidence.append(str(notes).strip())
        rating, _ = application_rating(application)
        try:
            if rating is not None:
                ratings.append(float(rating))
        except (TypeError, ValueError):
            pass
    summary = "\n".join(dict.fromkeys(summaries))[:2_000] or None
    score = (sum(ratings) / len(ratings)) if ratings else None
    # Application answers remain in applicationInfo.responses/profile. They
    # are not interviewer observations and must not be relabelled as such.
    return list(dict.fromkeys(evidence)), summary, score


def build_recruiting_source_payload(
    profiles: list[dict[str, Any]],
    output_dir: Path,
    source: dict[str, Any],
) -> dict[str, Any]:
    """Create the bounded People Portal side of the recruiting join."""

    candidates: list[dict[str, Any]] = []
    extraction_counts = Counter()
    for profile in profiles:
        pp = profile["people_portal"]
        applications = pp.get("applications") or []
        interview_evidence, interview_summary, interview_score = _application_evidence(applications)
        resume_evidence: list[str] = []
        resume_summary: str | None = None
        employment: list[dict[str, Any]] = []
        resume_statuses: list[str] = []
        for resume in pp.get("resumes") or []:
            if not resume.get("retrieved") or not resume.get("path"):
                continue
            text, status = extract_resume_text(output_dir / str(resume["path"]))
            resume_statuses.append(status)
            extraction_counts[status] += 1
            if not text:
                continue
            paragraphs = [re.sub(r"\s+", " ", chunk).strip() for chunk in re.split(r"\n\s*\n|(?<=\.)\s{2,}", text) if chunk.strip()]
            resume_evidence.extend(paragraphs)
            employment.extend(resume_employment_evidence(text))
            if not resume_summary:
                resume_summary = text[:1_200]
        employment_keys: set[str] = set()
        unique_employment: list[dict[str, Any]] = []
        for item in employment:
            key = str(item.get("employer") or "").casefold()
            if key and key not in employment_keys:
                employment_keys.add(key)
                unique_employment.append(item)
        member = profile.get("member") or {}
        gitea = profile.get("gitea") or {}
        candidates.append(
            {
                "person_id": profile["person_id"],
                "gitea_logins": sorted({row["login"] for row in gitea.get("records") or [] if row.get("login")}),
                "member_login": member.get("username") or member.get("login") or profile["person_id"],
                "member_name": member.get("name") or profile["person_id"],
                "email": profile["person_id"],
                "applicant_id": next((row.get("applicantId") for row in applications if row.get("applicantId")), None),
                "member_stats": gitea.get("metrics") or {},
                "interview": {
                    "score": interview_score,
                    "summary": interview_summary,
                    "evidence": interview_evidence,
                },
                "resume": {
                    "summary": resume_summary,
                    "evidence": list(dict.fromkeys(resume_evidence)),
                    "employment": unique_employment,
                    "extraction_status": "complete" if resume_statuses and all(status == "complete" for status in resume_statuses) else ("partial" if "complete" in resume_statuses else (resume_statuses[0] if resume_statuses else "missing")),
                    "evidence_truncated": False,
                },
                "source_refs": [
                    {"source_type": "people_portal", "source_id": source["peoplePortalArchive"], "source_field": "applications", "label": "People Portal application and interview responses"},
                    {"source_type": "people_portal", "source_id": source["peoplePortalArchive"], "source_field": "resumes", "label": "People Portal résumé evidence"},
                ],
            }
        )
    return {
        "schema": "horizon.recruiting-source.v2",
        "generated_at": source.get("giteaGeneratedAt") or source.get("peoplePortalGeneratedAt") or "1970-01-01T00:00:00+00:00",
        "source_run_id": f"people-portal-{payload_digest({'version': 2, 'inputs': source.get('input_sha256'), 'candidates': candidates})[:32]}",
        "source": {
            "people_portal_archive": source["peoplePortalArchive"],
            "people_portal_generated_at": source["peoplePortalGeneratedAt"],
            "gitea_generated_at": source["giteaGeneratedAt"],
            "gitea_run_id": source.get("giteaRunId"),
            "gitea_analytics_schema": source.get("giteaAnalyticsSchema"),
            "gitea_metric_semantics": source.get("giteaMetricSemantics") or {},
            "gitea_coverage": source["giteaCoverage"],
            "resume_extraction": dict(extraction_counts),
        },
        "candidates": candidates,
    }


def aggregate_gitea(records: list[dict[str, Any]]) -> dict[str, Any]:
    records = [metric_snapshot(record) for record in records]
    metrics: dict[str, Any] = {}
    availability: dict[str, str] = {}
    for field in GITEA_NUMERIC_FIELDS:
        values = [record.get(field) if field in record else None for record in records]
        statuses = [record["availability"][field] for record in records]
        if values and all(status == "complete" for status in statuses):
            metrics[field] = sum(int(value) for value in values)
            availability[field] = "complete"
        elif any(value is not None for value in values):
            # A known subtotal plus an unavailable source is not a complete
            # total. Preserve the subtotal only in provenance, not as a rankable
            # number that looks complete.
            metrics[field] = None
            availability[field] = "partial"
        else:
            metrics[field] = None
            availability[field] = next(iter(set(statuses))) if len(set(statuses)) == 1 else "partial" if statuses else "unlinked"
    metrics["availability"] = availability
    metrics["observed_values"] = dict(records[0].get("observed_values") or {}) if len(records) == 1 else {}
    for field in GITEA_LIST_FIELDS:
        values: set[str] = set()
        for record in records:
            values.update(str(value) for value in record.get(field) or [] if value not in (None, ""))
        metrics[field] = sorted(values)

    for field in ("admin", "active_account", "service_or_admin"):
        metrics[field] = any(bool(record.get(field)) for record in records)
    metrics["roster_member"] = all(record.get("roster_member", True) is not False for record in records)
    timestamps = {
        field: [str(record[field]) for record in records if record.get(field)]
        for field in ("first_activity", "last_activity")
    }
    metrics["first_activity"] = min(timestamps["first_activity"], default=None)
    metrics["last_activity"] = max(timestamps["last_activity"], default=None)
    identity_aliases: list[dict[str, Any]] = []
    seen_aliases: set[str] = set()
    for record in records:
        for alias in record.get("identity_aliases") or []:
            if not isinstance(alias, dict):
                continue
            key = json.dumps(alias, sort_keys=True, ensure_ascii=False)
            if key in seen_aliases:
                continue
            seen_aliases.add(key)
            identity_aliases.append(alias)
    metrics["identity_aliases"] = identity_aliases
    for field in ("commit_stats_status", "file_stats_status"):
        statuses = {str(record.get(field)) for record in records if record.get(field)}
        metrics[field] = (
            "complete"
            if statuses == {"complete"}
            else next(iter(statuses))
            if len(statuses) == 1
            else "failed"
            if statuses and statuses <= {"failed"}
            else "partial"
            if statuses
            else "unknown"
        )
    return metrics


def team_name_map(teams: list[dict[str, Any]]) -> dict[str, str]:
    result: dict[str, str] = {}
    for team in teams:
        identifier = first_value(team.get("pk"), team.get("id"), team.get("teamId"))
        name = first_value(team.get("name"), team.get("teamName"), team.get("title"))
        if identifier and name:
            result[str(identifier)] = str(name)
    return result


def build_profile(
    member: dict[str, Any],
    member_records: list[dict[str, Any]],
    applications: list[dict[str, Any]],
    gitea_records: list[dict[str, Any]],
    resume_files: dict[str, dict[str, Any]],
    source: dict[str, Any],
    team_names: dict[str, str],
    candidate_gitea_records: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    email = normalize_email(member.get("email"))
    stage_counts = Counter(stage_for(application) or "(missing)" for application in applications)
    all_applications_rejected = bool(applications) and all(
        stage_for(application).casefold() == "rejected" for application in applications
    )
    notes = [
        (application.get("applicationInfo") or {}).get("notes")
        for application in applications
        if (application.get("applicationInfo") or {}).get("notes")
    ]
    ratings = [rating for application in applications for rating, _ in [application_rating(application)] if rating is not None]

    resume_by_key: dict[str, dict[str, Any]] = {}
    for application in applications:
        resume = application.get("resume") or {}
        key = str(resume.get("fileName") or resume.get("applicantId") or "")
        if not key:
            continue
        if key not in resume_by_key:
            copied = resume_files.get(str(resume.get("fileName") or ""), {})
            resume_by_key[key] = {
                "applicantId": resume.get("applicantId"),
                "available": bool(resume.get("available")),
                "retrieved": bool(resume.get("retrieved")),
                "status": resume.get("status"),
                "sourceFile": resume.get("fileName"),
                "path": copied.get("path"),
                "sizeBytes": copied.get("sizeBytes"),
            }

    warnings: list[str] = []
    coverage = source.get("giteaCoverage")
    coverage_gaps = [
        event for event in coverage or []
        if isinstance(event, dict) and str(event.get("status")) != "complete"
    ] if coverage is not None else []
    if not applications:
        warnings.append("No member-linked applications in this People Portal snapshot")
    if not gitea_records:
        warnings.append("No Gitea record matched this normalized email")
    candidate_gitea_records = candidate_gitea_records or []
    if candidate_gitea_records:
        warnings.append(
            f"{len(candidate_gitea_records)} Gitea identity candidate(s) require review before attribution"
        )
    if coverage is None:
        warnings.append("Gitea coverage metadata is missing; zero metrics are not authoritative")
    elif coverage_gaps:
        warnings.append(
            f"{len(coverage_gaps)} Gitea endpoint result(s) are partial or failed; affected metrics are unavailable"
        )
    if applications and len(resume_by_key) == 0:
        warnings.append("No résumé record was returned for this member's applications")
    elif any(not resume.get("retrieved") for resume in resume_by_key.values()):
        warnings.append("At least one résumé was available but not retrieved")
    if all_applications_rejected:
        warnings.append("All linked People Portal applications were rejected; member retained because active roster membership is independent")
    application_rows = []
    for application in applications:
        row = dict(application)
        team_id = str(row.get("teamId") or "")
        row["teamName"] = team_names.get(team_id)
        application_rows.append(row)

    return {
        "person_id": email,
        "member": member,
        "member_records": member_records,
        "people_portal": {
            "active": bool(member.get("active", True)),
            "memberSince": member.get("memberSince"),
            "applicationCount": len(application_rows),
            "stageCounts": dict(sorted(stage_counts.items())),
            "allApplicationsRejected": all_applications_rejected,
            "applicationOutcomeIsNotMembershipEligibility": True,
            "currentRoles": sorted(str(value) for value in ((member.get("attributes") or {}).get("roles") or {}).values()),
            "applicationTeamIds": sorted({str(application.get("teamId")) for application in application_rows if application.get("teamId")}),
            "applicationTeamNames": sorted({team_names[str(application.get("teamId"))] for application in application_rows if team_names.get(str(application.get("teamId")))}),
            "notesCount": len(notes),
            "ratingsCount": len(ratings),
            "resumeCount": len(resume_by_key),
            "resumeRetrievedCount": sum(1 for resume in resume_by_key.values() if resume.get("retrieved")),
            "applications": application_rows,
            "resumes": list(resume_by_key.values()),
        },
        "gitea": {
            "matched": bool(gitea_records),
            "match": {
                "method": "normalized_email_exact" if gitea_records else None,
                "recordCount": len(gitea_records),
                "rosterRecordCount": sum(
                    1 for record in gitea_records if record.get("roster_member", True) is not False
                ),
                "contributorIdentityRecordCount": sum(
                    1 for record in gitea_records if record.get("roster_member") is False
                ),
            },
            "identities": [
                {
                    "login": record.get("login"),
                    "name": record.get("name"),
                    "email": record.get("email"),
                    "rosterMember": record.get("roster_member", True),
                    "identityAliases": record.get("identity_aliases") or [],
                }
                for record in gitea_records
            ],
            "metrics": aggregate_gitea(gitea_records),
            "records": gitea_records,
            "candidateRecords": candidate_gitea_records,
        },
        "provenance": {
            "personIdStrategy": "normalized_email",
            "peoplePortalGeneratedAt": source["peoplePortalGeneratedAt"],
            "peoplePortalArchive": source["peoplePortalArchive"],
            "giteaGeneratedAt": source["giteaGeneratedAt"],
            "giteaAnalyticsSchema": source.get("giteaAnalyticsSchema"),
            "giteaMetricSemantics": source.get("giteaMetricSemantics") or {},
            "giteaHistoryScope": source["giteaHistoryScope"],
            "giteaCommitStatsScope": source["giteaCommitStatsScope"],
            "giteaBlame": source["giteaBlame"],
            "giteaCoverage": source["giteaCoverage"],
            "warnings": warnings,
        },
    }


def identity_review_rows(profiles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flatten candidate-only Gitea identities into a reviewer queue.

    Candidate rows are intentionally not folded into ``gitea.metrics``. This
    artifact is the evidence surface a human can use to approve an identity
    mapping without changing the canonical ranking data by inference.
    """

    rows: list[dict[str, Any]] = []
    for profile in profiles:
        member = profile.get("member") or {}
        for record in profile.get("gitea", {}).get("candidateRecords") or []:
            aliases = record.get("identity_aliases") or []
            rows.append(
                {
                    "person_id": profile.get("person_id"),
                    "candidate_identity_id": candidate_identity_id(record),
                    "member_login": member.get("username") or member.get("login"),
                    "member_name": member.get("name") or profile.get("person_id"),
                    "candidate_identity": {
                        "login": record.get("login"),
                        "name": record.get("name"),
                        "email": record.get("email"),
                        "resolution": "heuristic_candidate_only",
                        "candidate_identities": sorted({
                            str(candidate)
                            for alias in aliases
                            if isinstance(alias, dict)
                            for candidate in alias.get("candidate_identities") or []
                        }, key=str.casefold),
                    },
                    "metrics": {field: metric_snapshot(record)[field] for field in GITEA_NUMERIC_FIELDS},
                    "availability": metric_snapshot(record)["availability"],
                    "observed_values": metric_snapshot(record)["observed_values"],
                    "source_refs": record.get("source_refs") or [],
                    "included_in_canonical_metrics": False,
                    "identity_aliases": aliases,
                    "status": "pending_review",
                    "source_run": profile.get("provenance", {}).get("giteaGeneratedAt"),
                }
            )
    return sorted(
        rows,
        key=lambda row: (
            -int((row.get("metrics") or {}).get("pulls_merged_contributed_to") or 0),
            -int((row.get("metrics") or {}).get("commits") or 0),
            str(row.get("member_name") or "").casefold(),
        ),
    )


def write_json(path: Path, value: Any) -> None:
    atomic_write(path, json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")


def build(args: argparse.Namespace) -> dict[str, Any]:
    peopleportal_zip = args.peopleportal_zip or find_peopleportal_zip(DEFAULT_OUTPUT_ROOT)
    if not peopleportal_zip.exists():
        raise FileNotFoundError(peopleportal_zip)
    if not args.gitea_analytics.exists():
        raise FileNotFoundError(args.gitea_analytics)

    gitea = json.loads(args.gitea_analytics.read_text(encoding="utf-8"))
    gitea_manifest = {}
    if args.gitea_manifest.exists():
        gitea_manifest = json.loads(args.gitea_manifest.read_text(encoding="utf-8"))

    with zipfile.ZipFile(peopleportal_zip) as archive:
        members = as_list(load_json_from_zip(archive, "peopleportal/active-members.json"))
        applications = as_list(load_json_from_zip(archive, "peopleportal/applications.json"))
        teams = as_list(load_json_from_zip(archive, "peopleportal/teams.json"))
        people_manifest = load_json_from_zip(archive, "peopleportal/manifest.json")
        failures = as_list(load_json_from_zip(archive, "peopleportal/failures.json"))
        resume_records = as_list(people_manifest.get("resumes"))

    active_member_entries = [
        (index, member)
        for index, member in enumerate(members)
        if member.get("active") is True
    ]
    active_members = [member for _, member in active_member_entries]
    active_members_without_email = [member for member in active_members if not normalize_email(member.get("email"))]
    member_by_email: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for member in active_members:
        email = normalize_email(member.get("email"))
        if email:
            member_by_email[email].append(member)
    duplicate_member_emails = {
        email for email, rows in member_by_email.items() if len(rows) > 1
    }
    # A duplicate active roster email is not a person join. Quarantine every
    # row in the collision rather than selecting records[0] or last-write-wins.
    unique_member_by_email = {
        email: rows[0]
        for email, rows in member_by_email.items()
        if len(rows) == 1
    }
    peopleportal_identity_collisions = [
        {
            "reason": "duplicate_email",
            "email": email,
            "members": [
                {
                    "member": member,
                    "source_ref": {
                        "source_file": "peopleportal/active-members.json",
                        "json_pointer": f"/items/{index}",
                    },
                }
                for index, member in active_member_entries
                if normalize_email(member.get("email")) == email
            ],
            "included_in_canonical_profiles": False,
        }
        for email in sorted(duplicate_member_emails)
    ]

    applications_by_email: dict[str, list[dict[str, Any]]] = defaultdict(list)
    applications_without_email = 0
    for application in applications:
        email = app_email(application)
        if not email:
            applications_without_email += 1
            continue
        applications_by_email[email].append(application)

    # Application outcome is evidence, not club-membership eligibility. Keep
    # active roster members in the profile population even when every linked
    # People Portal application was rejected.
    all_rejected_emails: set[str] = set()
    excluded_application_count = 0
    for email, rows in applications_by_email.items():
        stages = [stage_for(row).casefold() for row in rows]
        if stages and all(stage == "rejected" for stage in stages):
            all_rejected_emails.add(email)
            excluded_application_count += len(rows)

    included_resume_names = {
        str(application.get("resume", {}).get("fileName"))
        for rows in applications_by_email.values()
        for application in rows
        if application.get("resume", {}).get("fileName")
    }
    with zipfile.ZipFile(peopleportal_zip) as archive:
        resume_files = copy_resume_files(
            archive,
            [record for record in resume_records if str(record.get("fileName")) in included_resume_names],
            args.output_dir,
        )

    gitea_by_email: dict[str, list[dict[str, Any]]] = defaultdict(list)
    unmatched_gitea: list[dict[str, Any]] = []
    excluded_gitea: list[dict[str, Any]] = []
    seen_gitea_records: set[str] = set()
    member_emails_by_login: dict[str, set[str]] = defaultdict(set)
    # Candidate IDs are Gitea account logins, not People Portal usernames.
    # Bridge them only through an email-linked Gitea roster account.
    for record in as_list(gitea.get("members")):
        email = normalize_email(record.get("email"))
        login = str(record.get("login") or "").strip().casefold()
        if record.get("roster_member", True) and email in unique_member_by_email and exact_identity_keys(login=login):
            member_emails_by_login[login].add(email)
    gitea_roster_by_email: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in as_list(gitea.get("members")):
        email = normalize_email(record.get("email"))
        if record.get("roster_member", True) and email:
            gitea_roster_by_email[email].append(record)
    duplicate_gitea_emails = {
        email for email, rows in gitea_roster_by_email.items() if len(rows) > 1
    }
    candidate_gitea_by_email: dict[str, list[dict[str, Any]]] = defaultdict(list)
    unassigned_candidate_records: list[dict[str, Any]] = []
    for record_index, record in enumerate(as_list(gitea.get("members"))):
        record = apply_collection_coverage(record, gitea.get("coverage"))
        record["source_refs"] = [{"source_file": "analytics.json", "json_pointer": f"/members/{record_index}"}]
        email = normalize_email(record.get("email"))
        record_key = json.dumps(
            {
                "login": record.get("login"),
                "email": email,
                "roster_member": record.get("roster_member", True),
                "organizations": sorted(str(value) for value in record.get("organizations") or []),
            },
            sort_keys=True,
        )
        if record_key in seen_gitea_records:
            continue
        seen_gitea_records.add(record_key)
        weak_aliases = any(
            alias.get("resolution") in {"heuristic_candidate_only", "ambiguous_strong_identity", "heuristic_candidates_suppressed"}
            for alias in record.get("identity_aliases") or []
        )
        if not email or not exact_identity_keys(email=email):
            unmatched_gitea.append({"reason": "missing_email", "record": record})
        elif weak_aliases:
            unmatched_gitea.append({"reason": "pending_identity_review", "record": record})
        elif record.get("roster_member", True) and email in duplicate_gitea_emails:
            unmatched_gitea.append({"reason": "duplicate_email_collision", "record": record})
        elif record.get("roster_member", True) and email in duplicate_member_emails:
            unmatched_gitea.append({"reason": "peopleportal_duplicate_email_collision", "record": record})
        elif record.get("roster_member", True) and email in unique_member_by_email:
            gitea_by_email[email].append(record)
        elif record.get("roster_member", True):
            unmatched_gitea.append({"reason": "no_active_peopleportal_member", "record": record})
        candidate_ids = candidate_targets(record)
        matched_emails = set().union(*(member_emails_by_login.get(candidate_id, set()) for candidate_id in candidate_ids)) if candidate_ids else set()
        # Resolve the whole candidate set, including targets outside the active
        # roster. An ambiguous set must not become unique by filtering it.
        if len(candidate_ids) == 1 and len(matched_emails) == 1 and not record.get("roster_member", True):
            candidate_gitea_by_email[next(iter(matched_emails))].append(record)
        elif candidate_ids:
            unassigned_candidate_records.append({
                "candidate_identity_id": candidate_identity_id(record),
                "status": "pending_review_unassigned",
                "candidate_count": len(candidate_ids),
                "reason": "ambiguous_candidate_set" if len(candidate_ids) > 1 or len(matched_emails) > 1 else "no_active_member_match",
                "possible_member_ids": sorted(matched_emails),
                "record": record,
                "included_in_canonical_metrics": False,
            })
        elif not record.get("roster_member", True):
            unmatched_gitea.append({"reason": "non_roster_identity_not_auto_joined", "record": record})

    team_names = team_name_map(teams)
    inaccessible_teams = (people_manifest.get("summary") or {}).get("inaccessibleTeams") or []
    if not inaccessible_teams:
        inaccessible_teams = [
            {
                "teamId": PurePosixPath(str(failure.get("path"))).name,
                "status": failure.get("status"),
            }
            for failure in failures
            if str(failure.get("status")) in {"401", "403"}
            and str(failure.get("path") or "").count("/") == 4
            and str(failure.get("path") or "").startswith("/api/ats/applications/")
        ]
    source = {
        "peoplePortalGeneratedAt": people_manifest.get("generatedAt"),
        "peoplePortalArchive": peopleportal_zip.name,
        "input_sha256": {
            "peoplePortalArchive": hashlib.sha256(peopleportal_zip.read_bytes()).hexdigest(),
            "analytics.json": hashlib.sha256(args.gitea_analytics.read_bytes()).hexdigest(),
            "manifest.json": hashlib.sha256(args.gitea_manifest.read_bytes()).hexdigest() if args.gitea_manifest.exists() else None,
        },
        "giteaRunId": gitea.get("run_id") or gitea_manifest.get("run_id"),
        "giteaGeneratedAt": gitea.get("generated_at") or gitea_manifest.get("generated_at"),
        "giteaHistoryScope": gitea.get("history_scope") or gitea_manifest.get("history_scope"),
        "giteaCommitStatsScope": gitea.get("commit_stats_scope"),
        "giteaBlame": gitea.get("blame") or {
            "status": "unknown" if gitea.get("blame_method") else "disabled",
            "method": gitea.get("blame_method"),
        },
        "giteaOrganizations": [
            str(row.get("organization"))
            for row in gitea.get("organizations") or []
            if row.get("organization")
        ],
        "giteaIdentityResolution": gitea.get("identity_resolution"),
        "giteaAnalyticsSchema": gitea.get("schema") or gitea_manifest.get("analytics_schema"),
        "giteaMetricSemantics": {**(gitea.get("metric_semantics") or {}), **METRIC_SEMANTICS},
        "giteaOrganizationSelection": gitea_manifest.get("organization_selection"),
        "giteaCoverage": gitea.get("coverage") if "coverage" in gitea else None,
        "giteaWarnings": gitea.get("warnings") or gitea_manifest.get("warnings") or [],
    }

    profiles: list[dict[str, Any]] = []
    for email, member in sorted(unique_member_by_email.items()):
        profile = build_profile(
            member,
            [member],
            applications_by_email.get(email, []),
            gitea_by_email.get(email, []),
            resume_files,
            source,
            team_names,
            candidate_gitea_by_email.get(email, []),
        )
        profiles.append(profile)

    gitea_records = as_list(gitea.get("members"))
    coverage = source.get("giteaCoverage")
    coverage_gaps = [
        event for event in coverage or []
        if isinstance(event, dict) and str(event.get("status")) != "complete"
    ] if coverage is not None else [{"status": "unknown", "reason": "coverage metadata missing"}]
    summary = {
        "activeMembersInSource": len(active_members),
        "activeMembersWithoutEmail": len(active_members_without_email),
        "profilesIncluded": len(profiles),
        # Kept for downstream compatibility; active members are no longer
        # excluded based on application outcomes.
        "profilesExcludedCompletelyRejected": 0,
        "profilesWithAllRejectedApplications": sum(
            1 for profile in profiles if profile["people_portal"].get("allApplicationsRejected")
        ),
        "excludedApplicationRecords": excluded_application_count,
        "duplicateActiveMemberEmails": len(duplicate_member_emails),
        "duplicateGiteaRosterEmails": len(duplicate_gitea_emails),
        "peoplePortalApplicationRecordsInSource": len(applications),
        "applicationsWithoutEmail": applications_without_email,
        "applicationRecordsIncludedInProfiles": sum(profile["people_portal"]["applicationCount"] for profile in profiles),
        "uniqueApplicantsInSource": len({str(application.get("applicantId")) for application in applications if application.get("applicantId")}),
        "profilesWithApplications": sum(1 for profile in profiles if profile["people_portal"]["applicationCount"]),
        "profilesWithInterviewNotes": sum(1 for profile in profiles if profile["people_portal"]["notesCount"]),
        "profilesWithRatings": sum(1 for profile in profiles if profile["people_portal"]["ratingsCount"]),
        "profilesWithRetrievedResume": sum(1 for profile in profiles if profile["people_portal"]["resumeRetrievedCount"]),
        "retrievedResumeFiles": len(resume_files),
        "giteaMatchedProfiles": sum(1 for profile in profiles if profile["gitea"]["matched"]),
        "giteaMatchedProfilesWithRosterRecord": sum(
            1
            for profile in profiles
            if profile["gitea"]["match"]["rosterRecordCount"]
        ),
        "giteaMatchedProfilesWithContributorIdentityOnly": sum(
            1
            for profile in profiles
            if profile["gitea"]["matched"]
            and not profile["gitea"]["match"]["rosterRecordCount"]
        ),
        "giteaProfilesWithCandidateIdentity": sum(
            1 for profile in profiles if profile["gitea"].get("candidateRecords")
        ),
        "giteaRecordsInSource": len(gitea_records),
        "giteaRosterRecords": sum(
            1 for record in gitea_records if record.get("roster_member", True) is not False
        ),
        "giteaContributorIdentityRecords": sum(
            1 for record in gitea_records if record.get("roster_member") is False
        ),
        "giteaRecordsWithIdentityAliases": sum(
            1 for record in gitea_records if record.get("identity_aliases")
        ),
        "giteaIdentityAliases": sum(
            len(record.get("identity_aliases") or []) for record in gitea_records
        ),
        "giteaOrganizationsInSource": len(gitea.get("organizations") or []),
        "giteaBlameStatus": (gitea.get("blame") or {}).get("status") or (
            "unknown" if gitea.get("blame_method") else "disabled"
        ),
        "giteaCoverageGaps": len(coverage_gaps),
        "giteaCoverageStatus": "unknown" if coverage is None else ("partial" if coverage_gaps else "complete"),
        "giteaUnmatchedRecords": len(unmatched_gitea),
        "giteaExcludedRecords": len(excluded_gitea),
        "giteaRetainedForAllRejectedMembers": sum(
            1 for email in all_rejected_emails if gitea_by_email.get(email)
        ),
        "inaccessibleTeams": inaccessible_teams,
        "peoplePortalFailures": (people_manifest.get("summary") or {}).get("failedRequests", len(failures)),
    }
    warnings = []
    if inaccessible_teams:
        warnings.append("People Portal application coverage is incomplete for inaccessible teams")
    if applications_without_email:
        warnings.append(f"{applications_without_email} People Portal application records had no email and were not linked")
    if active_members_without_email:
        warnings.append(f"{len(active_members_without_email)} active People Portal members had no email and were not profiled")
    if all_rejected_emails:
        warnings.append(
            f"{len(all_rejected_emails)} active members had only rejected People Portal applications; retained in the roster"
        )
    blame_status = source["giteaBlame"].get("status")
    if blame_status in {"disabled", "failed", "partial", "unknown", None}:
        warnings.append(f"Gitea line ownership is {blame_status or 'unknown'} for this run")
    if unmatched_gitea:
        warnings.append(f"{len(unmatched_gitea)} Gitea records were not linked by email")
    if duplicate_member_emails:
        warnings.append(
            f"{len(duplicate_member_emails)} People Portal email collision(s) were quarantined from canonical joins"
        )
    if duplicate_gitea_emails:
        warnings.append(
            f"{len(duplicate_gitea_emails)} Gitea roster email collision(s) were quarantined from canonical joins"
        )
    if coverage_gaps:
        warnings.append(
            "Gitea coverage metadata is missing; zero metrics are not authoritative"
            if coverage is None
            else f"{len(coverage_gaps)} Gitea collection endpoint(s) are partial or failed; affected metrics are unavailable"
        )
    unavailable_organizations = (
        (gitea_manifest.get("organization_selection") or {}).get("unavailable") or []
    )
    summary["giteaUnavailableOrganizations"] = len(unavailable_organizations)
    if unavailable_organizations:
        warnings.append(
            f"{len(unavailable_organizations)} People Portal teams have no available Gitea organization"
        )

    artifact = {
        "schema": "horizon.member-profiles.v2",
        "generated_at": source.get("giteaGeneratedAt") or source.get("peoplePortalGeneratedAt") or "1970-01-01T00:00:00+00:00",
        "person_id_strategy": "normalized_email",
        "summary": {**summary, "warnings": warnings},
        "source": source,
        "profiles": profiles,
        "unmatched_peopleportal_members": active_members_without_email,
        "quarantined_peopleportal_members": peopleportal_identity_collisions,
        "unmatched_gitea_records": unmatched_gitea,
        "excluded_gitea_records": excluded_gitea,
    }

    args.output_dir.mkdir(parents=True, exist_ok=True)
    recruiting_source = build_recruiting_source_payload(profiles, args.output_dir, source)
    artifact["recruiting_source"] = {
        "schema": recruiting_source["schema"],
        "path": "recruiting-source.json",
        "candidate_count": len(recruiting_source["candidates"]),
        "resume_extraction": recruiting_source["source"]["resume_extraction"],
    }
    artifact["summary"]["recruitingCandidatesGenerated"] = len(recruiting_source["candidates"])
    artifact["summary"]["resumeExtractionStatuses"] = recruiting_source["source"]["resume_extraction"]
    review_rows = identity_review_rows(profiles)
    identity_review = {
        "schema": "horizon.gitea-identity-review.v1",
        "generated_at": artifact["generated_at"],
        "status": "pending_human_review",
        "summary": {
            "candidate_records": len(review_rows),
            "unassigned_candidate_records": len(unassigned_candidate_records),
            "members_with_candidates": len({row["person_id"] for row in review_rows}),
            "members_without_candidates": sum(
                1 for profile in profiles if not profile["gitea"].get("candidateRecords")
            ),
        },
        "candidates": review_rows,
        "unassigned_candidates": unassigned_candidate_records,
        "policy": {
            "automatic_attribution": False,
            "approval_requirement": "review exact account, email, repository scope, and authored-commit evidence before canonical merge",
            "missingness": "candidate metrics remain separate and are not treated as canonical zeros or rank inputs",
        },
    }
    write_json(args.output_dir / "identity-review.json", identity_review)
    artifact["identity_review"] = {
        "schema": identity_review["schema"],
        "path": "identity-review.json",
        "candidate_count": len(review_rows),
        "member_count": len({row["person_id"] for row in review_rows}),
    }
    artifact["summary"]["giteaIdentityReviewCandidates"] = len(review_rows)
    artifact["summary"]["giteaIdentityReviewMembers"] = len({row["person_id"] for row in review_rows})
    write_json(args.output_dir / "member-profiles.json", artifact)
    write_json(args.output_dir / "recruiting-source.json", recruiting_source)
    write_json(args.output_dir / "member-profiles-manifest.json", {"schema": artifact["schema"], "generated_at": artifact["generated_at"], "person_id_strategy": artifact["person_id_strategy"], "source": source, "summary": artifact["summary"]})
    return artifact


def main() -> int:
    args = parse_args()
    artifact = build(args)
    print(json.dumps({"summary": artifact["summary"], "output_dir": str(args.output_dir)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
