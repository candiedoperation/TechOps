"""Evidence-first recruiting signal pipeline.

The pipeline joins two sources:

* the named Gitea member-analytics run, used for observable organization
  contribution indicators; and
* an optional normalized People Portal API snapshot, used for interview
  evidence and resume impact evidence.

An optional structured LLM call can organize source-backed evidence, but
numeric components remain deterministic and the result is explicitly
provisional until a human reviews each candidate. Employer names, schools,
titles, and other prestige proxies are never read by the scoring function.
"""

from __future__ import annotations

from datetime import datetime, timezone
import re
import math
from collections import defaultdict
from typing import Any

from .artifacts import payload_digest
from .gitea_evidence import metric_snapshot
from .config import Settings
from .llm import StructuredLLM
from .models import (
    MemberMetricsDocument,
    RecruitingEvidenceClaim,
    RecruitingEvidenceReference,
    RecruitingEligibilityStatus,
    RecruitingEmploymentEvidence,
    RecruitingMemberStats,
    RecruitingRankingSnapshot,
    RecruitingRunDocument,
    RecruitingSignalBand,
    RecruitingSignalDocument,
    RecruitingSourceCandidateDocument,
    RecruitingSourceRunDocument,
    AuditLogDocument,
    new_id,
    utc_now,
)

RECRUITING_VERSION = "recruiting-v6-people-portal-api-evidence-review"
ELIGIBILITY_POLICY_VERSION = "outreach-human-review-v2"

# This list controls outreach eligibility only. It is never read by the
# ability/contribution score. Subsidiaries and commonly used aliases are
# included because résumé text frequently names the product rather than the
# parent company.
TOP_TIER_EMPLOYER_ALIASES = {
    "nvidia", "apple", "google", "alphabet", "microsoft", "amazon", "meta", "facebook",
    "tesla", "netflix", "audible", "aws", "amazon web services", "azure", "calico",
    "deepmind", "deep mind", "everyday robots", "github", "google cloud", "instagram",
    "intrinsic", "linkedin", "one medical", "twitch", "wing", "youtube", "zoox", "faang", "faang+",
}
QUANT_HEDGE_EMPLOYER_ALIASES = {
    "citadel", "citadel securities", "jane street", "hudson river trading", "two sigma",
    "jump trading", "imc trading", "optiver", "renaissance technologies", "d e shaw",
    "de shaw", "tower research", "point72", "millennium management", "susquehanna",
    "susquehanna international group", "sig", "worldquant", "quantlab", "drw",
    "virtu financial", "akuna capital", "five rings", "xtx markets", "cubist",
    "man group", "bridgewater", "elliptic", "maven securities",
}
QUANT_HEDGE_TYPE_MARKERS = {
    "hedge fund", "quant fund", "quant", "quantitative analyst", "quantitative trading", "quant trading", "prop trading",
    "proprietary trading", "market making", "algorithmic trading", "systematic trading",
}

# These weights are product policy, not learned from hiring outcomes. They are
# kept in the run so a reviewer can inspect exactly what produced a rank.
SCORING_POLICY: dict[str, Any] = {
    "purpose": "discovery_ordering_only",
    "decision_status": "human_required",
    "llm_role": "human_screened_evidence_extraction_only",
    "unstructured_evidence_policy": "human_screening_required_before_scoring_or_model_use",
    "missingness_policy": "unknown_is_not_zero",
    "eligibility_policy_version": ELIGIBILITY_POLICY_VERSION,
    "eligibility": {
        "excluded_status": "human_decision_only",
        "ambiguous_status": "needs_review",
        "missing_status": "needs_review",
        "top_tier_aliases": sorted(TOP_TIER_EMPLOYER_ALIASES),
        "quant_hedge_aliases": sorted(QUANT_HEDGE_EMPLOYER_ALIASES),
        "generic_quant_hedge_markers": sorted(QUANT_HEDGE_TYPE_MARKERS),
        "ability_score_uses_employer_context": False,
    },
    "combined_weights": {"club_contribution": 0.55, "engineering_ability": 0.45},
    "ability_dimensions": {"resume_evidence": 0.65, "interview_evidence": 0.35},
    "contribution_dimensions": {
        "pulls_merged_contributed_to": 0.24,
        "reviews_submitted": 0.18,
        "active_days": 0.16,
        "repositories": 0.14,
        "issues_opened": 0.10,
        "commits": 0.08,
        "unique_files": 0.06,
        "blame_lines": 0.04,
    },
    "excluded_from_score": [
        "employer_name",
        "school_name",
        "brand_prestige",
        "age",
        "gender",
        "race_or_ethnicity",
        "disability",
        "nationality",
    ],
}


def _normalized_employer(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()


def _employer_matches(text: str, alias: str) -> bool:
    if not text or not alias:
        return False
    return f" {alias} " in f" {text} "


def classify_outreach_eligibility(
    employers: list[str],
) -> tuple[RecruitingEligibilityStatus, list[str]]:
    """Classify only the explicit outreach exclusion policy.

    A named top-tier/quant employer is excluded from the tier-2 outreach list.
    Generic or ambiguous descriptions remain ``needs_review`` rather than
    being treated as proof of either eligibility or exclusion. Missing employer
    evidence is also reviewable instead of silently becoming eligible.
    """

    normalized = [_normalized_employer(value) for value in employers if str(value or "").strip()]
    matched_top_tier = sorted({
        alias for text in normalized for alias in TOP_TIER_EMPLOYER_ALIASES
        if _employer_matches(text, alias)
    })
    matched_quant = sorted({
        alias for text in normalized for alias in QUANT_HEDGE_EMPLOYER_ALIASES
        if _employer_matches(text, alias)
    })
    matched_types = sorted({
        marker for text in normalized for marker in QUANT_HEDGE_TYPE_MARKERS
        if _employer_matches(text, marker)
    })
    reasons: list[str] = []
    if matched_top_tier:
        reasons.append(f"explicit top-tier employer match: {', '.join(matched_top_tier)}")
    if matched_quant:
        reasons.append(f"explicit quant/hedge employer match: {', '.join(matched_quant)}")
    if reasons:
        return RecruitingEligibilityStatus.NEEDS_REVIEW, [f"Verify employer context: {reason}" for reason in reasons]
    if matched_types:
        return RecruitingEligibilityStatus.NEEDS_REVIEW, [
            f"generic quant/hedge description requires employer verification: {', '.join(matched_types)}"
        ]
    if not normalized:
        return RecruitingEligibilityStatus.NEEDS_REVIEW, [
            "prior-employment evidence is missing; confirm outreach interest and availability"
        ]
    return RecruitingEligibilityStatus.NEEDS_REVIEW, [
        "no configured top-tier or quant/hedge exclusion match was found; confirm interest and availability"
    ]


def _timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if value:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    raise ValueError("source generated_at must be an ISO timestamp")


def _optional_number(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
        if not math.isfinite(number) or number < 0 or int(number) != number or isinstance(value, bool):
            return None
        return int(number)
    except (TypeError, ValueError, OverflowError):
        return None


def _optional_positive_int(value: Any) -> int | None:
    number = _optional_number(value)
    return number if number is not None and number > 0 else None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalized_email(value: Any) -> str | None:
    """Normalize the explicit cross-source join key without provider aliases."""

    value = _text(value)
    return value.casefold() if value else None


def _list_text(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _nested(raw: dict[str, Any], *keys: str) -> dict[str, Any]:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, dict):
            return value
    return {}


def _stats_from_payload(raw: dict[str, Any]) -> RecruitingMemberStats:
    source = raw.get("member_stats") or raw.get("memberStats") or raw.get("stats") or raw
    if not isinstance(source, dict):
        source = {}
    aliases = {"unique_files": "uniqueFiles", "pulls_opened": "pullsOpened", "pulls_merged": "pullsMerged",
               "reviews_submitted": "reviewsSubmitted", "reviews_approved": "reviewsApproved",
               "issues_opened": "issuesOpened", "active_days": "activeDays", "blame_lines": "blameLines"}
    source = dict(source)
    for field, alias in aliases.items():
        if field not in source and alias in source:
            source[field] = source[alias]
    source = metric_snapshot(source)
    return RecruitingMemberStats(
        commits=_optional_number(source.get("commits")),
        commits_default_reachable=_optional_number(source.get("commits_default_reachable")),
        commits_branch_only=_optional_number(source.get("commits_branch_only")),
        additions=_optional_number(source.get("additions")),
        unique_files=_optional_number(source.get("unique_files", source.get("uniqueFiles"))),
        pulls_opened=_optional_number(source.get("pulls_opened", source.get("pullsOpened"))),
        pulls_merged=_optional_number(source.get("pulls_merged", source.get("pullsMerged"))),
        pulls_contributed_to=_optional_number(source.get("pulls_contributed_to")),
        pulls_merged_contributed_to=_optional_number(source.get("pulls_merged_contributed_to")),
        pull_commits_authored=_optional_number(source.get("pull_commits_authored")),
        merged_pull_commits_authored=_optional_number(source.get("merged_pull_commits_authored")),
        reviews_submitted=_optional_number(source.get("reviews_submitted", source.get("reviewsSubmitted"))),
        reviews_approved=_optional_number(source.get("reviews_approved", source.get("reviewsApproved"))),
        issues_opened=_optional_number(source.get("issues_opened", source.get("issuesOpened"))),
        active_days=_optional_number(source.get("active_days", source.get("activeDays"))),
        blame_lines=_optional_number(source.get("blame_lines", source.get("blameLines"))),
        repositories=_list_text(source.get("repositories")),
        commit_stats_status=str(source.get("commit_stats_status") or "unknown"),
        file_stats_status=str(source.get("file_stats_status") or "unknown"),
    )


def _employment_evidence_from_payload(
    raw: dict[str, Any],
    resume: dict[str, Any],
) -> list[RecruitingEmploymentEvidence]:
    values = (
        resume.get("employment")
        or resume.get("employment_history")
        or raw.get("prior_employment_evidence")
        or raw.get("priorEmploymentEvidence")
    )
    if not isinstance(values, list):
        values = []
    result: list[RecruitingEmploymentEvidence] = []
    for value in values[:30]:
        if isinstance(value, str) and value.strip():
            result.append(RecruitingEmploymentEvidence(employer=value.strip()))
            continue
        if not isinstance(value, dict):
            continue
        employer = _text(value.get("employer") or value.get("company") or value.get("name"))
        if not employer:
            continue
        result.append(
            RecruitingEmploymentEvidence(
                employer=employer,
                role=_text(value.get("role") or value.get("title")),
                start_date=_text(value.get("start_date") or value.get("startDate")),
                end_date=_text(value.get("end_date") or value.get("endDate")),
                engagement_type=_text(value.get("engagement_type") or value.get("engagementType")),
                supporting_text=_text(value.get("supporting_text") or value.get("supportingText")),
                source_field=str(value.get("source_field") or value.get("sourceField") or "prior_employment_evidence"),
                verification_status=str(value.get("verification_status") or value.get("verificationStatus") or "self_reported"),
            )
        )
    return result


def _merge_unique_strings(first: list[str], second: list[str], limit: int) -> list[str]:
    result: list[str] = []
    for value in [*first, *second]:
        text = str(value or "").strip()
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _merge_source_candidates(
    existing: RecruitingSourceCandidateDocument,
    incoming: RecruitingSourceCandidateDocument,
) -> RecruitingSourceCandidateDocument:
    """Merge duplicate People Portal rows without double-counting Gitea stats."""

    existing.evidence_reviewed_for_scoring = existing.evidence_reviewed_for_scoring and incoming.evidence_reviewed_for_scoring
    existing.interview_evidence = _merge_unique_strings(existing.interview_evidence, incoming.interview_evidence, 20)
    existing.resume_evidence = _merge_unique_strings(existing.resume_evidence, incoming.resume_evidence, 30)
    existing.prior_employers = _merge_unique_strings(existing.prior_employers, incoming.prior_employers, 20)
    employment_keys = {
        (item.employer.casefold(), item.role or "", item.start_date or "", item.end_date or "")
        for item in existing.prior_employment_evidence
    }
    for item in incoming.prior_employment_evidence:
        key = (item.employer.casefold(), item.role or "", item.start_date or "", item.end_date or "")
        if key not in employment_keys:
            existing.prior_employment_evidence.append(item)
            employment_keys.add(key)
    existing.prior_employment_evidence = existing.prior_employment_evidence[:30]
    if len(incoming.interview_summary or "") > len(existing.interview_summary or ""):
        existing.interview_summary = incoming.interview_summary
    if len(incoming.resume_summary or "") > len(existing.resume_summary or ""):
        existing.resume_summary = incoming.resume_summary
    if existing.interview_score is None or (
        incoming.interview_score is not None and incoming.interview_score > existing.interview_score
    ):
        existing.interview_score = incoming.interview_score
    existing.source_refs = list({
        (ref.source_type, ref.source_id, ref.source_field): ref
        for ref in [*existing.source_refs, *incoming.source_refs]
    }.values())[:100]
    existing.source_status = "complete" if "complete" in {existing.source_status, incoming.source_status} else "incomplete"
    existing.eligibility_status, existing.eligibility_reasons = classify_outreach_eligibility(existing.prior_employers)
    existing.eligibility_evidence = [
        RecruitingEvidenceReference(
            source_type="people_portal",
            source_id=existing.source_run_id,
            source_field=item.source_field,
            label=f"Employment evidence: {item.employer}",
        )
        for item in existing.prior_employment_evidence
    ][:20]
    # Gitea stats are joined from the analytics run later. When duplicate
    # source rows carry stats, retain the largest observation rather than sum
    # the same person's activity twice.
    for field in (
        "commits", "commits_default_reachable", "commits_branch_only", "pulls_opened",
        "pulls_merged", "pulls_contributed_to", "pulls_merged_contributed_to",
        "pull_commits_authored", "merged_pull_commits_authored", "reviews_submitted",
        "reviews_approved", "issues_opened", "active_days",
    ):
        values = [
            value for value in (getattr(existing.member_stats, field), getattr(incoming.member_stats, field))
            if value is not None
        ]
        setattr(existing.member_stats, field, max(values) if values else None)
    for field in ("additions", "unique_files"):
        values = [value for value in (getattr(existing.member_stats, field), getattr(incoming.member_stats, field)) if value is not None]
        setattr(existing.member_stats, field, max(values) if values else None)
    existing.member_stats.repositories = _merge_unique_strings(existing.member_stats.repositories, incoming.member_stats.repositories, 200)
    return existing


def normalize_people_portal_payload(
    payload: dict[str, Any],
    *,
    source_run_id: str | None = None,
) -> tuple[str, list[RecruitingSourceCandidateDocument]]:
    """Normalize a People Portal API snapshot without persisting raw resume files.

    Accepted input is intentionally tolerant of the ATS shape already used by
    People Portal: ``fullName``, ``profile``, ``responses``, ``stars``, and
    ``notes`` are mapped alongside the cleaner ``interview`` / ``resume``
    shape used by the recruiting pipeline. Upstream should provide extracted
    resume impact bullets rather than sending a PDF or unrestricted resume text
    through the API.
    """

    if not isinstance(payload, dict):
        raise ValueError("recruiting payload must be an object")
    generated_at = _timestamp(payload.get("generated_at"))
    resolved_run_id = source_run_id or payload.get("source_run_id") or f"people-portal-{payload_digest(payload)[:32]}"
    raw_candidates = next((payload[key] for key in ("candidates", "members", "applications") if key in payload), None)
    if not isinstance(raw_candidates, list):
        raise ValueError("recruiting payload requires a candidates array")
    documents: list[RecruitingSourceCandidateDocument] = []

    for raw in raw_candidates:
        if not isinstance(raw, dict):
            raise ValueError("candidate must be an object")
        profile = _nested(raw, "profile", "applicant_profile")
        interview = _nested(raw, "interview", "interview_evidence")
        resume = _nested(raw, "resume", "resume_evidence")
        member_login = _text(
            raw.get("member_login")
            or raw.get("memberLogin")
            or raw.get("login")
            or raw.get("username")
            or profile.get("githubUsername")
            or profile.get("github_username")
            or raw.get("email")
        )
        if not member_login:
            raise ValueError("candidate identifier is required")
        member_login = member_login.casefold()
        member_name = _text(raw.get("member_name") or raw.get("fullName") or raw.get("name")) or member_login
        email = _normalized_email(raw.get("email") or profile.get("email"))

        interview_score = interview.get("score", interview.get("rating", raw.get("stars")))
        try:
            interview_score = float(interview_score) if interview_score is not None else None
        except (TypeError, ValueError):
            interview_score = None
        if interview_score is not None:
            interview_score = max(0.0, min(5.0, interview_score)) if math.isfinite(interview_score) else None
        interview_summary = _text(
            interview.get("summary")
            or interview.get("notes")
            or raw.get("interview_summary")
            or raw.get("interviewSummary")
            or raw.get("notes")
        )
        interview_evidence = _list_text(
            interview.get("evidence")
            or interview.get("highlights")
            or raw.get("interview_evidence")
            or raw.get("interviewEvidence")
        )
        if not interview_evidence and interview_summary:
            interview_evidence = [interview_summary]

        resume_summary = _text(
            resume.get("summary")
            or resume.get("impact_summary")
            or raw.get("resume_summary")
            or raw.get("resumeSummary")
            or profile.get("resumeSummary")
        )
        resume_evidence = _list_text(
            resume.get("evidence")
            or resume.get("impact_bullets")
            or resume.get("impactBullets")
            or raw.get("resume_evidence")
            or raw.get("resumeEvidence")
        )
        if not resume_evidence and resume_summary:
            resume_evidence = [resume_summary]
        prior_employers = _list_text(
            resume.get("prior_employers")
            or resume.get("priorEmployers")
            or raw.get("prior_employers")
            or raw.get("priorEmployers")
        )
        employment_evidence = _employment_evidence_from_payload(raw, resume)
        prior_employers = _merge_unique_strings(
            prior_employers,
            [item.employer for item in employment_evidence],
            20,
        )
        eligibility_status, eligibility_reasons = classify_outreach_eligibility(prior_employers)
        source_status = "complete" if resume_evidence and interview_evidence and interview_score is not None else "incomplete"
        refs: list[RecruitingEvidenceReference] = []
        for raw_ref in raw.get("source_refs") or []:
            if not isinstance(raw_ref, dict):
                continue
            try:
                refs.append(RecruitingEvidenceReference.model_validate(raw_ref))
            except (TypeError, ValueError):
                continue
        if not refs:
            refs = [
                RecruitingEvidenceReference(
                    source_type="people_portal",
                    source_id=resolved_run_id,
                    source_field="interview",
                    label="People Portal interview evidence",
                ),
                RecruitingEvidenceReference(
                    source_type="people_portal",
                    source_id=resolved_run_id,
                    source_field="resume",
                    label="People Portal resume impact evidence",
                ),
            ]
        documents.append(
            RecruitingSourceCandidateDocument(
                id=new_id(),
                evidence_reviewed_for_scoring=raw.get("evidence_reviewed_for_scoring") is True,
                person_id=_text(raw.get("person_id")) or (email.casefold() if email else member_login),
                people_portal_member_pk=_optional_positive_int(
                    raw.get("people_portal_member_pk")
                    or raw.get("peoplePortalMemberPk")
                    or raw.get("member_pk")
                    or raw.get("memberPk")
                ),
                canonical_stats=payload.get("schema") in {"horizon.recruiting-source.v1", "horizon.recruiting-source.v2"},
                gitea_logins=_list_text(raw.get("gitea_logins")),
                source_run_id=resolved_run_id,
                source_generated_at=generated_at,
                member_login=member_login,
                member_name=member_name,
                email=email,
                applicant_id=_text(raw.get("applicant_id") or raw.get("applicantId")),
                member_stats=_stats_from_payload(raw),
                interview_score=interview_score,
                interview_summary=interview_summary,
                interview_evidence=interview_evidence[:20],
                resume_summary=resume_summary,
                resume_evidence=resume_evidence[:30],
                prior_employers=prior_employers[:20],
                prior_employment_evidence=employment_evidence,
                eligibility_status=eligibility_status,
                eligibility_reasons=eligibility_reasons,
                eligibility_evidence=[
                    RecruitingEvidenceReference(
                        source_type="people_portal",
                        source_id=resolved_run_id,
                        source_field=item.source_field,
                        label=f"Employment evidence: {item.employer}",
                    )
                    for item in employment_evidence
                ][:20],
                source_status=_text(raw.get("source_status") or raw.get("sourceStatus")) or source_status,
                source_refs=refs,
            )
        )
    # A person may appear once per application. Collapse duplicate email/login
    # rows before the recruiting run is built so one person cannot occupy two
    # ranking slots or contribute the same Gitea activity twice.
    deduped: list[RecruitingSourceCandidateDocument] = []
    by_email: dict[str, RecruitingSourceCandidateDocument] = {}
    by_login: dict[str, RecruitingSourceCandidateDocument] = {}
    for document in documents:
        email_key = str(document.email or "").strip().casefold()
        login_key = document.member_login.strip().casefold()
        email_match = by_email.get(email_key) if email_key else None
        login_match = by_login.get(login_key)
        if email_match is not None and login_match is not None and email_match is not login_match:
            raise ValueError("conflicting candidate identities; resolve email/login ownership before ingest")
        existing = email_match or login_match
        if existing is None:
            deduped.append(document)
            if email_key:
                by_email[email_key] = document
            by_login[login_key] = document
        else:
            if (
                existing.people_portal_member_pk is not None
                and document.people_portal_member_pk is not None
                and existing.people_portal_member_pk != document.people_portal_member_pk
            ):
                raise ValueError("conflicting People Portal member IDs for the same normalized email")
            if existing.email and document.email and existing.email.casefold() != document.email.casefold():
                raise ValueError("conflicting emails for the same candidate login; resolve identity before ingest")
            _merge_source_candidates(existing, document)
            by_login[login_key] = existing
            if email_key:
                by_email[email_key] = existing
    return resolved_run_id, deduped


def _attach_shared_ranking(
    documents: list[RecruitingSourceCandidateDocument],
    ranking: dict[str, Any] | None,
    *,
    source_run_id: str,
) -> dict[str, Any] | None:
    """Attach exact JSON scalar rows to normalized candidates by stable identity."""

    if not ranking:
        return None
    rows = ranking.get("rows")
    if not isinstance(rows, list):
        raise ValueError("ranking snapshot requires a rows array")
    by_person: dict[str, dict[str, Any]] = {}
    by_login: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("ranking snapshot rows must be objects")
        person_id = str(row.get("person_id") or "").strip().casefold()
        login = str(row.get("member_username") or "").strip().casefold()
        if not person_id and not login:
            continue
        if person_id and person_id in by_person and by_person[person_id] != row:
            raise ValueError(f"conflicting ranking rows for person_id {person_id}")
        if login and login in by_login and by_login[login] != row:
            raise ValueError(f"conflicting ranking rows for member_username {login}")
        if person_id:
            by_person[person_id] = row
        if login:
            by_login[login] = row

    for candidate in documents:
        row = by_person.get(str(candidate.person_id or "").strip().casefold())
        login_row = by_login.get(candidate.member_login.casefold())
        if row is not None and login_row is not None and row != login_row:
            raise ValueError(f"ranking identity conflict for {candidate.member_login}")
        row = row or login_row
        if row is None:
            continue
        try:
            candidate.ranking = RecruitingRankingSnapshot(
                artifact_schema=str(ranking.get("schema") or "horizon.shared-ranking.v1"),
                pipeline_run_id=str(ranking.get("pipeline_run_id") or source_run_id),
                artifact_sha256=str(ranking.get("artifact_sha256") or ""),
                export_manifest_sha256=str(ranking.get("export_manifest_sha256") or ""),
                result_sha256=str(ranking.get("result_sha256") or "") or None,
                ranking_status=str(row.get("ranking_status") or ranking.get("ranking_status") or "unknown"),
                rubric_version=str(ranking.get("rubric_version") or "unknown"),
                combined_rank=row.get("combined_rank"),
                builder_rank=row.get("builder_rank"),
                technical_leadership_rank=row.get("technical_leadership_rank"),
                technical_execution_score=row.get("technical_execution_score"),
                technical_leadership_score=row.get("technical_leadership_score"),
                club_contribution_score=row.get("club_contribution_score"),
                combined_score=row.get("combined_score"),
                evidence_completeness=row.get("evidence_completeness"),
                ranking_eligibility=row.get("eligibility"),
                exclusion_status=row.get("exclusion_status"),
                human_review_required=row.get("human_review_required") is not False,
                review_priority=row.get("review_priority"),
                gitea_data_quality_status=row.get("gitea_data_quality_status"),
                analytical_notes=row.get("analytical_notes"),
            )
        except (TypeError, ValueError) as exc:
            raise ValueError(f"invalid shared ranking row for {candidate.member_login}: {exc}") from exc
    return ranking


async def persist_people_portal_payload(
    database: Any,
    payload: dict[str, Any],
    *,
    source_run_id: str | None = None,
    ranking: dict[str, Any] | None = None,
) -> dict[str, Any]:
    resolved_run_id, documents = normalize_people_portal_payload(payload, source_run_id=source_run_id)
    ranking_hash = str((ranking or {}).get("artifact_sha256") or "").strip()
    if ranking_hash:
        resolved_run_id = f"{resolved_run_id[:74]}-ranking-{ranking_hash[:12]}"
        for document in documents:
            document.source_run_id = resolved_run_id
    _attach_shared_ranking(documents, ranking, source_run_id=resolved_run_id)
    digest = payload_digest({"payload": payload, "ranking": ranking})
    source_metadata = payload.get("source")
    if not isinstance(source_metadata, dict):
        source_metadata = {}
    source = RecruitingSourceRunDocument(
        source_run_id=resolved_run_id, generated_at=_timestamp(payload.get("generated_at")),
        payload_sha256=digest, candidate_count=len(documents),
        source_system=str(source_metadata.get("system") or "people_portal_payload"),
        source_warnings=[str(warning) for warning in source_metadata.get("warnings") or []][:50],
        member_analytics_run_id=source_metadata.get("gitea_run_id"),
        ranking_pipeline_run_id=(ranking or {}).get("pipeline_run_id"),
        ranking_artifact_sha256=ranking_hash or None,
        ranking_export_manifest_sha256=(ranking or {}).get("export_manifest_sha256"),
        ranking_result_sha256=(ranking or {}).get("result_sha256"),
        ranking_status=(ranking or {}).get("ranking_status"),
        ranking_rubric_version=(ranking or {}).get("rubric_version"),
    )
    async with database.transaction():
        existing = await database.find_one(RecruitingSourceRunDocument, source_run_id=resolved_run_id)
        if existing:
            if existing.payload_sha256 != digest:
                raise ValueError("source_run_id already exists with different content; use a new version")
        else:
            legacy = await database.recruiting_source_candidates(resolved_run_id)
            if legacy:
                raise ValueError("legacy source_run_id already exists; ingest under a new version")
            await database.add_many("recruiting_candidates", documents)
            await database.add("recruiting_sources", source)
    return {
        "source_run_id": resolved_run_id,
        "candidates": len(documents),
        "payload_sha256": digest,
        "source_system": source.source_system,
        "source_warnings": source.source_warnings,
        "ranking": {
            "pipeline_run_id": source.ranking_pipeline_run_id,
            "artifact_sha256": source.ranking_artifact_sha256,
            "status": source.ranking_status,
            "rubric_version": source.ranking_rubric_version,
        } if source.ranking_artifact_sha256 else None,
    }


def _member_stats(member: MemberMetricsDocument | None, fallback: RecruitingMemberStats) -> RecruitingMemberStats:
    if member is None:
        return fallback
    return RecruitingMemberStats(
        commits=member.commits,
        commits_default_reachable=member.commits_default_reachable,
        commits_branch_only=member.commits_branch_only,
        additions=member.additions,
        unique_files=member.unique_files,
        pulls_opened=member.pulls_opened,
        pulls_merged=member.pulls_merged,
        pulls_contributed_to=member.pulls_contributed_to,
        pulls_merged_contributed_to=member.pulls_merged_contributed_to,
        pull_commits_authored=member.pull_commits_authored,
        merged_pull_commits_authored=member.merged_pull_commits_authored,
        reviews_submitted=member.reviews_submitted,
        reviews_approved=member.reviews_approved,
        issues_opened=member.issues_opened,
        active_days=member.active_days,
        blame_lines=member.blame_lines,
        repositories=list(member.repositories),
        commit_stats_status=member.commit_stats_status,
        file_stats_status=member.file_stats_status,
    )


def _percentile(values: list[int], value: int) -> float:
    if not values:
        return 50.0
    if max(values) == min(values):
        return 50.0 if value == 0 else 75.0
    lower = sum(1 for other in values if other < value)
    equal = sum(1 for other in values if other == value)
    return round(100 * (lower + equal * 0.5) / len(values), 1)


def _contribution_score(stats: RecruitingMemberStats, cohort: list[RecruitingSourceCandidateDocument]) -> tuple[float | None, dict[str, float]]:
    dimensions = SCORING_POLICY["contribution_dimensions"]
    available_dimensions = {
        key: weight for key, weight in dimensions.items()
        if key == "repositories"
        and stats.commit_stats_status in {"complete", "not_applicable"}
        or key != "repositories" and getattr(stats, key) is not None
    }
    if not available_dimensions:
        return None, {}
    available_weight = sum(available_dimensions.values())
    values = {}
    for key in available_dimensions:
        if key == "repositories":
            values[key] = [len(item.member_stats.repositories) for item in cohort if item.member_stats.commit_stats_status in {"complete", "not_applicable"}]
        else:
            values[key] = [
                int(value) for item in cohort
                if (value := getattr(item.member_stats, key)) is not None
            ]
    breakdown = {
        key: round(
            _percentile(values[key], len(stats.repositories) if key == "repositories" else int(getattr(stats, key)))
            * weight / available_weight,
            1,
        )
        for key, weight in available_dimensions.items()
    }
    return round(sum(breakdown.values()), 1), breakdown


def _resume_score(candidate: RecruitingSourceCandidateDocument) -> float | None:
    if not candidate.evidence_reviewed_for_scoring or (not candidate.resume_evidence and not candidate.resume_summary):
        return None
    text = " ".join([candidate.resume_summary or "", *candidate.resume_evidence]).lower()
    impact_terms = ("built", "shipped", "launched", "improved", "reduced", "migrated", "scaled", "led", "owned", "mentored")
    impact_count = sum(1 for term in impact_terms if term in text)
    return round(min(100.0, 42.0 + min(3, len(candidate.resume_evidence)) * 12 + min(4, impact_count) * 5), 1)


def _interview_score(candidate: RecruitingSourceCandidateDocument) -> float | None:
    if candidate.interview_score is None and not candidate.interview_evidence:
        return None
    if candidate.interview_score is not None:
        return round(candidate.interview_score * 20, 1)
    return None


def _evidence_claims(result: dict[str, Any] | None, candidate: RecruitingSourceCandidateDocument) -> list[RecruitingEvidenceClaim]:
    """Accept only well-formed claims from the optional evidence organizer."""

    claims: list[RecruitingEvidenceClaim] = []
    fields = {
        "resume": " ".join([candidate.resume_summary or "", *candidate.resume_evidence]),
        "resumes": " ".join([candidate.resume_summary or "", *candidate.resume_evidence]),
        "interview": " ".join([candidate.interview_summary or "", *candidate.interview_evidence]),
        "applications": " ".join([candidate.interview_summary or "", *candidate.interview_evidence]),
    }
    raw_claims = (result or {}).get("evidence_claims", [])
    for raw in raw_claims if isinstance(raw_claims, list) else []:
        if not isinstance(raw, dict):
            continue
        try:
            claim = RecruitingEvidenceClaim.model_validate(raw)
            source = fields.get(claim.source_field)
            if source and claim.supporting_text.strip() in source:
                claims.append(claim)
        except (TypeError, ValueError):
            continue
    return claims[:30]


def _ability_score(resume: float | None, interview: float | None) -> float | None:
    parts: list[tuple[float, float]] = []
    dimensions = SCORING_POLICY["ability_dimensions"]
    if resume is not None:
        parts.append((resume, float(dimensions["resume_evidence"])))
    if interview is not None:
        parts.append((interview, float(dimensions["interview_evidence"])))
    if not parts:
        return None
    weight = sum(item[1] for item in parts)
    return round(sum(value * factor for value, factor in parts) / weight, 1)


def _combine_scores(contribution: float | None, ability: float | None) -> float | None:
    parts = [(value, SCORING_POLICY["combined_weights"][key])
             for key, value in (("club_contribution", contribution), ("engineering_ability", ability))
             if value is not None]
    if not parts:
        return None
    return round(sum(value * weight for value, weight in parts) / sum(weight for _, weight in parts), 1)


def _scale_shared_score(value: float | None) -> float | None:
    return round(value * 20, 1) if value is not None else None


def _shared_signal_for_candidate(
    candidate: RecruitingSourceCandidateDocument,
    *,
    gitea_run_id: str | None,
    llm_result: dict[str, Any] | None = None,
) -> RecruitingSignalDocument:
    """Project the exact shared 0–5 ranking into the legacy API shape.

    The 0–100 values are display compatibility only. Ordering and component
    values come from the versioned JSON/JSONL ranking artifact and are never
    recalculated here.
    """

    ranking = candidate.ranking
    assert ranking is not None
    current = ranking.ranking_status in {"current", "current_provisional"}
    combined = _scale_shared_score(ranking.combined_score) if current else None
    contribution = _scale_shared_score(ranking.club_contribution_score)
    execution = _scale_shared_score(ranking.technical_execution_score)
    leadership = _scale_shared_score(ranking.technical_leadership_score)
    technical_parts = [value for value in (execution, leadership) if value is not None]
    ability = round(sum(technical_parts) / len(technical_parts), 1) if technical_parts else None
    quality = round(
        35
        + (25 if candidate.member_stats.commits or candidate.member_stats.pulls_merged or candidate.member_stats.reviews_submitted else 0)
        + (20 if candidate.resume_evidence or candidate.resume_summary else 0)
        + (20 if candidate.interview_score is not None or candidate.interview_evidence else 0),
        1,
    )
    refs = list(candidate.source_refs)
    refs.append(RecruitingEvidenceReference(
        source_type="shared_ranking_pipeline",
        source_id=ranking.pipeline_run_id,
        source_field="llm-ranking-export/members.jsonl",
        label="Imported People Portal + Gitea ranking artifact",
    ))
    if gitea_run_id:
        refs.append(RecruitingEvidenceReference(
            source_type="gitea_member_analytics", source_id=gitea_run_id,
            source_field=f"members.{candidate.member_login}", label="Gitea organization contribution metrics",
        ))
    review_flags = list(candidate.eligibility_reasons[:10])
    if ranking.human_review_required:
        review_flags.append("Shared ranking is provisional and requires human evidence review.")
    if ranking.combined_rank is None or ranking.combined_score is None:
        review_flags.append("Candidate has no combined rank in the shared artifact and remains unranked.")
    if ranking.ranking_status not in {"current", "current_provisional"}:
        review_flags.append(f"Shared ranking status is {ranking.ranking_status}; rerun before using a rank.")
    caveats = [
        "This output is provisional; a reviewer must verify the evidence and ordering.",
        "The imported 0–5 component scores are shown as /100 for legacy display compatibility; they do not change the artifact ordering.",
    ]
    if candidate.member_stats.commit_stats_status not in {"complete", "not_applicable"}:
        caveats.append("Some Gitea line/file statistics are unavailable; the source pipeline does not treat them as zero.")
    if not candidate.evidence_reviewed_for_scoring:
        caveats.append("Unstructured resume/interview text requires human screening before scoring or model use.")
    strengths = [claim.claim for claim in _evidence_claims(llm_result, candidate)]
    if not strengths and (ranking.club_contribution_score is not None or execution is not None or leadership is not None):
        strengths.append("Has imported contribution and technical evidence in the shared ranking pipeline.")
    if ranking.analytical_notes:
        caveats.append(ranking.analytical_notes)
    band = RecruitingSignalBand.UNDERRATED if combined is not None else RecruitingSignalBand.NEEDS_REVIEW
    return RecruitingSignalDocument(
        id=new_id(),
        run_id="pending",
        member_login=candidate.member_login,
        member_name=candidate.member_name,
        source_candidate=candidate.model_copy(deep=True),
        provisional_rank=ranking.combined_rank if current else None,
        provisional_score=combined,
        signal_band=band,
        contribution_score=contribution,
        ability_score=ability,
        resume_score=None,
        interview_score=None,
        evidence_quality_score=quality,
        score_breakdown={
            "technical_execution": execution,
            "technical_leadership": leadership,
            "club_contribution": contribution,
            "shared_combined_score": combined,
        },
        evidence_claims=_evidence_claims(llm_result, candidate),
        review_flags=_merge_unique_strings(review_flags, candidate.eligibility_reasons, 15),
        rationale=(
            f"Imported the exact shared People Portal + Gitea ranking artifact using rubric "
            f"{ranking.rubric_version}. Combined score is "
            f"{'not available' if ranking.combined_score is None else f'{ranking.combined_score:.1f}/5'}; "
            "the existing rank is the shared artifact combined rank, not a separately calculated recruiting score. "
            "Protected traits, employer prestige, and school prestige are excluded from the ranking inputs."
        ),
        strengths=strengths[:10],
        caveats=caveats[:15],
        evidence_refs=refs[:100],
        eligibility_status=candidate.eligibility_status,
        eligibility_reasons=candidate.eligibility_reasons,
        eligibility_evidence=candidate.eligibility_evidence,
    )


def _signal_for_candidate(
    candidate: RecruitingSourceCandidateDocument,
    cohort: list[RecruitingSourceCandidateDocument],
    *,
    gitea_run_id: str | None,
    llm_result: dict[str, Any] | None = None,
) -> RecruitingSignalDocument:
    if candidate.ranking is not None:
        return _shared_signal_for_candidate(candidate, gitea_run_id=gitea_run_id, llm_result=llm_result)
    contribution, contribution_breakdown = _contribution_score(candidate.member_stats, cohort)
    resume = _resume_score(candidate)
    interview = _interview_score(candidate)
    ability = _ability_score(resume, interview)
    breakdown = dict(contribution_breakdown)
    breakdown["engineering_ability"] = ability
    combined = _combine_scores(contribution, ability)
    quality = round(
        35
        + (25 if candidate.member_stats.commits or candidate.member_stats.pulls_merged or candidate.member_stats.reviews_submitted else 0)
        + (20 if candidate.resume_evidence or candidate.resume_summary else 0)
        + (20 if candidate.interview_score is not None or candidate.interview_evidence else 0),
        1,
    )
    # The product has one signal category: every ranked candidate is an
    # underrated signal. Data completeness and human verification remain
    # separate fields so they do not become competing talent labels.
    band = RecruitingSignalBand.UNDERRATED if combined is not None else RecruitingSignalBand.NEEDS_REVIEW
    refs = list(candidate.source_refs)
    if gitea_run_id:
        for login in candidate.gitea_logins or ([candidate.member_login] if not candidate.canonical_stats else []):
            refs.append(RecruitingEvidenceReference(
                source_type="gitea_member_analytics", source_id=gitea_run_id,
                source_field=f"members.{login}", label="Gitea organization contribution metrics",
            ))
    refs = refs[:100]
    strengths = [claim.claim for claim in _evidence_claims(llm_result, candidate)]
    if not strengths:
        strengths = []
        if candidate.member_stats.pulls_merged or candidate.member_stats.reviews_submitted:
            strengths.append("Shows shipped work and collaboration signals in club repositories.")
        if candidate.resume_evidence:
            strengths.append("Resume includes concrete work or impact evidence.")
        if candidate.interview_score is not None and candidate.interview_score >= 4:
            strengths.append("Interview evidence is consistently positive.")
    caveats = []
    if resume is None:
        caveats.append("Resume evidence is unavailable for scoring or has not passed human screening.")
    if interview is None:
        caveats.append("Interview evidence is missing or not yet scored.")
    if candidate.member_stats.commit_stats_status not in {"complete", "not_applicable"}:
        caveats.append("Some Gitea line/file statistics are unavailable; the score does not treat them as zero.")
    if candidate.eligibility_status != RecruitingEligibilityStatus.ELIGIBLE:
        caveats.extend(candidate.eligibility_reasons[:2])
    caveats.append("This output is provisional; a reviewer must verify the evidence and ordering.")
    if not candidate.evidence_reviewed_for_scoring:
        caveats.append("Unstructured resume/interview text requires human screening before scoring or model use.")
    contradictions = []
    duplicate_flags = []
    review_flags = []
    if candidate.source_status != "complete":
        review_flags.append("People Portal evidence is incomplete or unavailable.")
    review_flags = _merge_unique_strings(review_flags, candidate.eligibility_reasons, 15)
    rationale = None  # Numeric rationale is generated from the actual scoring inputs.
    if not rationale:
        rationale = (
            f"The provisional signal combines normalized club contribution ({'not available' if contribution is None else f'{contribution:.0f}/100'})"
            f" with resume evidence ({'not available' if resume is None else f'{resume:.0f}/100'})"
            f" and interview evidence ({'not available' if interview is None else f'{interview:.0f}/100'})."
            " Employer and school names were excluded from this calculation."
        )
    return RecruitingSignalDocument(
        id=new_id(),
        run_id="pending",
        member_login=candidate.member_login,
        member_name=candidate.member_name,
        source_candidate=candidate.model_copy(deep=True),
        provisional_rank=1 if combined is not None else None,
        provisional_score=combined,
        signal_band=band,
        contribution_score=contribution,
        ability_score=ability,
        resume_score=resume,
        interview_score=interview,
        evidence_quality_score=quality,
        score_breakdown=breakdown,
        evidence_claims=_evidence_claims(llm_result, candidate),
        contradictions=contradictions,
        duplicate_flags=duplicate_flags,
        review_flags=review_flags,
        rationale=rationale,
        strengths=strengths[:10],
        caveats=caveats[:15],
        evidence_refs=refs,
        eligibility_status=candidate.eligibility_status,
        eligibility_reasons=candidate.eligibility_reasons,
        eligibility_evidence=candidate.eligibility_evidence,
    )


class RecruitingSignalJudge:
    """Optional structured LLM evidence organizer.

    The model extracts source-backed claims and caveats only. Numeric signal
    components remain deterministic and the model cannot change the ordering.
    """

    def __init__(self, llm: StructuredLLM, *, model: str, max_tokens: int = 700) -> None:
        self._llm = llm
        self._model = model
        self._max_tokens = max_tokens

    async def judge(self, candidate: RecruitingSourceCandidateDocument) -> dict[str, Any]:
        allowed_refs = ", ".join(ref.source_field for ref in candidate.source_refs)
        user = (
            "CANDIDATE: anonymized evidence record\n"
            f"CLUB CONTRIBUTION METRICS: {candidate.member_stats.model_dump(mode='json')}\n"
            f"INTERVIEW EVIDENCE: {candidate.interview_summary or ''} | {candidate.interview_evidence}\n"
            f"RESUME IMPACT EVIDENCE: {candidate.resume_summary or ''} | {candidate.resume_evidence}\n"
            f"ALLOWED PEOPLE PORTAL SOURCE FIELDS: {allowed_refs}\n"
            "Return source-backed evidence claims and caveats, not scores or a hiring decision."
        )
        return await self._llm.call_tool(
            system=(
                "You are an evidence extraction assistant for a student club recruiting review. "
                "Extract only source-backed claims from the supplied club, resume, and interview fields. "
                "Ignore employer names, school names, prestige, demographic or protected traits, and writing style. "
                "Identify only directly observable contradictions, duplicate evidence, or incomplete-source flags. "
                "Do not infer missing information, assign scores, rank people, or recommend hire/reject. "
                "Every claim must be grounded in the supplied fields and include the exact source field and supporting text."
            ),
            user=user,
            tool={
                "name": "emit_recruiting_evidence_signal",
                "description": "Return grounded evidence claims for human review.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "evidence_claims": {
                            "type": "array",
                            "maxItems": 10,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "source_field": {"type": "string", "maxLength": 240},
                                    "claim": {"type": "string", "maxLength": 500},
                                    "supporting_text": {"type": "string", "maxLength": 800},
                                },
                                "required": ["source_field", "claim", "supporting_text"],
                            },
                        },
                        "rationale": {"type": "string", "maxLength": 800},
                        "strengths": {"type": "array", "maxItems": 5, "items": {"type": "string", "maxLength": 200}},
                        "caveats": {"type": "array", "maxItems": 6, "items": {"type": "string", "maxLength": 200}},
                        "contradictions": {"type": "array", "maxItems": 5, "items": {"type": "string", "maxLength": 240}},
                        "duplicate_flags": {"type": "array", "maxItems": 5, "items": {"type": "string", "maxLength": 240}},
                        "review_flags": {"type": "array", "maxItems": 8, "items": {"type": "string", "maxLength": 240}},
                    },
                    "required": ["evidence_claims", "rationale", "strengths", "caveats", "contradictions", "duplicate_flags", "review_flags"],
                },
            },
            model=self._model,
            max_tokens=self._max_tokens,
        )


async def run_recruiting_pipeline(
    database: Any,
    *,
    settings: Settings,
    judge: RecruitingSignalJudge | None = None,
    run_id: str | None = None,
    source_run_id: str | None = None,
    member_analytics_run_id: str | None = None,
) -> RecruitingRunDocument | None:
    """Create one provisional run from the newest available source snapshots.

    Gitea member analytics is sufficient to create a stats-only signal. People
    Portal evidence is optional enrichment and is never replaced with a
    fabricated placeholder when it has not been ingested.
    """

    sources = await database.list("recruiting_sources")
    source = (next((row for row in sources if row.source_run_id == source_run_id), None)
              if source_run_id else max(sources, key=lambda row: (row.generated_at, row.ingested_at, row.source_run_id), default=None))
    if source_run_id and source is None:
        raise ValueError("requested recruiting source run not found")
    source_candidates = await database.recruiting_source_candidates(source.source_run_id) if source else []
    shared_ranking_mode = bool(source and source.ranking_artifact_sha256)
    # Legacy snapshots remain readable; select exactly one source, never a
    # timestamp union of unrelated exports.
    if not source and not source_run_id:
        legacy = await database.list("recruiting_candidates")
        latest = max(legacy, key=lambda row: (row.source_generated_at, row.source_run_id), default=None)
        source_candidates = [row for row in legacy if latest and row.source_run_id == latest.source_run_id]
    selected_analytics = member_analytics_run_id or (source.member_analytics_run_id if source else None)
    analytics_run = (await database.member_analytics_run(selected_analytics)
                     if selected_analytics else await database.latest_member_analytics_run())
    if selected_analytics and not analytics_run:
        raise ValueError("requested member analytics run not found; ingest it first")
    analytics_members = await database.member_metrics_for_run(analytics_run.run_id) if analytics_run else []
    analytics_by_login = {row.login.casefold(): row for row in analytics_members
                          if row.roster_member and not row.service_or_admin and row.active_account}
    emails = defaultdict(list)
    for member in analytics_by_login.values():
        if (email := _normalized_email(member.email)):
            emails[email].append(member)
    candidates = []
    matched = set()
    source_warnings = list(analytics_run.warnings[:15]) if analytics_run else []
    if source:
        source_warnings.extend(source.source_warnings[:15])
    for original in source_candidates:
        candidate = original.model_copy(deep=True)
        if candidate.canonical_stats:
            # The profile builder already resolved exact identity and coverage.
            # Never overwrite its combined canonical metrics with a raw row.
            matched.update(login.casefold() for login in candidate.gitea_logins)
        else:
            login_match = analytics_by_login.get(candidate.member_login.casefold())
            email_matches = emails.get(_normalized_email(candidate.email) or "", [])
            possibilities = {row.login: row for row in [*email_matches, *([login_match] if login_match else [])]}
            if len(possibilities) == 1:
                member = next(iter(possibilities.values()))
                if candidate.email and member.email and _normalized_email(candidate.email) != _normalized_email(member.email):
                    source_warnings.append("Conflicting identity evidence retained for human review.")
                    candidate.member_stats = RecruitingMemberStats()
                else:
                    candidate.member_stats = _member_stats(member, candidate.member_stats)
                    matched.add(member.login.casefold())
                    candidate.gitea_logins = [member.login]
            elif len(possibilities) > 1:
                candidate.member_stats = RecruitingMemberStats()
                source_warnings.append("Ambiguous identity evidence retained for human review.")
        # Automated policy observations never decide outreach eligibility.
        candidate.eligibility_status = RecruitingEligibilityStatus.NEEDS_REVIEW
        candidates.append(candidate)
    # A profile source defines the active organization roster, including empty
    # evidence rows. Raw Gitea accounts must not expand it with nonmembers.
    if not source_candidates and source is None:
        for login, member in sorted(analytics_by_login.items()):
            if login in matched:
                continue
            candidates.append(RecruitingSourceCandidateDocument(
                person_id=_normalized_email(member.email) or login,
                source_run_id="people-portal-not-ingested", source_generated_at=analytics_run.generated_at,
                member_login=login, member_name=member.name or login, email=member.email, gitea_logins=[member.login],
                member_stats=_member_stats(member, RecruitingMemberStats()), source_status="missing",
            ))
    if not candidates and not source and not analytics_run:
        return None
    if not source_candidates:
        source_warnings.append("People Portal evidence is unavailable; missing evidence is not zero ability.")
    if shared_ranking_mode:
        source_warnings.append(
            f"Using exact shared ranking artifact {source.ranking_pipeline_run_id or 'unknown'} "
            f"({source.ranking_rubric_version or 'unknown rubric'}); unranked rows remain unranked."
        )
    candidates.sort(key=lambda candidate: candidate.member_login.casefold())
    run_policy: dict[str, Any] = (
        {**SCORING_POLICY, "people_portal_source_system": source.source_system}
        if source else SCORING_POLICY
    )
    if shared_ranking_mode:
        run_policy = {
            **SCORING_POLICY,
            "ranking_source": "shared People Portal + Gitea JSON/JSONL ranking artifact",
            "ranking_status": source.ranking_status,
            "ranking_pipeline_run_id": source.ranking_pipeline_run_id,
            "ranking_artifact_sha256": source.ranking_artifact_sha256,
            "ranking_export_manifest_sha256": source.ranking_export_manifest_sha256,
            "ranking_result_sha256": source.ranking_result_sha256,
            "rubric_version": source.ranking_rubric_version,
            "score_scale": "source scores are 0-5; legacy API display multiplies by 20",
            "combined_weights": {
                "technical_execution": 0.35,
                "technical_leadership": 0.35,
                "club_contribution": 0.30,
            },
            "ability_dimensions": {
                "technical_execution": 0.50,
                "technical_leadership": 0.50,
            },
        }
    fingerprint = payload_digest({
        "version": "recruiting-v5-shared-ranking-artifact" if shared_ranking_mode else RECRUITING_VERSION,
        "policy": run_policy,
        "analytics_run": analytics_run.run_id if analytics_run else None,
        "source_run": source.source_run_id if source else None,
        "candidates": [row.model_dump(mode="json", exclude={"id"}) for row in candidates],
        "model": settings.recruiting_model if judge else None,
    })
    resolved_run_id = run_id or f"recruiting-{fingerprint[:32]}"
    existing = await database.recruiting_run(resolved_run_id)
    if existing:
        if existing.input_fingerprint != fingerprint:
            raise ValueError("recruiting run_id already exists with different inputs")
        return existing
    provisional_signals = []
    llm_used = False
    for candidate in candidates:
        llm_result = None
        if not shared_ranking_mode and judge is not None and candidate.evidence_reviewed_for_scoring:
            try:
                llm_result = await judge.judge(candidate)
                if not isinstance(llm_result, dict):
                    raise ValueError("invalid evidence response")
                llm_used = True
            except Exception as exc:  # fail open to deterministic rubric, never to a fabricated empty row
                source_warnings.append(f"LLM evidence scoring unavailable for {candidate.member_login}: {type(exc).__name__}")
        signal = _signal_for_candidate(candidate, candidates, gitea_run_id=analytics_run.run_id if analytics_run else None, llm_result=llm_result)
        signal.run_id = resolved_run_id
        provisional_signals.append(signal)

    if shared_ranking_mode:
        provisional_signals.sort(key=lambda signal: (
            signal.provisional_rank is None,
            signal.provisional_rank if signal.provisional_rank is not None else 10**9,
            signal.member_login.casefold(),
        ))
    else:
        provisional_signals.sort(key=lambda signal: (-(signal.provisional_score if signal.provisional_score is not None else -1), -(signal.contribution_score if signal.contribution_score is not None else -1), signal.member_login.lower()))
        for rank, signal in enumerate(provisional_signals, start=1):
            signal.provisional_rank = rank if signal.provisional_score is not None else None
    run = RecruitingRunDocument(
        id=new_id(),
        run_id=resolved_run_id,
        generated_at=utc_now(),
        model=("shared-ranking-artifact" if shared_ranking_mode else settings.recruiting_model if llm_used else "deterministic-rubric-v1"),
        signal_version="recruiting-v5-shared-ranking-artifact" if shared_ranking_mode else RECRUITING_VERSION,
        input_fingerprint=fingerprint,
        member_analytics_run_id=analytics_run.run_id if analytics_run else None,
        people_portal_source_run_id=source.source_run_id if source else source_candidates[0].source_run_id if source_candidates else None,
        candidate_count=len(provisional_signals),
        reviewed_count=0,
        llm_used=llm_used,
        source_warnings=source_warnings[:30],
        scoring_policy=run_policy,
        excluded_candidates=[],
        needs_review_count=sum(
            1 for candidate in candidates
            if candidate.eligibility_status == RecruitingEligibilityStatus.NEEDS_REVIEW
        ),
    )
    async with database.transaction():
        existing = await database.recruiting_run(resolved_run_id)
        if existing:
            return existing
        await database.add_many("recruiting_signals", provisional_signals)
        await database.add("recruiting_runs", run)
        await database.add("audit_log", AuditLogDocument.model_construct(
            actor_user_id="recruiting-pipeline", action="recruiting.run.created",
            target_type="recruiting_run", target_id=run.run_id,
            after={"input_fingerprint": fingerprint, "candidate_count": len(candidates)},
        ))
    return run
