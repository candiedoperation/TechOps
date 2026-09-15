"""Deterministic CI/RAG project-health agent.

The default path is intentionally local and explainable: specs are normalized into
stable chunks, evidence is aggregate-only, retrieval is token overlap, and the
assessment is a pure function. An optional summarizer can decorate a result but
is never required to produce one.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

import yaml
from pydantic import Field, field_validator, model_validator

from .errors import PrivacyViolationError
from .models import PHIDocument, PrivacySafeModel, utc_now

# Detects structured identity markers in free-form text (handles, emails, git trailers).
# Used to reject individual identity data before it enters a prompt or is persisted.
_IDENTITY_PATTERN = re.compile(
    r"(?:^|\s)@[A-Za-z0-9][A-Za-z0-9_-]{1,38}"  # @handles
    r"|[\w.+-]+@[\w-]+\.[\w.]{2,}"               # email addresses
    r"|\bCo-authored-by\b|\bSigned-off-by\b",    # git commit trailers
    re.I | re.MULTILINE,
)


class SpecFormat(StrEnum):
    YAML = "yaml"
    MARKDOWN = "markdown"


class AssessmentStatus(StrEnum):
    CLEAR = "clear"
    WATCH = "watch"
    AT_RISK = "at_risk"
    INSUFFICIENT_DATA = "insufficient_data"
    PLANNED_PAUSE = "planned_pause"


MIN_SIGNAL_WEEK = 2
PROGRESS_WATCH_DAYS = 7
PROGRESS_RISK_DAYS = 14


class SpecChunk(PrivacySafeModel):
    chunk_id: str = Field(min_length=8, max_length=160)
    project_id: str = Field(min_length=1, max_length=80)
    week_start: int = Field(ge=1, le=52)
    week_end: int = Field(ge=1, le=52)
    kind: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=240)
    content: str = Field(min_length=1, max_length=4_000)
    acceptance_criteria: list[str] = Field(default_factory=list, max_length=100)
    required_artifacts: list[str] = Field(default_factory=list, max_length=100)
    milestone: str | None = Field(default=None, max_length=240)


class ProjectSpec(PrivacySafeModel):
    project_id: str = Field(min_length=1, max_length=80)
    version: str = Field(default="spec-v1", min_length=1, max_length=120)
    lifecycle_weeks: int = Field(default=12, ge=1, le=52)
    chunks: list[SpecChunk] = Field(min_length=1, max_length=1_000)


class CheckResult(PrivacySafeModel):
    name: str = Field(min_length=1, max_length=120)
    status: str = Field(min_length=1, max_length=40)
    detail: str | None = Field(default=None, max_length=500)


class CIEvidence(PrivacySafeModel):
    project_id: str = Field(min_length=1, max_length=80)
    commit_sha: str = Field(min_length=1, max_length=160)
    branch: str | None = Field(default=None, max_length=240)
    pull_request_number: int | None = Field(default=None, ge=1)
    changed_files: list[str] = Field(default_factory=list, max_length=2_000)
    tests_total: int | None = Field(default=None, ge=0)
    tests_passed: int | None = Field(default=None, ge=0)
    tests_failed: int | None = Field(default=None, ge=0)
    coverage_pct: float | None = Field(default=None, ge=0, le=100)
    check_results: list[CheckResult] = Field(default_factory=list, max_length=100)
    deploy_status: str | None = Field(default=None, max_length=40)
    milestone_refs: list[str] = Field(default_factory=list, max_length=100)
    acceptance_criteria_refs: list[str] = Field(default_factory=list, max_length=200)
    artifact_refs: list[str] = Field(default_factory=list, max_length=200)
    docs_updated: bool | None = None
    scope_change_count: int = Field(default=0, ge=0)
    expected_week: int = Field(default=MIN_SIGNAL_WEEK, ge=1, le=52)
    last_progress_at: datetime | None = None
    progress_age_days: float | None = Field(default=None, ge=0, le=3_650)
    milestone_due_week: int | None = Field(default=None, ge=1, le=52)
    observed_at: datetime = Field(default_factory=utc_now)
    planned_pause: bool = False
    progress_summary: str | None = Field(
        default=None,
        max_length=4_000,
        description=(
            "Free-form weekly progress update from the project lead. "
            "Must not contain individual identities (@handle, email, git trailer)."
        ),
    )

    @field_validator("progress_summary")
    @classmethod
    def reject_identities_in_narrative(cls, value: str | None) -> str | None:
        if value and _IDENTITY_PATTERN.search(value):
            raise PrivacyViolationError(
                "progress_summary must not contain individual identities "
                "(@handle, email address, or co-author git trailer)"
            )
        return value

    @model_validator(mode="after")
    def validate_test_counts(self) -> "CIEvidence":
        if self.tests_passed is not None and self.tests_failed is not None and self.tests_total is not None:
            if self.tests_passed + self.tests_failed > self.tests_total:
                raise ValueError("tests_passed plus tests_failed cannot exceed tests_total")
        return self


class Citation(PrivacySafeModel):
    citation_id: str = Field(min_length=1, max_length=160)
    source_type: str = Field(min_length=1, max_length=40)
    source_id: str = Field(min_length=1, max_length=240)
    source_field: str = Field(min_length=1, max_length=120)
    excerpt: str = Field(min_length=1, max_length=500)
    observed_at: datetime | None = None


class ProjectAssessment(PrivacySafeModel):
    assessment_id: str = Field(min_length=8, max_length=160)
    project_id: str = Field(min_length=1, max_length=80)
    spec_version: str = Field(min_length=1, max_length=120)
    commit_sha: str = Field(min_length=1, max_length=160)
    expected_week: int = Field(ge=1, le=52)
    status: AssessmentStatus
    score: int = Field(ge=0, le=100)
    confidence: float = Field(ge=0, le=1)
    summary: str = Field(min_length=1, max_length=1_000)
    blockers: list[str] = Field(default_factory=list, max_length=100)
    recommendations: list[str] = Field(default_factory=list, max_length=100)
    weekly_tasks: list[str] = Field(default_factory=list, max_length=100)
    evidence_citations: list[Citation] = Field(default_factory=list, max_length=200)
    spec_citations: list[Citation] = Field(default_factory=list, max_length=200)
    created_at: datetime = Field(default_factory=utc_now)


class AssessmentDocument(PHIDocument):
    """Append-only CI assessment record; no contributor data is stored."""

    assessment_id: str
    project_id: str
    spec_version: str
    commit_sha: str
    expected_week: int
    status: AssessmentStatus
    score: int
    confidence: float
    summary: str
    blockers: list[str] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    weekly_tasks: list[str] = Field(default_factory=list)
    evidence_citations: list[dict[str, Any]] = Field(default_factory=list)
    spec_citations: list[dict[str, Any]] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utc_now)

    class Settings:
        name = "ci_assessments"


class Summarizer(Protocol):
    def summarize(self, text: str) -> str: ...


def _stable_id(project_id: str, week_start: int, kind: str, title: str, content: str) -> str:
    raw = f"{project_id}|{week_start}|{kind}|{title}|{content}".encode()
    return "spec-" + hashlib.sha256(raw).hexdigest()[:24]


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if not isinstance(value, (list, tuple, set)):
        raise ValueError("spec list fields must be strings or lists of strings")
    return [str(item).strip() for item in value if str(item).strip()]


def _normalize_yaml(payload: dict[str, Any], project_id: str | None) -> ProjectSpec:
    payload_project = str(payload.get("project_id", "")).strip()
    if project_id and payload_project and payload_project != project_id:
        raise ValueError("spec project_id does not match the requested project")
    resolved_project = project_id or payload_project
    if not resolved_project:
        raise ValueError("project_id is required in the payload or spec")
    chunks: list[SpecChunk] = []
    weeks = payload.get("weeks", payload.get("phases", []))
    if not isinstance(weeks, list):
        raise ValueError("spec weeks/phases must be a list")
    for item in weeks:
        if not isinstance(item, dict):
            raise ValueError("each week/phase must be an object")
        try:
            week_start = int(item.get("week_start", item.get("week", item.get("start", 1))))
            week_end = int(item.get("week_end", item.get("end", week_start)))
        except (TypeError, ValueError) as exc:
            raise ValueError("week numbers must be integers") from exc
        title = str(item.get("title", item.get("milestone", f"Week {week_start}")))
        criteria = _as_list(item.get("acceptance_criteria", item.get("acceptance")))
        artifacts = _as_list(item.get("required_artifacts", item.get("artifacts")))
        tasks = _as_list(item.get("tasks", item.get("deliverables")))
        milestone = str(item["milestone"]) if item.get("milestone") else None
        for kind, values in (("milestone", [milestone] if milestone else []), ("task", tasks), ("acceptance", criteria), ("artifact", artifacts)):
            for value in values:
                content = str(value)
                chunks.append(SpecChunk(
                    chunk_id=_stable_id(resolved_project, week_start, kind, title, content),
                    project_id=resolved_project, week_start=week_start, week_end=week_end,
                    kind=kind, title=title, content=content, acceptance_criteria=criteria,
                    required_artifacts=artifacts, milestone=milestone,
                ))
    if not chunks:
        raise ValueError("spec must contain at least one week with tasks, criteria, artifacts, or milestone")
    try:
        lifecycle_weeks = int(payload.get("lifecycle_weeks", 12))
    except (TypeError, ValueError) as exc:
        raise ValueError("lifecycle_weeks must be an integer") from exc
    return ProjectSpec(project_id=resolved_project, version=str(payload.get("version", "spec-v1")), lifecycle_weeks=lifecycle_weeks, chunks=chunks)


def _normalize_markdown(text: str, project_id: str, version: str = "spec-v1") -> ProjectSpec:
    chunks: list[SpecChunk] = []
    current_week = 1
    current_title = "Project plan"
    current: list[str] = []
    def flush() -> None:
        nonlocal current
        for line in current:
            content = re.sub(r"^[-*+]\s+", "", line).strip()
            if not content:
                continue
            lower = content.lower()
            kind = "acceptance" if "accept" in lower or lower.startswith("ac:") else "artifact" if "artifact" in lower else "task"
            chunks.append(SpecChunk(chunk_id=_stable_id(project_id, current_week, kind, current_title, content), project_id=project_id, week_start=current_week, week_end=current_week, kind=kind, title=current_title, content=content))
        current = []
    for raw in text.splitlines():
        heading = re.match(r"^#{1,6}\s*(?:week\s*)?(\d+)(?:\s*[-:]\s*(.*))?$", raw.strip(), re.I)
        if heading:
            flush()
            current_week = int(heading.group(1))
            current_title = heading.group(2) or f"Week {current_week}"
        elif raw.strip() and not raw.lstrip().startswith("#"):
            current.append(raw.strip())
    flush()
    if not chunks:
        raise ValueError("markdown spec must contain week headings and bullet/content lines")
    return ProjectSpec(project_id=project_id, version=version, lifecycle_weeks=12, chunks=chunks)


def normalize_spec(source: str | Path | dict[str, Any], project_id: str | None = None, source_format: SpecFormat | str | None = None) -> ProjectSpec:
    if isinstance(source, dict):
        return _normalize_yaml(source, project_id)
    path = Path(source) if isinstance(source, Path) else None
    text = path.read_text(encoding="utf-8") if path else str(source)
    fmt = str(source_format or ("markdown" if path and path.suffix.lower() in {".md", ".markdown"} else "yaml")).lower()
    if fmt in {"md", "markdown"}:
        return _normalize_markdown(text, project_id or (path.stem if path else "project"))
    try:
        payload = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ValueError("YAML spec could not be parsed") from exc
    if not isinstance(payload, dict):
        raise ValueError("YAML spec must be an object")
    return _normalize_yaml(payload, project_id)


def retrieve_chunks(spec: ProjectSpec, query: str, *, week: int | None = None, limit: int = 8) -> list[SpecChunk]:
    terms = {term for term in re.findall(r"[a-z0-9]+", query.lower()) if len(term) > 1}
    candidates = [chunk for chunk in spec.chunks if week is None or chunk.week_start <= week <= chunk.week_end]
    scored = []
    for chunk in candidates:
        haystack = f"{chunk.title} {chunk.content} {' '.join(chunk.acceptance_criteria)} {' '.join(chunk.required_artifacts)}".lower()
        score = sum(1 for term in terms if term in haystack)
        scored.append((score, chunk))
    scored.sort(key=lambda item: (-item[0], item[1].chunk_id))
    return [chunk for score, chunk in scored if score > 0][:limit] or [chunk for _, chunk in scored[:limit]]


def _citation(source_type: str, source_id: str, source_field: str, excerpt: str, observed_at: datetime | None = None) -> Citation:
    reference = f"{source_type}:{source_id}:{source_field}"
    citation_id = reference if len(reference) <= 160 else f"{source_type}:{hashlib.sha256(reference.encode()).hexdigest()}"
    return Citation(citation_id=citation_id, source_type=source_type, source_id=source_id, source_field=source_field, excerpt=excerpt[:500], observed_at=observed_at)


def _progress_age_days(evidence: CIEvidence) -> float | None:
    if evidence.progress_age_days is not None:
        return evidence.progress_age_days
    if evidence.last_progress_at is None:
        return None
    observed_at = evidence.observed_at
    last_progress_at = evidence.last_progress_at
    if observed_at.tzinfo is None:
        observed_at = observed_at.replace(tzinfo=timezone.utc)
    if last_progress_at.tzinfo is None:
        last_progress_at = last_progress_at.replace(tzinfo=timezone.utc)
    return max(0.0, (observed_at - last_progress_at).total_seconds() / 86_400)


def expected_chunks(spec: ProjectSpec, evidence: CIEvidence) -> list[SpecChunk]:
    """Return the spec chunks relevant to the evidence week, using token-overlap retrieval.

    Extracted from ``assess_project`` so the LLM enrichment layer can operate on
    the identical chunk set without duplicating the retrieval logic.
    """
    week = evidence.expected_week
    retrieval_query = " ".join([
        *evidence.changed_files,
        *evidence.milestone_refs,
        *evidence.acceptance_criteria_refs,
        *evidence.artifact_refs,
    ]) or f"week {week} milestone tasks acceptance artifacts"
    retrieved = retrieve_chunks(spec, retrieval_query, week=week, limit=24)
    return retrieved or [chunk for chunk in spec.chunks if chunk.week_start <= week <= chunk.week_end]


def assess_project(spec: ProjectSpec, evidence: CIEvidence, summarizer: Summarizer | None = None) -> ProjectAssessment:
    if evidence.project_id != spec.project_id:
        raise ValueError("spec and evidence project_id must match")
    week = evidence.expected_week
    expected = expected_chunks(spec, evidence)
    if evidence.planned_pause:
        return ProjectAssessment(assessment_id=f"assessment-{evidence.commit_sha[:32]}", project_id=spec.project_id, spec_version=spec.version, commit_sha=evidence.commit_sha, expected_week=week, status=AssessmentStatus.PLANNED_PAUSE, score=100, confidence=.9, summary="Project is marked as a planned pause; delivery signals are suppressed.", weekly_tasks=[], created_at=evidence.observed_at)
    if week < MIN_SIGNAL_WEEK:
        return ProjectAssessment(
            assessment_id=f"assessment-{evidence.commit_sha[:32]}",
            project_id=spec.project_id,
            spec_version=spec.version,
            commit_sha=evidence.commit_sha,
            expected_week=week,
            status=AssessmentStatus.INSUFFICIENT_DATA,
            score=0,
            confidence=.25,
            summary=f"Project health signals begin in week {MIN_SIGNAL_WEEK}; week {week} is too early to assess.",
            blockers=[f"Wait until week {MIN_SIGNAL_WEEK} before evaluating delivery health."],
            recommendations=["Keep the CI evidence contract ready for the first vertical slice."],
            weekly_tasks=[chunk.content for chunk in expected if chunk.kind == "task"],
            evidence_citations=[_citation("ci", evidence.commit_sha, "expected_week", str(week), evidence.observed_at)],
            spec_citations=[_citation("spec", chunk.chunk_id, chunk.kind, chunk.content) for chunk in expected[:4]],
            created_at=evidence.observed_at,
        )
    if not expected or not evidence.changed_files and evidence.tests_total is None and not evidence.check_results and not evidence.milestone_refs:
        return ProjectAssessment(assessment_id=f"assessment-{evidence.commit_sha[:32]}", project_id=spec.project_id, spec_version=spec.version, commit_sha=evidence.commit_sha, expected_week=week, status=AssessmentStatus.INSUFFICIENT_DATA, score=0, confidence=.25, summary="There is not enough CI evidence to assess project health.", blockers=["Submit CI test/check evidence and changed files."], recommendations=["Keep the CI evidence contract enabled on pull requests and pushes."], weekly_tasks=[chunk.content for chunk in expected if chunk.kind == "task"], evidence_citations=[_citation("ci", evidence.commit_sha, "commit_sha", "Commit was received.", evidence.observed_at)], spec_citations=[_citation("spec", chunk.chunk_id, "content", chunk.content) for chunk in expected[:4]], created_at=evidence.observed_at)
    blockers: list[str] = []
    recommendations: list[str] = []
    evidence_citations: list[Citation] = []
    spec_citations: list[Citation] = [_citation("spec", chunk.chunk_id, chunk.kind, chunk.content) for chunk in expected]
    score = 100
    progress_age_days = _progress_age_days(evidence)
    if progress_age_days is not None and progress_age_days >= PROGRESS_RISK_DAYS:
        score -= 30
        blockers.append(f"No project progress has been observed for {progress_age_days:.1f} days.")
        recommendations.append("Record a current aggregate progress update before the next milestone review.")
        evidence_citations.append(_citation("ci", evidence.commit_sha, "progress_age_days", f"Progress is {progress_age_days:.1f} days old.", evidence.observed_at))
    elif progress_age_days is not None and progress_age_days >= PROGRESS_WATCH_DAYS:
        score -= 15
        blockers.append(f"Project progress is becoming stale at {progress_age_days:.1f} days old.")
        recommendations.append("Refresh aggregate progress evidence before the next milestone review.")
        evidence_citations.append(_citation("ci", evidence.commit_sha, "progress_age_days", f"Progress is {progress_age_days:.1f} days old.", evidence.observed_at))
    if evidence.milestone_due_week is not None and not evidence.milestone_refs:
        if week > evidence.milestone_due_week:
            score -= 25
            blockers.append(f"The week {evidence.milestone_due_week} milestone has no completion evidence.")
            recommendations.append("Link the completed milestone to an aggregate CI check or artifact.")
        elif week == evidence.milestone_due_week:
            score -= 10
            recommendations.append("Record milestone evidence before the current week closes.")
        if week >= evidence.milestone_due_week:
            evidence_citations.append(_citation("ci", evidence.commit_sha, "milestone_due_week", f"Milestone due in week {evidence.milestone_due_week}; no milestone reference was supplied.", evidence.observed_at))
    if evidence.tests_failed and evidence.tests_failed > 0:
        score -= 30; blockers.append(f"{evidence.tests_failed} CI test(s) failed."); recommendations.append("Fix failing tests before expanding scope."); evidence_citations.append(_citation("ci", evidence.commit_sha, "tests_failed", str(evidence.tests_failed), evidence.observed_at))
    if evidence.tests_total is None:
        score -= 10; blockers.append("Test result totals are missing."); recommendations.append("Publish total, passed, and failed test counts from CI."); evidence_citations.append(_citation("ci", evidence.commit_sha, "tests_total", "No test total was supplied.", evidence.observed_at))
    if evidence.coverage_pct is not None and evidence.coverage_pct < 60:
        score -= 20; blockers.append(f"Coverage is {evidence.coverage_pct:.1f}%, below the 60% early-signal floor."); recommendations.append("Add tests around the current milestone acceptance criteria."); evidence_citations.append(_citation("ci", evidence.commit_sha, "coverage_pct", f"Coverage {evidence.coverage_pct:.1f}%", evidence.observed_at))
    if evidence.deploy_status and evidence.deploy_status.lower() in {"failed", "blocked", "error"}:
        score -= 25; blockers.append("Deployment or environment checks are failing."); recommendations.append("Restore deploy/check health before calling the milestone ready."); evidence_citations.append(_citation("ci", evidence.commit_sha, "deploy_status", evidence.deploy_status, evidence.observed_at))
    failed_checks = [check for check in evidence.check_results if check.status.lower() not in {"pass", "passed", "success", "ok"}]
    if failed_checks:
        score -= 20; blockers.append("One or more required CI checks are not passing."); recommendations.append("Resolve failed CI checks and rerun the assessment."); evidence_citations.extend(_citation("ci", evidence.commit_sha, "check_results", f"{check.name}: {check.status}", evidence.observed_at) for check in failed_checks)
    required_criteria = {chunk.content.lower() for chunk in expected if chunk.kind == "acceptance"}
    completed = {item.lower() for item in evidence.acceptance_criteria_refs}
    missing = sorted(required_criteria - completed) if required_criteria else []
    if missing:
        score -= min(25, 5 * len(missing)); blockers.append(f"{len(missing)} expected acceptance criterion/criteria lack evidence."); recommendations.append("Link completed acceptance criteria to a test, check, or artifact in CI."); evidence_citations.append(_citation("ci", evidence.commit_sha, "acceptance_criteria_refs", ", ".join(missing), evidence.observed_at))
    if evidence.scope_change_count > 3:
        score -= 15; blockers.append("Scope drift is elevated for this week."); recommendations.append("Review changed files against the weekly milestone before merging."); evidence_citations.append(_citation("ci", evidence.commit_sha, "scope_change_count", str(evidence.scope_change_count), evidence.observed_at))
    if evidence.docs_updated is False and any(chunk.kind == "artifact" for chunk in expected):
        score -= 5; recommendations.append("Update the required project documentation artifact."); evidence_citations.append(_citation("ci", evidence.commit_sha, "docs_updated", "Documentation was not changed.", evidence.observed_at))
    if evidence.milestone_refs:
        evidence_citations.append(_citation("ci", evidence.commit_sha, "milestone_refs", ", ".join(evidence.milestone_refs), evidence.observed_at))
    weekly_tasks = [chunk.content for chunk in expected if chunk.kind == "task" and chunk.content.lower() not in completed]
    if progress_age_days is not None and progress_age_days >= PROGRESS_RISK_DAYS:
        status = AssessmentStatus.AT_RISK
    elif progress_age_days is not None and progress_age_days >= PROGRESS_WATCH_DAYS:
        status = AssessmentStatus.WATCH
    elif score < 55:
        status = AssessmentStatus.AT_RISK
    elif score < 80 or missing or not evidence.milestone_refs:
        status = AssessmentStatus.WATCH
    else:
        status = AssessmentStatus.CLEAR
    confidence = min(1.0, .35 + .08 * len(evidence_citations) + (.2 if evidence.tests_total is not None else 0) + (.15 if evidence.coverage_pct is not None else 0))
    summary = f"Week {week} is {status.value.replace('_', ' ')} at score {max(0, score)}/100."
    if status != AssessmentStatus.CLEAR and not evidence_citations:
        evidence_citations.append(_citation("ci", evidence.commit_sha, "commit_sha", "Assessment evidence was received.", evidence.observed_at))
    if summarizer is not None:
        try:
            summary = summarizer.summarize(summary)[:1_000]
        except Exception:
            pass
    return ProjectAssessment(assessment_id=f"assessment-{evidence.commit_sha[:32]}", project_id=spec.project_id, spec_version=spec.version, commit_sha=evidence.commit_sha, expected_week=week, status=status, score=max(0, score), confidence=round(confidence, 2), summary=summary, blockers=blockers, recommendations=recommendations, weekly_tasks=weekly_tasks, evidence_citations=evidence_citations, spec_citations=spec_citations, created_at=evidence.observed_at)


def assessment_document(assessment: ProjectAssessment) -> AssessmentDocument:
    return AssessmentDocument.model_construct(**assessment.model_dump(mode="python"))


def assessment_payload(document: AssessmentDocument | ProjectAssessment) -> dict[str, Any]:
    if isinstance(document, AssessmentDocument):
        document = ProjectAssessment.model_validate(document.model_dump(exclude={"id"}))
    return document.model_dump(mode="json", exclude_none=True)
