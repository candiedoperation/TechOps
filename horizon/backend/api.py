from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone
from typing import Any

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field

from .auth import AuthUser, get_ci_ingest_user, get_current_user, require_project_access, require_recruiting_reviewer, require_roles, visible_project_ids
from .ci_agent import (
    CIEvidence,
    assessment_document,
    assessment_payload,
    normalize_spec,
)
from .ci_llm import (
    LLMAssessor,
    LLMSpecDecomposer,
    assess_project_llm,
    decompose_spec,
)
from .config import Settings, get_settings
from .cumulative_llm import CUMULATIVE_VERSION, checkpoint_is_fresh
from .llm import GeminiStructuredLLM, LLMUnavailable
from .recruiting import (
    RECRUITING_VERSION,
    RecruitingSignalJudge,
    persist_people_portal_payload,
    run_recruiting_pipeline,
)
from .db import get_active_repository
from .jobs import generate_cumulative_checkpoint, generate_llm_snapshot, get_signal_judge
from .signal_llm import SIGNAL_VERSION
from .models import (
    AttentionStatus,
    AuditLogDocument,
    BoundaryDocument,
    BoundaryView,
    CumulativeCheckpointDocument,
    FeedbackCategory,
    FeedbackDocument,
    HealthAssessmentView,
    ProjectResponse,
    PublicAggregateMetrics,
    RepositoryRef,
    RecruitingDecision,
    RecruitingEligibilityStatus,
    RecruitingReviewDocument,
    RecruitingReviewStatus,
    RecruitingMemberStats,
    RecruitingSourceCandidateDocument,
    Role,
    WarningDocument,
    WeeklySnapshotDocument,
    PrivacySafeModel,
    new_id,
)
from .rules import RULES

router = APIRouter()


def _db() -> Any:
    return get_active_repository()


class FeedbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    snapshot_id: str
    warning_id: str | None = None
    project_id: str
    category: FeedbackCategory
    note: str | None = Field(default=None, max_length=2_000)


class BoundaryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str
    root_authentik_team_id: str
    included_subteam_ids: list[str] = Field(default_factory=list)
    primary_repos: list[RepositoryRef] = Field(default_factory=list)
    effective_from: date
    data_owner_user_id: str | None = None


class CIAssessmentRequest(PrivacySafeModel):
    project_id: str = Field(min_length=1, max_length=80)
    spec: str | dict[str, Any]
    spec_format: str | None = Field(default=None, max_length=20)
    evidence: CIEvidence


class DecomposeRequest(PrivacySafeModel):
    """Request body for ``POST /projects/{id}/spec/decompose``.

    The ``context`` field accepts free-form text from the tech lead describing
    the project goals, delivery requirements, team constraints, and risks.  The
    LLM produces a structured week-by-week plan from this; the result is
    returned for review before the tech lead commits it to the repository.
    """

    context: str = Field(
        min_length=1,
        max_length=40_000,
        description="Free-form project context from the tech lead (goals, milestones, constraints).",
    )
    lifecycle_weeks: int = Field(
        default=12,
        ge=1,
        le=52,
        description="Expected project duration in weeks.",
    )


class RecruitingReviewRequest(PrivacySafeModel):
    run_id: str = Field(min_length=1, max_length=100)
    member_login: str = Field(min_length=1, max_length=320)
    decision: RecruitingDecision
    final_rank: int | None = Field(default=None, ge=1)
    eligibility_decision: RecruitingEligibilityStatus | None = None
    note: str | None = Field(default=None, max_length=2_000)


class RecruitingSourceRequest(PrivacySafeModel):
    """Service/admin payload for a normalized People Portal export."""

    payload: dict[str, Any]
    source_run_id: str | None = Field(default=None, max_length=100)


def _get_assessor(settings: Settings) -> LLMAssessor | None:
    """Build an ``LLMAssessor`` if LLM enrichment is configured, else ``None``."""
    if not settings.llm_active:
        return None
    try:
        llm = GeminiStructuredLLM(
            api_key=settings.gemini_api_key,  # type: ignore[arg-type]
            timeout_s=settings.llm_timeout_seconds,
        )
        return LLMAssessor(llm, model=settings.assessment_model)
    except LLMUnavailable:
        return None


def _get_decomposer(settings: Settings) -> LLMSpecDecomposer | None:
    """Build an ``LLMSpecDecomposer`` if LLM enrichment is configured, else ``None``."""
    if not settings.llm_active:
        return None
    try:
        llm = GeminiStructuredLLM(
            api_key=settings.gemini_api_key,  # type: ignore[arg-type]
            timeout_s=min(settings.llm_timeout_seconds * 3, 120.0),
        )
        return LLMSpecDecomposer(llm, model=settings.decomposition_model)
    except LLMUnavailable:
        return None


def _get_recruiting_judge(settings: Settings) -> RecruitingSignalJudge | None:
    """Return the optional recruiting evidence scorer, if configured."""
    if not settings.llm_active:
        return None
    try:
        llm = GeminiStructuredLLM(
            api_key=settings.gemini_api_key,  # type: ignore[arg-type]
            timeout_s=settings.llm_recruiting_timeout_seconds,
        )
        return RecruitingSignalJudge(llm, model=settings.recruiting_model)
    except LLMUnavailable:
        return None


def _id(value: Any) -> str:
    return str(value)


def _pretty_status(value: AttentionStatus) -> tuple[str, str]:
    return {
        AttentionStatus.AT_RISK: ("At risk", "risk"),
        AttentionStatus.WATCH: ("Watch", "watch"),
        AttentionStatus.CLEAR: ("Clear", "clear"),
        AttentionStatus.INSUFFICIENT_DATA: ("Insufficient data", "data"),
        AttentionStatus.PLANNED_PAUSE: ("Planned pause", "pause"),
    }[value]


def _snapshot_id(snapshot: WeeklySnapshotDocument) -> str:
    return _id(snapshot.id)


async def _accessible_project(user: AuthUser, project_id: str) -> Any:
    project = await _db().get_project(project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="project not found")
    return project


async def _warnings_for(snapshot_id: str) -> list[WarningDocument]:
    return await _db().warnings_for_snapshot(snapshot_id)


async def _assessment_for(project_id: str) -> Any:
    return await _db().latest_assessment(project_id)


async def _assessments_for(project_id: str) -> list[Any]:
    rows = [row for row in await _db().list("assessments") if row.project_id == project_id]
    rows.sort(key=lambda row: (row.created_at, row.assessment_id), reverse=True)
    return rows


def _assessment_view(document: Any) -> dict[str, Any] | None:
    if document is None:
        return None
    citations: list[dict[str, str]] = []
    seen: set[str] = set()
    for citation in [*getattr(document, "evidence_citations", []), *getattr(document, "spec_citations", [])]:
        get_value = citation.get if isinstance(citation, dict) else lambda key, default=None: getattr(citation, key, default)
        source_type = get_value("source_type", "ci")
        source_id = get_value("source_id", "unknown")
        source_field = get_value("source_field", "evidence")
        reference = f"{source_type}:{source_id}:{source_field}"
        if reference in seen:
            continue
        seen.add(reference)
        citations.append({"label": f"{source_type} evidence", "reference": reference})
    return HealthAssessmentView(
        status=document.status.value,
        score=document.score,
        confidence=document.confidence,
        expected_week=document.expected_week,
        explanation=document.summary,
        blockers=list(document.blockers),
        recommended_weekly_tasks=list(document.weekly_tasks),
        citations=citations,
        assessment_id=document.assessment_id,
        spec_version=document.spec_version,
        commit_sha=document.commit_sha,
        generated_at=document.created_at,
    ).model_dump(mode="json", by_alias=True, exclude_none=True)


def _boundary_view(boundary: BoundaryDocument | None, project: Any) -> dict[str, Any]:
    if boundary is None:
        return {"rootTeam": "Unassigned", "subteams": [], "repos": [], "dataOwner": None, "effectiveSince": None, "lifecycle": project.lifecycle_state.value}
    repositories = [item.repo_slug for item in boundary.primary_repos]
    repositories.extend(item.repo_slug for shared in boundary.shared_repos for item in [shared])
    return {
        "rootTeam": boundary.root_authentik_team_id,
        "subteams": boundary.included_subteam_ids,
        "repos": repositories,
        "dataOwner": boundary.data_owner_user_id,
        "effectiveSince": boundary.effective_from,
        "effectiveUntil": boundary.effective_to,
        "lifecycle": project.lifecycle_state.value,
        "version": f"{boundary.project_id}:{boundary.effective_from.isoformat()}",
    }


async def _history(project_id: str) -> list[dict[str, Any]]:
    items = [item for item in await _db().list("feedback") if item.project_id == project_id]
    items.sort(key=lambda item: item.created_at, reverse=True)
    return [
        {"date": item.created_at, "actor": "Reviewer", "action": item.category.value.replace("_", " ").title(), "note": item.note or ""}
        for item in items
    ]


def _series_baselines(snapshot: WeeklySnapshotDocument) -> dict[str, list[Any]]:
    if snapshot.series_baselines:
        result = {
            "openPRs": snapshot.series_baselines.get("open_prs", snapshot.series_baselines.get("openPRs", [None, None])),
            "reviewLatency": snapshot.series_baselines.get("review_latency", snapshot.series_baselines.get("reviewLatency", [None, None])),
            "contributors": snapshot.series_baselines.get("contributors", [None, None]),
        }
        if snapshot.metrics.active_contributors is None:
            result["contributors"] = None
        return result
    baseline = snapshot.baselines
    metrics = snapshot.metrics
    result = {
        "openPRs": [baseline.open_prs if baseline else None, metrics.open_prs],
        "reviewLatency": [baseline.review_latency_days if baseline else None, metrics.review_latency_days],
        "contributors": [baseline.active_contributors if baseline else None, metrics.active_contributors],
    }
    if snapshot.metrics.active_contributors is None:
        result["contributors"] = None
    return result


async def _project_response(project: Any, snapshot: WeeklySnapshotDocument | None) -> dict[str, Any]:
    assessment = _assessment_view(await _assessment_for(project.project_id))
    if snapshot is None:
        status_value, status_class = "Insufficient data", "data"
        # Resolve the *current* boundary rather than reporting "Unassigned".
        # With lazy compute this branch is the ordinary cold-start row -- the
        # placeholder a reviewer looks at while the week is being computed --
        # so it has to carry enough identity to tell the projects apart. The
        # snapshot branch below resolves the boundary as of its own week; here
        # there is no week yet, so the latest version is the honest answer.
        no_snapshot_boundary = await _db().boundary_at(project.project_id)
        team = no_snapshot_boundary.root_authentik_team_id if no_snapshot_boundary else "Unassigned"
        repo = (
            no_snapshot_boundary.primary_repos[0].repo_slug
            if no_snapshot_boundary and no_snapshot_boundary.primary_repos
            else "—"
        )
        return ProjectResponse(
            id=project.project_id, name=project.display_name, short=project.display_name[:2].upper(), team=team, repo=repo,
            status=status_value, statusClass=status_class, signal="No snapshot available", signalDetail="Data is not yet sufficient for a trusted assessment.", lastActivity="—", trend="flat", weeks=[None] * 8,
            flagFrom=99, seriesBaselines={"openPRs": [None, None], "reviewLatency": [None, None], "contributors": None}, series={"activity": [None] * 8, "openPRs": [None] * 8, "reviewLatency": [None] * 8, "contributors": None}, description="", boundary=BoundaryView(rootTeam=team, lifecycle=project.lifecycle_state.value), history=await _history(project.project_id), snapshot_id=None, healthAssessment=assessment,
        ).model_dump(mode="json", by_alias=True, exclude_none=True)

    status_value, status_class = _pretty_status(snapshot.attention_status)
    warnings = await _warnings_for(_snapshot_id(snapshot))
    evidence: list[dict[str, Any]] = []
    for warning in warnings:
        for item in warning.evidence:
            payload = item.model_dump(mode="json", by_alias=True, exclude_none=True)
            payload["warning_id"] = _id(warning.id)
            payload["sourceEvidence"] = [ref.model_dump(mode="json") for ref in item.source_refs]
            evidence.append(payload)
    boundary = await _db().boundary_at(project.project_id, snapshot.week_start)
    metrics = PublicAggregateMetrics.from_metrics(snapshot.metrics).model_dump(mode="json", exclude_none=True)
    baselines = PublicAggregateMetrics.from_metrics(snapshot.baselines).model_dump(mode="json", exclude_none=True) if snapshot.baselines else None
    series = snapshot.series or {"activity": [None] * 8, "open_prs": [None] * 8, "review_latency": [None] * 8, "contributors": [None] * 8}
    contributor_series = series.get("contributors", [None] * 8) if snapshot.metrics.active_contributors is not None else None
    days_since_activity = snapshot.metrics.days_since_activity
    last_activity = "—" if days_since_activity is None else "Today" if days_since_activity == 0 else "Yesterday" if days_since_activity == 1 else f"{days_since_activity} days ago"
    is_llm_signal = snapshot.signal_source == "llm"
    first_warning = snapshot.signal_headline if (is_llm_signal and snapshot.signal_headline) else warnings[0].signal_name if warnings else ("Inactivity is expected" if snapshot.attention_status == AttentionStatus.PLANNED_PAUSE else "No current concern detected" if snapshot.attention_status == AttentionStatus.CLEAR else "Repository mapping incomplete" if snapshot.attention_status == AttentionStatus.INSUFFICIENT_DATA else "Review current project signals")
    detail = snapshot.signal_summary if (is_llm_signal and snapshot.signal_summary) else warnings[0].explanation if warnings else ("Pause recorded; signals are suppressed." if snapshot.attention_status == AttentionStatus.PLANNED_PAUSE else "Ownership review required" if snapshot.attention_status == AttentionStatus.INSUFFICIENT_DATA else "Available project aggregates are within the current rule set.")
    weeks = list(series.get("activity", [None] * 8))[-8:]
    weeks = [None] * (8 - len(weeks)) + weeks
    # An LLM-sourced snapshot has no rule-engine baseline math behind it, so
    # flagFrom (a rule-threshold week index) and a status-derived trend would
    # both be fabricated -- flagFrom is fixed at "no threshold" and trend
    # comes from the judge's own work_volume read instead.
    trend = (
        ("down" if snapshot.signal_work_volume in {"none", "trivial"} else "flat")
        if is_llm_signal
        else ("down" if status_class in {"risk", "watch"} else "flat")
    )
    flag_from = 99 if is_llm_signal else (5 if status_class == "risk" else 6 if status_class == "watch" else 99)
    return ProjectResponse(
        id=project.project_id, name=project.display_name, short=project.display_name[:2].upper(), team=boundary.root_authentik_team_id if boundary else "Unassigned", repo=boundary.primary_repos[0].repo_slug if boundary and boundary.primary_repos else "—",
        status=status_value, statusClass=status_class, signal=first_warning, signalDetail=detail,
        signalSource="llm" if is_llm_signal else "rules",
        signalConfidence=snapshot.signal_confidence if is_llm_signal else None,
        signalModel=snapshot.signal_model if is_llm_signal else None,
        signalEvidenceTier=snapshot.signal_evidence_tier if is_llm_signal else None,
        lastActivity=last_activity, trend=trend, weeks=weeks,
        flagFrom=flag_from, seriesBaselines=_series_baselines(snapshot), series={"activity": series.get("activity", [None] * 8), "openPRs": series.get("openPRs", series.get("open_prs", [None] * 8)), "reviewLatency": series.get("review_latency", series.get("reviewLatency", series.get("review_latency_days", [None] * 8))), "contributors": contributor_series}, description="", boundary=_boundary_view(boundary, project), evidence=evidence, history=await _history(project.project_id), metrics=metrics, baselines=baselines, data_completeness_pct=snapshot.data_completeness_pct, last_sync_at=snapshot.last_sync_at, snapshot_id=_snapshot_id(snapshot), healthAssessment=assessment,
    ).model_dump(mode="json", by_alias=True, exclude_none=True)


def _snapshot_preference_key(snapshot: WeeklySnapshotDocument) -> tuple[Any, int, datetime]:
    """Prefer a grounded LLM signal over a rules row for the same week."""
    return (
        snapshot.week_start,
        1 if snapshot.signal_source == "llm" else 0,
        snapshot.generated_at,
    )


def _snapshot_envelope(snapshots: list[WeeklySnapshotDocument], projects: list[dict[str, Any]]) -> dict[str, Any]:
    latest = max(snapshots, key=_snapshot_preference_key, default=None)
    if latest is None:
        now = datetime.now(timezone.utc)
        return {"snapshot_week_start": None, "snapshot_week_end": None, "generated_at": now, "rule_set_version": "none", "data_completeness_pct": 0, "last_sync_at": None, "projects": projects}
    completeness = round(sum(item.data_completeness_pct for item in snapshots) / len(snapshots), 1) if snapshots else 0
    return {"snapshot_week_start": latest.week_start, "snapshot_week_end": latest.week_end, "generated_at": latest.generated_at, "rule_set_version": latest.rule_set_version, "data_completeness_pct": completeness, "last_sync_at": latest.last_sync_at, "projects": projects}


@router.get("/health")
async def health(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {
        "status": "ok",
        "environment": settings.environment,
        "database": "sqlite",
        **({"sqlite_path": settings.sqlite_path} if settings.local_auth else {}),
        "directory_source": "people_portal" if settings.people_portal_url else "authentik" if settings.authentik_url else None,
        "people_portal_configured": bool(settings.people_portal_url),
        "outbound_notifications": False,
    }


@router.get("/snapshots/latest")
async def latest_snapshot(user: AuthUser = Depends(get_current_user)) -> dict[str, Any]:
    """The live dashboard read: every project's most recent persisted snapshot.

    Cache-only, like every other GET here. A project with no snapshot at all
    is still returned -- in its empty ``_project_response`` shape -- and its
    id is listed in ``missing_project_ids`` so the frontend can compute it
    lazily, one row at a time, as the reviewer scrolls it into view. That is
    what lets a database with no ingested history (a fresh deploy, or a host
    whose disk does not survive one) render real signals without a sync job
    having run first.
    """
    database = _db()
    all_projects = await database.list("projects")
    ids = visible_project_ids(user, [project.project_id for project in all_projects])
    items: list[dict[str, Any]] = []
    snapshots: list[WeeklySnapshotDocument] = []
    missing: list[str] = []
    for project_id in ids:
        snapshot = await database.latest_snapshot(project_id)
        if snapshot:
            snapshots.append(snapshot)
        project = await database.get_project(project_id)
        if project:
            items.append(await _project_response(project, snapshot))
            # Only a project that actually rendered a row can be lazily
            # filled in, so an id with no project document is not "missing".
            if snapshot is None:
                missing.append(project_id)
    envelope = _snapshot_envelope(snapshots, items)
    settings = get_settings()
    today = datetime.now(timezone.utc).date()
    current_week_start = today - timedelta(days=today.weekday())
    envelope["missing_project_ids"] = missing
    envelope["computable"] = bool(settings.llm_active)
    # The most recent *completed* ISO week, which is the newest week the lazy
    # fan-out can ask for: POST /projects/{id}/snapshots/at refuses the
    # in-progress week, since weekly_snapshots is immutable and caching a
    # partial week would freeze a wrong verdict for the rest of it.
    envelope["lazy_week_start"] = current_week_start - timedelta(days=7)
    return envelope


@router.get("/portfolio/delivery")
async def portfolio_delivery(user: AuthUser = Depends(get_current_user)) -> dict[str, Any]:
    """Portfolio-wide delivery facts, folded from the latest ``repo_activity`` rows.

    Read-only and cache-only: every number here was already captured by the
    Gitea sync, so this never touches the network. Each repo contributes its
    most recently synced window once -- ``repo_activity`` is one row per
    (project, repo, week), so summing the table blindly would multiply a
    repo's open-PR count by however many weeks it has been tracked, and would
    double-count any repo shared by two projects.

    Every field is ``None`` rather than ``0`` when nothing was captured, so the
    UI can distinguish "no open pull requests" from "not synced yet".
    """
    database = _db()
    all_projects = await database.list("projects")
    ids = set(visible_project_ids(user, [project.project_id for project in all_projects]))

    latest_by_repo: dict[str, Any] = {}
    for row in await database.list("repo_activity"):
        if str(getattr(row, "project_id", "")) not in ids:
            continue
        slug = str(getattr(row, "repo_slug", "") or "")
        if not slug:
            continue
        current = latest_by_repo.get(slug)
        if current is None or row.window_start > current.window_start:
            latest_by_repo[slug] = row
    rows = list(latest_by_repo.values())

    def _total(field: str) -> int | None:
        values = [getattr(row, field, None) for row in rows]
        present = [int(value) for value in values if isinstance(value, (int, float))]
        return sum(present) if present else None

    oldest_ages = [
        float(row.oldest_open_pr_days) for row in rows
        if isinstance(getattr(row, "oldest_open_pr_days", None), (int, float))
    ]
    # Contributors are named, so a person on two repos must count once.
    people: set[str] = set()
    for row in rows:
        people.update(str(name) for name in (getattr(row, "contributors", None) or []) if name)

    return {
        "repos_tracked": len(rows) or None,
        "open_prs": _total("open_prs"),
        "oldest_open_pr_days": round(max(oldest_ages), 1) if oldest_ages else None,
        "branches_ahead": _total("branches_ahead"),
        "open_issues": _total("open_issues"),
        "contributors": len(people) or None,
        "synced_at": max((row.synced_at for row in rows), default=None),
    }


@router.get("/snapshots/at")
async def snapshot_at_date(
    on: date = Query(alias="date"),
    user: AuthUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Portfolio status for the ISO week containing ``date``.

    Snapshots are immutable and weekly, so this never recomputes anything --
    it serves the same historical verdict that ``run_weekly_backfill`` (or a
    normal weekly job) already persisted for that week, i.e. what the rules
    said *at the time* using only the data that existed before it. A week
    with no persisted snapshot (before the portfolio's backfilled history, or
    the current in-progress week) returns each project in its ordinary
    "no snapshot available" shape rather than an error.
    """
    database = _db()
    week_start = on - timedelta(days=on.weekday())
    week_end = week_start + timedelta(days=6)
    all_projects = await database.list("projects")
    ids = visible_project_ids(user, [project.project_id for project in all_projects])
    by_project: dict[str, WeeklySnapshotDocument] = {}
    for row in await database.list("snapshots"):
        if row.week_start != week_start:
            continue
        current = by_project.get(row.project_id)
        if current is None or _snapshot_preference_key(row) > _snapshot_preference_key(current):
            by_project[row.project_id] = row
    items: list[dict[str, Any]] = []
    snapshots: list[WeeklySnapshotDocument] = []
    for project_id in ids:
        snapshot = by_project.get(project_id)
        if snapshot:
            snapshots.append(snapshot)
        project = await database.get_project(project_id)
        if project:
            items.append(await _project_response(project, snapshot))
    rule_versions = {item.rule_set_version for item in snapshots}
    generated_ats = [item.generated_at for item in snapshots]
    last_syncs = [item.last_sync_at for item in snapshots if item.last_sync_at]
    completeness = round(sum(item.data_completeness_pct for item in snapshots) / len(snapshots), 1) if snapshots else 0
    settings = get_settings()
    today = datetime.now(timezone.utc).date()
    current_week_start = today - timedelta(days=today.weekday())
    return {
        "date": on,
        "has_data": bool(snapshots),
        "snapshot_week_start": week_start,
        "snapshot_week_end": week_end,
        "generated_at": max(generated_ats) if generated_ats else None,
        "rule_set_version": next(iter(rule_versions)) if len(rule_versions) == 1 else ("mixed" if rule_versions else "none"),
        "data_completeness_pct": completeness,
        "last_sync_at": max(last_syncs) if last_syncs else None,
        # Which projects have no snapshot for this week yet -- the frontend
        # renders a "Compute this week" button for each of these, but only
        # when the week is in the past; the current/future week is the
        # weekly cron's job, not a per-project lazy compute.
        "missing_project_ids": [pid for pid in ids if pid not in by_project],
        "computable": bool(settings.llm_active) and week_start < current_week_start,
        "projects": items,
    }


@router.get("/projects/{project_id}/snapshots/at")
async def project_snapshot_at_date(
    project_id: str,
    on: date = Query(alias="date"),
    user: AuthUser = Depends(require_project_access),
) -> dict[str, Any]:
    """One project's persisted snapshot for the ISO week containing ``date``.

    The read-only sibling of the POST below and the per-project counterpart of
    ``GET /snapshots/at``: cache-only, never computes, and serves exactly the
    same ``_project_response`` shape the live ``GET /projects/{id}/snapshots``
    serves, so the profile page can render a historical week with no
    special-casing. A week with no persisted snapshot returns ``has_data:
    false`` rather than falling back to a newer week -- the caller must show
    an honest empty state instead of live data.
    """
    project = await _accessible_project(user, project_id)
    database = _db()
    week_start = on - timedelta(days=on.weekday())
    week_end = week_start + timedelta(days=6)
    rows = [row for row in await database.list("snapshots") if row.project_id == project_id and row.week_start == week_start]
    snapshot = max(rows, key=_snapshot_preference_key) if rows else None
    return {
        "project_id": project_id,
        "date": on,
        "has_data": snapshot is not None,
        "snapshot_id": _snapshot_id(snapshot) if snapshot else None,
        "snapshot_week_start": week_start,
        "snapshot_week_end": week_end,
        "generated_at": snapshot.generated_at if snapshot else None,
        "rule_set_version": snapshot.rule_set_version if snapshot else None,
        "data_completeness_pct": snapshot.data_completeness_pct if snapshot else 0,
        "last_sync_at": snapshot.last_sync_at if snapshot else None,
        "project": await _project_response(project, snapshot),
    }


@router.post("/projects/{project_id}/snapshots/at")
async def compute_project_snapshot_at_date(
    project_id: str,
    on: date = Query(alias="date"),
    user: AuthUser = Depends(require_project_access),
) -> dict[str, Any]:
    """Explicit "Compute this week" action for one project's historical week.

    POST, unlike the cache-only ``GET /snapshots/at`` above, because this can
    write a new immutable snapshot. Refuses the current/future week -- that
    belongs to the weekly cron (``POST /admin/sync/weekly``), not a
    per-project lazy compute, since a partial in-progress week would get
    cached immutably and look wrong for the rest of the week.
    """
    project = await _accessible_project(user, project_id)
    settings = get_settings()
    week_start = on - timedelta(days=on.weekday())
    today = date.today()
    current_week_start = today - timedelta(days=today.weekday())
    if week_start >= current_week_start:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="weekly snapshots require a completed week; use progress/at for an in-progress date",
        )

    database = _db()
    existing = [
        row for row in await database.list("snapshots")
        if row.project_id == project_id and row.week_start == week_start and row.rule_set_version == SIGNAL_VERSION
    ]
    if existing:
        return {"project": await _project_response(project, existing[0]), "computed": False, "cached": True}

    if not settings.llm_active:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="LLM signal is not configured")

    judge = get_signal_judge(settings)
    try:
        snapshot = await asyncio.wait_for(
            generate_llm_snapshot(project_id, week_start, settings=settings, database=database, judge=judge),
            timeout=settings.lazy_compute_timeout_seconds,
        )
    except TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="still computing this project's week -- a concurrent request may already be in flight, try again shortly",
            headers={"Retry-After": "30"},
        )
    if snapshot is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="the LLM judgment could not be completed for this week",
        )
    return {"project": await _project_response(project, snapshot), "computed": True, "cached": False}


async def _progress_project_response(project: Any, checkpoint: CumulativeCheckpointDocument | None) -> dict[str, Any]:
    """Shape one project's row for the Projects-page cumulative-progress calendar.

    Deliberately a separate, purpose-built shape from ``_project_response``
    (which expects a ``WeeklySnapshotDocument``) rather than force-fitting a
    checkpoint into that contract -- the two answer different questions and
    the frontend surfaces for them are independent.
    """
    boundary = await _db().boundary_at(project.project_id)
    base = {
        "id": project.project_id,
        "name": project.display_name,
        "short": project.display_name[:2].upper(),
        "team": boundary.root_authentik_team_id if boundary else "Unassigned",
        "repo": boundary.primary_repos[0].repo_slug if boundary and boundary.primary_repos else "—",
    }
    if checkpoint is None:
        return {
            **base,
            "status": "Insufficient data", "statusClass": "data",
            "headline": "No progress computed yet", "narrative": "", "trajectory": "unknown",
            "confidence": None, "workToDate": None, "milestones": [], "openConcerns": [],
            "recommendations": [], "dataGaps": [], "weeksDeepJudged": 0, "weeksTotal": 0,
            "historyTruncated": False, "asOfDate": None, "generatedAt": None,
            "isProvisional": False, "checkpointId": None,
        }
    status_value, status_class = _pretty_status(checkpoint.status)
    return {
        **base,
        "status": status_value, "statusClass": status_class,
        "headline": checkpoint.headline, "narrative": checkpoint.narrative,
        "trajectory": checkpoint.trajectory, "confidence": checkpoint.confidence,
        "workToDate": checkpoint.work_to_date,
        "milestones": checkpoint.milestones, "openConcerns": checkpoint.open_concerns,
        "recommendations": checkpoint.recommendations, "dataGaps": checkpoint.data_gaps,
        "weeksDeepJudged": len(checkpoint.weeks_deep_judged),
        "weeksTotal": len(checkpoint.weeks_deep_judged) + len(checkpoint.weeks_shallow_counts),
        "historyTruncated": checkpoint.history_truncated,
        "asOfDate": checkpoint.as_of_date, "generatedAt": checkpoint.generated_at,
        "isProvisional": checkpoint.is_provisional, "checkpointId": _id(checkpoint.id),
    }


@router.get("/progress/at")
async def progress_at_date(
    on: date = Query(alias="date"),
    user: AuthUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Cache-only read of every project's cumulative-progress checkpoint as of a date.

    Never computes -- mirrors ``snapshot_at_date``'s contract. The Projects-
    page calendar reads this first, then automatically (no button) fans out
    ``POST /projects/{id}/progress/at`` for whatever's in ``missing_project_ids``.
    """
    database = _db()
    as_of_week_start = on - timedelta(days=on.weekday())
    settings = get_settings()
    now = datetime.now(timezone.utc)
    if on > now.date():
        raise HTTPException(status_code=400, detail="date must not be in the future")
    all_projects = await database.list("projects")
    ids = visible_project_ids(user, [project.project_id for project in all_projects])
    by_project: dict[str, CumulativeCheckpointDocument] = {}
    for row in await database.list("cumulative_checkpoints"):
        if not checkpoint_is_fresh(row, on, now=now, ttl_minutes=settings.cumulative_provisional_ttl_minutes):
            continue
        current = by_project.get(row.project_id)
        if current is None or row.generated_at > current.generated_at:
            by_project[row.project_id] = row
    items: list[dict[str, Any]] = []
    for project_id in ids:
        project = await database.get_project(project_id)
        if project:
            items.append(await _progress_project_response(project, by_project.get(project_id)))
    settings = get_settings()
    return {
        "date": on,
        "as_of_week_start": as_of_week_start,
        "missing_project_ids": [pid for pid in ids if pid not in by_project],
        "computable": bool(settings.llm_active),
        "projects": items,
    }


@router.post("/projects/{project_id}/progress/at")
async def compute_project_progress_at_date(
    project_id: str,
    on: date = Query(alias="date"),
    user: AuthUser = Depends(require_project_access),
) -> dict[str, Any]:
    """Bounded compute of one project's cumulative progress as of a date.

    This is what the Projects-page calendar automatically fans out to, one
    request per project, when a date is picked -- there is deliberately no
    portfolio-wide compute endpoint (see ``generate_cumulative_checkpoint``'s
    docstring for why a single request covering every project would
    reintroduce the unbounded-request problem this whole design avoids).
    """
    project = await _accessible_project(user, project_id)
    settings = get_settings()
    now = datetime.now(timezone.utc)
    if on > now.date():
        raise HTTPException(status_code=400, detail="date must not be in the future")
    database = _db()
    existing = next((c for c in await database.list("cumulative_checkpoints")
                     if str(c.project_id) == project_id and checkpoint_is_fresh(
                         c, on, now=now, ttl_minutes=settings.cumulative_provisional_ttl_minutes)), None)
    if existing is not None:
        return {"project": await _progress_project_response(project, existing), "computed": False, "cached": True}
    if not settings.llm_active:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="LLM signal is not configured")

    database = _db()
    try:
        checkpoint = await asyncio.wait_for(
            generate_cumulative_checkpoint(project_id, on, settings=settings, database=database),
            timeout=settings.cumulative_compute_timeout_seconds,
        )
    except TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="still computing this project's progress -- a concurrent request may already be in flight, try again shortly",
            headers={"Retry-After": "30"},
        )
    if checkpoint is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="the cumulative-progress synthesis could not be completed",
        )
    return {"project": await _progress_project_response(project, checkpoint), "computed": True, "cached": False}


@router.get("/projects/{project_id}/snapshots")
async def project_snapshots(project_id: str, user: AuthUser = Depends(require_project_access)) -> dict[str, Any]:
    project = await _accessible_project(user, project_id)
    rows = sorted(
        [row for row in await _db().list("snapshots") if row.project_id == project_id],
        key=_snapshot_preference_key,
        reverse=True,
    )
    payload = []
    for snapshot in rows:
        project_payload = await _project_response(project, snapshot)
        payload.append({"snapshot_id": _snapshot_id(snapshot), "snapshot_week_start": snapshot.week_start, "snapshot_week_end": snapshot.week_end, "generated_at": snapshot.generated_at, "rule_set_version": snapshot.rule_set_version, "data_completeness_pct": snapshot.data_completeness_pct, "last_sync_at": snapshot.last_sync_at, "project": project_payload})
    return {"project_id": project_id, "snapshots": payload}


@router.get("/projects/{project_id}/boundary")
async def project_boundary(project_id: str, user: AuthUser = Depends(require_project_access)) -> dict[str, Any]:
    project = await _accessible_project(user, project_id)
    boundary = await _db().boundary_at(project_id)
    return {"project_id": project_id, "boundary": _boundary_view(boundary, project)}


@router.get("/projects/{project_id}/health-assessment")
async def project_health_assessment(project_id: str, user: AuthUser = Depends(require_project_access)) -> dict[str, Any]:
    await _accessible_project(user, project_id)
    return {"project_id": project_id, "assessment": _assessment_view(await _assessment_for(project_id))}


@router.post("/feedback", status_code=status.HTTP_201_CREATED)
async def create_feedback(request: FeedbackRequest, user: AuthUser = Depends(get_current_user)) -> dict[str, Any]:
    await _accessible_project(user, request.project_id)
    try:
        uuid.UUID(request.snapshot_id)
    except (ValueError, AttributeError) as exc:
        raise HTTPException(status_code=422, detail="snapshot_id is invalid") from exc
    snapshot = await _db().snapshot_by_id(request.snapshot_id)
    if snapshot is None or snapshot.project_id != request.project_id or request.snapshot_id != str(snapshot.id):
        raise HTTPException(status_code=404, detail="snapshot not found for project")
    warning_str_id = None
    if request.warning_id:
        try:
            uuid.UUID(request.warning_id)
        except (ValueError, AttributeError) as exc:
            raise HTTPException(status_code=422, detail="warning_id is invalid") from exc
        warning = await _db().warning_by_id(request.warning_id)
        if warning is None or str(warning.snapshot_id) != str(snapshot.id):
            raise HTTPException(status_code=404, detail="warning not found for snapshot")
        warning_str_id = request.warning_id
    feedback = FeedbackDocument.model_construct(id=new_id(), snapshot_id=str(snapshot.id), warning_id=warning_str_id, project_id=request.project_id, author_user_id=user.subject, category=request.category, note=request.note, created_at=datetime.now(timezone.utc))
    await _db().add("feedback", feedback)
    audit = AuditLogDocument.model_construct(actor_user_id=user.subject, action="feedback.created", target_type="feedback", target_id=_id(feedback.id), after={"project_id": request.project_id, "snapshot_id": request.snapshot_id, "warning_id": request.warning_id, "category": request.category.value}, at=datetime.now(timezone.utc))
    await _db().add("audit_log", audit)
    return {"id": _id(feedback.id), "snapshot_id": request.snapshot_id, "project_id": request.project_id, "category": request.category.value, "created_at": feedback.created_at}


@router.get("/audit")
async def audit_log(user: AuthUser = Depends(require_roles(Role.ADMIN, Role.PORTFOLIO_LEADER)), project_id: str | None = Query(default=None), limit: int = Query(default=100, ge=1, le=500)) -> list[dict[str, Any]]:
    rows = list(await _db().list("audit_log"))
    if project_id:
        rows = [row for row in rows if (row.after or {}).get("project_id") == project_id]
    rows.sort(key=lambda row: row.at, reverse=True)
    return [{"id": _id(row.id), "actor_user_id": row.actor_user_id, "action": row.action, "target_type": row.target_type, "target_id": row.target_id, "before": row.before, "after": row.after, "at": row.at} for row in rows[:limit]]


@router.get("/rules")
async def rules(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    descriptions = {
        "activity_decline": ("Activity decline", "active days fall below the trailing median", "watch"),
        "open_pr_aging": ("Open PR aging", "oldest open PR exceeds the trailing 75th percentile", "at_risk"),
        "review_latency": ("Review latency", "review latency exceeds the trailing 75th percentile", "watch"),
        "merged_throughput": ("Merged throughput", "merged PR volume falls below the trailing 25th percentile", "watch"),
        "inactivity": ("Inactivity", "days since activity exceeds the trailing 75th percentile", "watch"),
        "contributor_resilience": ("Contributor resilience", "aggregate active contributor count falls below the trailing 25th percentile", "watch"),
    }
    return {"rule_set_version": settings.rule_set_version, "rules": [{"rule_id": rule_id, "version": settings.rule_set_version, "signal_name": descriptions.get(rule_id, (rule_id, "", "watch"))[0], "description": descriptions.get(rule_id, ("", "", ""))[1], "minimum_data": "at least 4 trailing observations", "threshold": descriptions.get(rule_id, ("", "", ""))[1], "severity": descriptions.get(rule_id, ("", "", "watch"))[2], "status": "Active"} for rule_id in RULES]}


async def _submit_ci_assessment(request: CIAssessmentRequest, user: AuthUser) -> dict[str, Any]:
    await _accessible_project(user, request.project_id)
    if request.evidence.project_id != request.project_id:
        raise HTTPException(status_code=422, detail="project_id does not match evidence.project_id")
    try:
        spec = normalize_spec(request.spec, project_id=request.project_id, source_format=request.spec_format)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    database = _db()
    # Idempotency: return the existing assessment for the same commit without re-running
    all_assessments = await database.list("assessments")
    existing = next(
        (row for row in all_assessments
         if row.project_id == request.project_id
         and row.commit_sha == request.evidence.commit_sha),
        None,
    )
    if existing is not None:
        return {"idempotent": True, "assessment": assessment_payload(existing)}

    # Fetch the last 4 assessments to supply as history for the LLM
    prior = sorted(
        [row for row in all_assessments if row.project_id == request.project_id],
        key=lambda r: (r.expected_week, r.created_at),
        reverse=True,
    )[:4]

    try:
        settings = get_settings()
        assessment = await assess_project_llm(
            spec,
            request.evidence,
            assessor=_get_assessor(settings),
            history=prior,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    document = assessment_document(assessment)
    await database.add("assessments", document)
    return {"idempotent": False, "assessment": assessment_payload(document)}


@router.post("/ci/assessments", status_code=status.HTTP_201_CREATED)
async def submit_ci_assessment(request: CIAssessmentRequest, user: AuthUser = Depends(get_ci_ingest_user)) -> dict[str, Any]:
    return await _submit_ci_assessment(request, user)


@router.post("/ci/evidence", status_code=status.HTTP_201_CREATED)
async def submit_ci_evidence(request: CIAssessmentRequest, user: AuthUser = Depends(get_ci_ingest_user)) -> dict[str, Any]:
    return await _submit_ci_assessment(request, user)


@router.get("/projects/{project_id}/assessments")
async def project_assessments(project_id: str, user: AuthUser = Depends(require_project_access)) -> dict[str, Any]:
    await _accessible_project(user, project_id)
    rows = await _assessments_for(project_id)
    return {"project_id": project_id, "assessments": [assessment_payload(row) for row in rows]}


@router.get("/projects/{project_id}/assessments/latest")
async def latest_project_assessment(project_id: str, user: AuthUser = Depends(require_project_access)) -> dict[str, Any]:
    await _accessible_project(user, project_id)
    rows = await _assessments_for(project_id)
    latest = rows[0] if rows else None
    return {"project_id": project_id, "assessment": assessment_payload(latest) if latest else None}


@router.get("/projects/{project_id}/weekly-tasks")
async def project_weekly_tasks(project_id: str, week: int | None = Query(default=None, ge=1, le=52), user: AuthUser = Depends(require_project_access)) -> dict[str, Any]:
    await _accessible_project(user, project_id)
    rows = await _assessments_for(project_id)
    latest = rows[0] if rows else None
    tasks = latest.weekly_tasks if latest and (week is None or latest.expected_week == week) else []
    return {"project_id": project_id, "week": week if week is not None else (latest.expected_week if latest else None), "tasks": tasks, "assessment_id": latest.assessment_id if latest else None}


@router.post("/projects/{project_id}/spec/decompose", status_code=status.HTTP_200_OK)
async def decompose_project_spec(
    project_id: str,
    request: DecomposeRequest,
    user: AuthUser = Depends(require_roles(Role.ADMIN, Role.PORTFOLIO_LEADER)),
) -> dict[str, Any]:
    """Decompose free-form project context into a structured week-by-week spec.

    This is a **kickoff-time** operation, intended to run once when a project
    starts.  The tech lead provides free-form context (goals, milestones,
    constraints); the LLM produces a structured plan the CI agent can score
    against every week.

    The response includes the generated spec for review.  The tech lead should
    commit the spec to the repository before submitting CI assessments, so the
    ``spec_version`` is stable across all submissions for the project lifetime.

    When ``PHI_LLM_ENABLED`` is ``false`` or ``PHI_GEMINI_API_KEY`` is
    absent, the context is treated as a Markdown spec and parsed directly.
    """
    await _accessible_project(user, project_id)
    settings = get_settings()
    decomposer = _get_decomposer(settings)
    try:
        spec = await decompose_spec(
            request.context,
            project_id=project_id,
            lifecycle_weeks=request.lifecycle_weeks,
            decomposer=decomposer,
        )
    except (ValueError, LLMUnavailable) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "project_id": project_id,
        "spec_version": spec.version,
        "lifecycle_weeks": spec.lifecycle_weeks,
        "llm_generated": decomposer is not None,
        "chunk_count": len(spec.chunks),
        "weeks": sorted(
            {(c.week_start, c.week_end) for c in spec.chunks},
            key=lambda w: w[0],
        ),
        "spec": {
            "project_id": spec.project_id,
            "version": spec.version,
            "lifecycle_weeks": spec.lifecycle_weeks,
            "chunks": [c.model_dump(mode="json") for c in spec.chunks],
        },
    }


@router.get("/boundaries")
async def boundaries(user: AuthUser = Depends(require_roles(Role.ADMIN, Role.PORTFOLIO_LEADER))) -> list[dict[str, Any]]:
    rows = await _db().list("boundaries")
    return [row.model_dump(mode="json", exclude_none=True) for row in sorted(rows, key=lambda item: (item.project_id, item.effective_from), reverse=True)]


@router.post("/boundaries", status_code=status.HTTP_201_CREATED)
async def create_boundary(request: BoundaryRequest, user: AuthUser = Depends(require_roles(Role.ADMIN))) -> dict[str, Any]:
    await _accessible_project(user, request.project_id)
    database = _db()
    existing = await database.boundary_at(request.project_id)
    if existing and existing.effective_from >= request.effective_from:
        raise HTTPException(status_code=409, detail="effective_from must advance the boundary version")
    if existing and existing.effective_to is None:
        existing.effective_to = request.effective_from
        await database.replace(existing)
    boundary = BoundaryDocument.model_construct(project_id=request.project_id, root_authentik_team_id=request.root_authentik_team_id, included_subteam_ids=request.included_subteam_ids, primary_repos=request.primary_repos, effective_from=request.effective_from, data_owner_user_id=request.data_owner_user_id, created_by=user.subject)
    await database.add("boundaries", boundary)
    audit = AuditLogDocument.model_construct(actor_user_id=user.subject, action="boundary.created", target_type="boundary", target_id=f"{request.project_id}:{request.effective_from}", after=request.model_dump(mode="json"), at=datetime.now(timezone.utc))
    await database.add("audit_log", audit)
    return {"project_id": request.project_id, "boundary": _boundary_view(boundary, await database.get_project(request.project_id))}


# ---------------------------------------------------------------------------
# Gitea member analytics
#
# Unlike the rest of this router these routes return named, per-person
# contribution metrics. They are descriptive activity indicators, not a
# performance score: volume is shaped by task size, role, collaboration style,
# generated code, and repository history.
# ---------------------------------------------------------------------------

MEMBER_SORT_FIELDS = {
    "commits", "additions", "deletions", "unique_files", "pulls_opened",
    "pulls_merged", "reviews_submitted", "reviews_approved", "issues_opened",
    "active_days", "blame_lines", "name",
}

_ANALYTICS_DISCLAIMER = (
    "Descriptive activity indicators, not a performance score. Volume is affected by "
    "task size, role, collaboration style, generated code, and repository history."
)


async def _resolve_analytics_run(run_id: str | None) -> Any:
    """Return the requested run, or the newest one; 404 when none is ingested."""
    database = _db()
    run = await (database.member_analytics_run(run_id) if run_id else database.latest_member_analytics_run())
    if run is None:
        raise HTTPException(
            status_code=404,
            detail=f"analytics run '{run_id}' not found" if run_id else "no analytics run has been ingested",
        )
    return run


def _member_row(metric: Any) -> dict[str, Any]:
    payload = metric.model_dump(mode="json", exclude_none=False)
    payload.pop("id", None)
    payload["has_activity"] = metric.has_activity
    return payload


def _run_meta(run: Any) -> dict[str, Any]:
    return {
        "run_id": run.run_id,
        "generated_at": run.generated_at,
        "ingested_at": run.ingested_at,
        "gitea_url": run.gitea_url,
        "history_scope": run.history_scope,
        "commit_stats_scope": run.commit_stats_scope,
        "blame_status": run.blame_status,
        "blame_method": run.blame_method,
        "api_calls": run.api_calls,
        # A non-empty list means part of the run is missing rather than zero.
        "warnings": run.warnings,
        "coverage": run.coverage,
        "member_count": run.member_count,
}


def _sum_available(values: Any) -> int | None:
    available = [value for value in values if value is not None]
    return sum(available) if available else None


@router.get("/analytics/runs")
async def analytics_runs(user: AuthUser = Depends(get_current_user)) -> dict[str, Any]:
    """Every ingested collection run, newest first."""
    runs = await _db().member_analytics_runs()
    return {"runs": [_run_meta(run) for run in runs], "disclaimer": _ANALYTICS_DISCLAIMER}


@router.get("/analytics/summary")
async def analytics_summary(
    run_id: str | None = Query(default=None),
    user: AuthUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Portfolio-wide totals for one run, plus its collection warnings."""
    run = await _resolve_analytics_run(run_id)
    metrics = await _db().member_metrics_for_run(run.run_id)
    roster = [m for m in metrics if m.roster_member and not m.service_or_admin]
    return {
        "run": _run_meta(run),
        "totals": {
            "organizations": len(run.organizations),
            "repositories": len(run.repositories),
            "roster_members": len(roster),
            "unmatched_identities": sum(1 for m in metrics if not m.roster_member),
            "service_accounts": sum(1 for m in metrics if m.service_or_admin),
            "active_members": sum(1 for m in roster if m.has_activity),
            "commits": sum(repo.commit_count for repo in run.repositories),
            "pull_requests": sum(repo.pull_count for repo in run.repositories),
            "merged_pull_requests": sum(repo.merged_count for repo in run.repositories),
            "issues": sum(repo.issue_count for repo in run.repositories),
            "blame_lines": _sum_available(m.blame_lines for m in metrics),
        },
        "disclaimer": _ANALYTICS_DISCLAIMER,
    }


@router.get("/analytics/members")
async def analytics_members(
    run_id: str | None = Query(default=None),
    organization: str | None = Query(default=None),
    search: str | None = Query(default=None, max_length=200),
    sort: str = Query(default="commits"),
    include_service: bool = Query(default=True),
    include_unmatched: bool = Query(default=True),
    limit: int = Query(default=500, ge=1, le=2000),
    user: AuthUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Per-member metrics for one run, filtered and sorted."""
    if sort not in MEMBER_SORT_FIELDS:
        raise HTTPException(status_code=422, detail=f"sort must be one of: {', '.join(sorted(MEMBER_SORT_FIELDS))}")
    run = await _resolve_analytics_run(run_id)
    metrics = await _db().member_metrics_for_run(run.run_id)

    if not include_service:
        metrics = [m for m in metrics if not m.service_or_admin]
    if not include_unmatched:
        metrics = [m for m in metrics if m.roster_member]
    if organization:
        metrics = [m for m in metrics if organization in m.organizations]
    if search:
        needle = search.strip().lower()
        metrics = [
            m for m in metrics
            if needle in " ".join(filter(None, [m.login, m.name, m.email])).lower()
        ]

    if sort == "name":
        metrics.sort(key=lambda m: (m.name or m.login).lower())
    else:
        # Service accounts and unmatched identities rank below roster members
        # regardless of volume, matching the collector's own ordering.
        metrics.sort(key=lambda m: (m.service_or_admin, not m.roster_member, -(getattr(m, sort) or 0), m.login.lower()))

    return {
        "run": _run_meta(run),
        "count": len(metrics),
        "members": [_member_row(m) for m in metrics[:limit]],
        "disclaimer": _ANALYTICS_DISCLAIMER,
    }


@router.get("/analytics/members/{login:path}")
async def analytics_member_detail(
    login: str,
    run_id: str | None = Query(default=None),
    user: AuthUser = Depends(get_current_user),
) -> dict[str, Any]:
    """One identity's full metrics for a run."""
    run = await _resolve_analytics_run(run_id)
    metric = await _db().member_metric(run.run_id, login)
    if metric is None:
        raise HTTPException(status_code=404, detail=f"member '{login}' not found in run {run.run_id}")
    return {"run": _run_meta(run), "member": _member_row(metric), "disclaimer": _ANALYTICS_DISCLAIMER}


@router.get("/analytics/organizations")
async def analytics_organizations(
    run_id: str | None = Query(default=None),
    user: AuthUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Organization rollups, including orgs that hold no repositories."""
    run = await _resolve_analytics_run(run_id)
    metrics = await _db().member_metrics_for_run(run.run_id)
    rows = []
    for organization in run.organizations:
        name = organization.organization
        members = [m for m in metrics if name in m.organizations]
        # "Active members" counts people, so it excludes service accounts and
        # unmatched commit identities (which may duplicate a roster member
        # rather than be another person). This matches /analytics/summary.
        roster = [m for m in members if m.roster_member and not m.service_or_admin]
        repos = [repo for repo in run.repositories if repo.organization == name]
        # Activity is counted against *this* organization's repositories. A
        # member of several orgs would otherwise be reported active here on
        # the strength of work done elsewhere -- which is how an organization
        # holding no repositories at all ends up with "active" members.
        prefix = f"{name}/"
        active_here = sum(
            1 for m in roster
            if any(repo.startswith(prefix) for repo in m.repositories)
        )
        rows.append({
            "organization": name,
            "roster": organization.member_count,
            "repositories": organization.repository_count,
            "active_members": active_here,
            "unmatched_identities": sum(1 for m in members if not m.roster_member),
            "branches": sum(repo.branch_count for repo in repos),
            "commits": sum(repo.commit_count for repo in repos),
            "pull_requests": sum(repo.pull_count for repo in repos),
            "merged_pull_requests": sum(repo.merged_count for repo in repos),
            "issues": sum(repo.issue_count for repo in repos),
            "blame_lines": _sum_available(m.blame_lines for m in members),
        })
    rows.sort(key=lambda row: (-row["commits"], row["organization"].lower()))
    return {"run": _run_meta(run), "organizations": rows, "disclaimer": _ANALYTICS_DISCLAIMER}


@router.get("/analytics/repositories")
async def analytics_repositories(
    run_id: str | None = Query(default=None),
    organization: str | None = Query(default=None),
    user: AuthUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Repository rollups for one run."""
    run = await _resolve_analytics_run(run_id)
    repos = run.repositories
    if organization:
        repos = [repo for repo in repos if repo.organization == organization]
    rows = [repo.model_dump(mode="json", exclude_none=True) for repo in repos]
    rows.sort(key=lambda row: (-row.get("commit_count", 0), row.get("name", "").lower()))
    return {"run": _run_meta(run), "repositories": rows, "disclaimer": _ANALYTICS_DISCLAIMER}


# ---------------------------------------------------------------------------
# Recruiting signal pipeline
# ---------------------------------------------------------------------------


def _recruiting_run_meta(run: Any) -> dict[str, Any]:
    return {
        "run_id": run.run_id,
        "generated_at": run.generated_at,
        "model": run.model,
        "signal_version": run.signal_version,
        "member_analytics_run_id": run.member_analytics_run_id,
        "people_portal_source_run_id": run.people_portal_source_run_id,
        "candidate_count": run.candidate_count,
        "reviewed_count": run.reviewed_count,
        "llm_used": run.llm_used,
        "source_warnings": run.source_warnings,
        "excluded_candidates": run.excluded_candidates,
        "needs_review_count": run.needs_review_count,
        "ranking_source": run.scoring_policy.get("ranking_source") if run.scoring_policy else None,
        "people_portal_source_system": run.scoring_policy.get("people_portal_source_system") if run.scoring_policy else None,
        "ranking_rubric_version": run.scoring_policy.get("rubric_version") if run.scoring_policy else None,
        "ranking_status": run.scoring_policy.get("ranking_status") if run.scoring_policy else None,
    }


def _recruiting_signal_list_item(signal: Any) -> dict[str, Any]:
    ranking = signal.source_candidate.ranking if signal.source_candidate else None
    return {
        "member_login": signal.member_login,
        "member_name": signal.member_name,
        "provisional_rank": signal.provisional_rank,
        "provisional_score": signal.provisional_score,
        # The product intentionally exposes one signal category. Keep the
        # persisted enum backward-compatible for old runs, but normalize every
        # API response to the current label.
        "signal_band": signal.signal_band.value,
        "contribution_score": signal.contribution_score,
        "ability_score": signal.ability_score,
        "resume_score": signal.resume_score,
        "interview_score": signal.interview_score,
        "evidence_quality_score": signal.evidence_quality_score,
        "review_flags": signal.review_flags,
        "review_status": signal.review_status.value,
        "eligibility_status": signal.eligibility_status.value,
        "eligibility_reasons": signal.eligibility_reasons,
        "eligibility_evidence": [ref.model_dump(mode="json") for ref in signal.eligibility_evidence],
        "reviewer_rank": signal.reviewer_rank,
        "evidence_claim_count": len(signal.evidence_claims),
        "resume_evidence_count": 0,
        "interview_evidence_count": 0,
        "ranking": ranking.model_dump(mode="json", exclude_none=True) if ranking else None,
    }


def _recruiting_candidate_payload(candidate: Any, signal: Any, reviews: list[Any]) -> dict[str, Any]:
    latest_review = next((review for review in reviews if review.member_login == signal.member_login), None)
    review_history = [
        {
            "reviewer_user_id": review.reviewer_user_id,
            "decision": review.decision.value,
            "final_rank": review.final_rank,
            "eligibility_decision": review.eligibility_decision,
            "note": review.note,
            "created_at": review.created_at,
        }
        for review in reviews
        if review.member_login == signal.member_login
    ]
    payload = _recruiting_signal_list_item(signal)
    payload.update(
        {
            "run_id": signal.run_id,
            "source_status": candidate.source_status if candidate else "missing",
            "applicant_id": candidate.applicant_id if candidate else None,
            "member_stats": candidate.member_stats.model_dump(mode="json", exclude_none=False) if candidate else {},
            "interview": {
                "score": candidate.interview_score if candidate else None,
                "summary": candidate.interview_summary if candidate else None,
                "evidence": list(candidate.interview_evidence) if candidate else [],
            },
            "resume": {
                "summary": candidate.resume_summary if candidate else None,
                "evidence": list(candidate.resume_evidence) if candidate else [],
            },
            "context_excluded_from_score": {
                "prior_employers": list(candidate.prior_employers) if candidate else [],
                "prior_employment_evidence": [
                    item.model_dump(mode="json") for item in candidate.prior_employment_evidence
                ] if candidate else [],
                "note": "Employer context is for human review only and does not determine automated eligibility or scores.",
            },
            "eligibility": {
                "status": signal.eligibility_status.value,
                "reasons": signal.eligibility_reasons,
                "evidence": [ref.model_dump(mode="json") for ref in signal.eligibility_evidence],
                "reviewed_by": signal.eligibility_reviewed_by,
                "reviewed_at": signal.eligibility_reviewed_at,
            },
            "score_breakdown": signal.score_breakdown,
            "ranking": signal.source_candidate.ranking.model_dump(mode="json", exclude_none=True)
            if signal.source_candidate and signal.source_candidate.ranking else None,
            "evidence_quality_score": signal.evidence_quality_score,
            "evidence_claims": [claim.model_dump(mode="json") for claim in signal.evidence_claims],
            "contradictions": signal.contradictions,
            "duplicate_flags": signal.duplicate_flags,
            "review_flags": signal.review_flags,
            "rationale": signal.rationale,
            "strengths": signal.strengths,
            "caveats": signal.caveats,
            "evidence_refs": [ref.model_dump(mode="json") for ref in signal.evidence_refs],
            "human_review": {
                "decision": latest_review.decision.value if latest_review else None,
                "final_rank": latest_review.final_rank if latest_review else signal.reviewer_rank,
                "note": latest_review.note if latest_review else signal.reviewer_note,
                "reviewer_user_id": latest_review.reviewer_user_id if latest_review else signal.reviewed_by,
                "created_at": latest_review.created_at if latest_review else signal.reviewed_at,
            },
            "review_history": review_history,
        }
    )
    payload["resume_evidence_count"] = len(payload["resume"]["evidence"])
    payload["interview_evidence_count"] = len(payload["interview"]["evidence"])
    return payload


async def _get_recruiting_run(run_id: str | None) -> Any:
    database = _db()
    run = await (database.recruiting_run(run_id) if run_id else database.latest_recruiting_run())
    if run is None:
        raise HTTPException(
            status_code=404,
            detail=f"recruiting run '{run_id}' not found" if run_id else "no recruiting run has been generated",
        )
    return run


async def _recruiting_context(run: Any) -> tuple[list[Any], dict[str, Any], list[Any]]:
    database = _db()
    signals = await database.recruiting_signals_for_run(run.run_id)
    if all(signal.source_candidate is not None for signal in signals):
        sources = {signal.member_login: signal.source_candidate for signal in signals}
        return signals, sources, await database.recruiting_reviews_for_run(run.run_id)
    source_rows = await database.recruiting_source_candidates(run.people_portal_source_run_id) if run.people_portal_source_run_id else []
    by_login = {row.member_login: row for row in source_rows}
    if run.member_analytics_run_id:
        analytics_members = await database.member_metrics_for_run(run.member_analytics_run_id)
        for member in analytics_members:
            if member.login in by_login or member.service_or_admin or not member.roster_member:
                continue
            by_login[member.login] = RecruitingSourceCandidateDocument(
                id=new_id(),
                source_run_id="people-portal-not-ingested",
                source_generated_at=run.generated_at,
                member_login=member.login,
                member_name=member.name or member.login,
                email=member.email,
                member_stats=RecruitingMemberStats(
                    commits=member.commits,
                    additions=member.additions,
                    unique_files=member.unique_files,
                    pulls_opened=member.pulls_opened,
                    pulls_merged=member.pulls_merged,
                    reviews_submitted=member.reviews_submitted,
                    reviews_approved=member.reviews_approved,
                    issues_opened=member.issues_opened,
                    active_days=member.active_days,
                    blame_lines=member.blame_lines,
                    repositories=list(member.repositories),
                ),
                source_status="missing",
            )
    reviews = await database.recruiting_reviews_for_run(run.run_id)
    return signals, by_login, reviews


def _recruiting_audit_payload(run: Any, signals: list[Any], sources: dict[str, Any], reviews: list[Any]) -> dict[str, Any]:
    """Build reviewer-facing quality and calibration facts for one run.

    These metrics describe coverage and reviewer consistency. They are not
    fed back into the candidate ordering and do not create a new talent score.
    """

    review_groups: dict[str, list[Any]] = {}
    for review in reviews:
        review_groups.setdefault(review.member_login, []).append(review)
    for group in review_groups.values():
        group.sort(key=lambda review: review.created_at, reverse=True)

    def has_stats(candidate: Any) -> bool:
        stats = candidate.member_stats if candidate else None
        if not stats:
            return False
        return bool(
            stats.commits
            or stats.additions
            or stats.unique_files
            or stats.pulls_opened
            or stats.pulls_merged
            or stats.reviews_submitted
            or stats.reviews_approved
            or stats.issues_opened
            or stats.active_days
            or stats.blame_lines
            or stats.repositories
        )

    source_values = [sources.get(signal.member_login) for signal in signals]
    with_stats = sum(1 for source in source_values if has_stats(source))
    with_portal = sum(1 for source in source_values if source and source.source_status == "complete")
    with_partial_portal = sum(1 for source in source_values if source and source.source_status not in {"complete", "missing"})
    missing_evidence = len(signals) - with_stats - with_portal + sum(
        1 for source in source_values if source and source.source_status == "complete" and has_stats(source)
    )
    independent_reviews = []
    for group in review_groups.values():
        by_reviewer = {}
        for review in group:
            by_reviewer.setdefault(review.reviewer_user_id, review)
        independent_reviews.append(list(by_reviewer.values()))
    multi_review_groups = [group for group in independent_reviews if len(group) >= 2]
    agreement_groups = [group for group in multi_review_groups if len({review.decision.value for review in group}) == 1]
    disagreement_groups = [group for group in multi_review_groups if len({review.decision.value for review in group}) > 1]
    decision_counts = {decision.value: 0 for decision in RecruitingDecision}
    for review in reviews:
        decision_counts[review.decision.value] = decision_counts.get(review.decision.value, 0) + 1

    flags: list[str] = []
    if not multi_review_groups:
        flags.append("No candidate has been reviewed by a second reviewer yet.")
    if disagreement_groups:
        flags.append(f"{len(disagreement_groups)} candidate review group(s) contain different decisions and need calibration.")
    if missing_evidence:
        flags.append(f"{missing_evidence} candidate(s) have incomplete observable evidence coverage.")
    if run.source_warnings:
        flags.append("The source run has warnings; reviewers should inspect coverage before relying on the ordering.")

    review_total = len(reviews)
    return {
        "purpose": "Review coverage, evidence completeness, and reviewer consistency; never a candidate score.",
        "coverage": {
            "candidate_count": len(signals),
            "with_observable_stats": with_stats,
            "with_complete_people_portal": with_portal,
            "with_partial_people_portal": with_partial_portal,
            "incomplete_evidence": max(0, missing_evidence),
            "reviewed_candidates": sum(1 for signal in signals if signal.review_status != RecruitingReviewStatus.PENDING),
            "review_completion_pct": round(100 * sum(1 for signal in signals if signal.review_status != RecruitingReviewStatus.PENDING) / len(signals), 1) if signals else 0.0,
        },
        "calibration": {
            "review_count": review_total,
            "reviewer_count": len({review.reviewer_user_id for review in reviews}),
            "multi_reviewer_candidates": len(multi_review_groups),
            "agreement_candidates": len(agreement_groups),
            "disagreement_candidates": len(disagreement_groups),
            "agreement_rate_pct": round(100 * len(agreement_groups) / len(multi_review_groups), 1) if multi_review_groups else None,
            "decision_counts": decision_counts,
        },
        "flags": flags,
        "recent_reviews": [
            {
                "member_login": review.member_login,
                "reviewer_user_id": review.reviewer_user_id,
                "decision": review.decision.value,
                "final_rank": review.final_rank,
                "note": review.note,
                "created_at": review.created_at,
            }
            for review in sorted(reviews, key=lambda item: item.created_at, reverse=True)[:20]
        ],
        "methodology": {
            "stats": "Use repository metrics as descriptive discovery evidence with coverage warnings and project context.",
            "llm": "Extract source-backed claims and caveats only; it cannot change numeric components or ordering.",
            "human_gate": "Only an explicit human confirm or adjust review can make a candidate eligible for the shortlist endpoint.",
            "excluded": list((run.scoring_policy or {}).get("excluded_from_score", [])),
        },
    }


@router.get("/recruiting/runs")
async def recruiting_runs(user: AuthUser = Depends(get_current_user)) -> dict[str, Any]:
    runs = await _db().list("recruiting_runs")
    runs.sort(key=lambda run: (run.generated_at, run.run_id), reverse=True)
    return {"runs": [_recruiting_run_meta(run) for run in runs], "signal_version": RECRUITING_VERSION}


@router.get("/recruiting/audit")
async def recruiting_audit(
    run_id: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(Role.ADMIN, Role.PORTFOLIO_LEADER)),
) -> dict[str, Any]:
    """Return evidence coverage and reviewer calibration facts for a run."""

    run = await _get_recruiting_run(run_id)
    signals, sources, reviews = await _recruiting_context(run)
    return {"run": _recruiting_run_meta(run), "audit": _recruiting_audit_payload(run, signals, sources, reviews)}


@router.get("/recruiting/overview")
async def recruiting_overview(
    run_id: str | None = Query(default=None),
    user: AuthUser = Depends(get_current_user),
) -> dict[str, Any]:
    run = await _get_recruiting_run(run_id)
    signals, by_login, reviews = await _recruiting_context(run)
    candidates = []
    for signal in signals:
        item = _recruiting_signal_list_item(signal)
        source = by_login.get(signal.member_login)
        item["source_status"] = source.source_status if source else "missing"
        item["resume_evidence_count"] = len(source.resume_evidence) if source else 0
        item["interview_evidence_count"] = len(source.interview_evidence) if source else 0
        candidates.append(item)
    reviewed_count = sum(1 for signal in signals if signal.review_status != RecruitingReviewStatus.PENDING)
    return {
        "run": _recruiting_run_meta(run),
        "summary": {
            "candidate_count": len(signals),
            "reviewed_count": reviewed_count,
            "pending_count": len(signals) - reviewed_count,
            "underrated_count": sum(signal.provisional_score is not None for signal in signals),
            "confirmed_count": sum(1 for signal in signals if signal.review_status == RecruitingReviewStatus.CONFIRMED),
        },
        "policy": run.scoring_policy,
        "candidates": candidates,
        "review_count": len(reviews),
    }


@router.get("/recruiting/shortlist")
async def recruiting_shortlist(
    run_id: str | None = Query(default=None),
    user: AuthUser = Depends(require_roles(Role.ADMIN, Role.PORTFOLIO_LEADER)),
) -> dict[str, Any]:
    """Return only candidates with an explicit human confirmation or adjustment."""
    run = await _get_recruiting_run(run_id)
    signals, by_login, reviews = await _recruiting_context(run)
    reviewed = [
        signal for signal in signals
        if signal.review_status in {RecruitingReviewStatus.CONFIRMED, RecruitingReviewStatus.ADJUSTED}
        and signal.eligibility_status == RecruitingEligibilityStatus.ELIGIBLE
        and signal.eligibility_reviewed_by is not None
    ]
    reviewed.sort(key=lambda signal: (signal.reviewer_rank or signal.provisional_rank or 10**9, signal.member_login.lower()))
    return {
        "run": _recruiting_run_meta(run),
        "ready": bool(reviewed),
        "candidates": [
            {
                "member_login": signal.member_login,
                "member_name": signal.member_name,
                "final_rank": signal.reviewer_rank or signal.provisional_rank,
                "review_status": signal.review_status.value,
                "provisional_score": signal.provisional_score,
                "rationale": signal.rationale,
                "strengths": signal.strengths,
                "reviewer_note": signal.reviewer_note,
                "evidence_refs": [ref.model_dump(mode="json") for ref in signal.evidence_refs],
                "source_status": by_login.get(signal.member_login).source_status if by_login.get(signal.member_login) else "missing",
            }
            for signal in reviewed
        ],
        "excluded_candidates": run.excluded_candidates,
        "note": "Human-reviewed discovery queue only; no final employment decisions are made by Horizon.",
    }


@router.get("/recruiting/candidates/{member_login:path}")
async def recruiting_candidate_detail(
    member_login: str,
    run_id: str | None = Query(default=None),
    user: AuthUser = Depends(get_current_user),
) -> dict[str, Any]:
    run = await _get_recruiting_run(run_id)
    signals, by_login, reviews = await _recruiting_context(run)
    signal = next((row for row in signals if row.member_login == member_login), None)
    if signal is None:
        raise HTTPException(status_code=404, detail=f"candidate '{member_login}' not found in run {run.run_id}")
    return {"run": _recruiting_run_meta(run), "candidate": _recruiting_candidate_payload(by_login.get(member_login), signal, reviews)}


@router.post("/recruiting/run")
async def create_recruiting_run(user: AuthUser = Depends(require_roles(Role.ADMIN, Role.PORTFOLIO_LEADER))) -> dict[str, Any]:
    settings = get_settings()
    run = await run_recruiting_pipeline(
        _db(),
        settings=settings,
        judge=_get_recruiting_judge(settings),
    )
    if run is None:
        raise HTTPException(status_code=503, detail="no Gitea member analytics run is available")
    return {"run": _recruiting_run_meta(run)}


@router.post("/recruiting/reviews", status_code=status.HTTP_201_CREATED)
async def create_recruiting_review(
    request: RecruitingReviewRequest,
    user: AuthUser = Depends(require_recruiting_reviewer),
) -> dict[str, Any]:
    async with _db().transaction():
        run = await _get_recruiting_run(request.run_id)
        signal = await _db().recruiting_signal(request.run_id, request.member_login)
        if signal is None:
            raise HTTPException(status_code=404, detail="candidate signal not found for recruiting run")
        if request.decision == RecruitingDecision.ADJUST and request.final_rank is None:
            raise HTTPException(status_code=422, detail="final_rank is required when adjusting a rank")
        if request.decision in {RecruitingDecision.ADJUST, RecruitingDecision.DEFER} and not (request.note or "").strip():
            raise HTTPException(status_code=422, detail="a note is required when adjusting or deferring a signal")
        if request.eligibility_decision is not None and not (request.note or "").strip():
            raise HTTPException(status_code=422, detail="a note is required for an eligibility decision")
        if request.final_rank is not None and request.final_rank > run.candidate_count:
            raise HTTPException(status_code=422, detail="final_rank exceeds the candidate count")
        if request.decision == RecruitingDecision.CONFIRM and signal.provisional_rank is None:
            raise HTTPException(status_code=422, detail="missing evidence has no provisional rank; defer or supply a reviewed adjustment")
        if request.decision == RecruitingDecision.CONFIRM and request.final_rank not in {None, signal.provisional_rank}:
            raise HTTPException(status_code=422, detail="use adjust to change the provisional rank")
        final_rank = request.final_rank if request.decision == RecruitingDecision.ADJUST else signal.provisional_rank if request.decision == RecruitingDecision.CONFIRM else None
        if final_rank is not None:
            for other in await _db().recruiting_signals_for_run(run.run_id):
                if other.member_login != signal.member_login and other.reviewer_rank == final_rank:
                    raise HTTPException(status_code=409, detail="reviewed rank already assigned; resolve the ordering first")
        review = RecruitingReviewDocument(
            id=new_id(),
            run_id=run.run_id,
            member_login=signal.member_login,
            reviewer_user_id=user.subject,
            decision=request.decision,
            final_rank=final_rank,
            eligibility_decision=request.eligibility_decision,
            note=request.note,
            created_at=datetime.now(timezone.utc),
        )
        await _db().add("recruiting_reviews", review)
        signal.review_status = {
            RecruitingDecision.CONFIRM: RecruitingReviewStatus.CONFIRMED,
            RecruitingDecision.ADJUST: RecruitingReviewStatus.ADJUSTED,
            RecruitingDecision.DEFER: RecruitingReviewStatus.DEFERRED,
        }[request.decision]
        signal.reviewer_rank = final_rank
        signal.reviewer_note = request.note
        signal.reviewed_by = user.subject
        signal.reviewed_at = review.created_at
        if request.eligibility_decision is not None:
            signal.eligibility_status = request.eligibility_decision
            signal.eligibility_reviewed_by = user.subject
            signal.eligibility_reviewed_at = review.created_at
        await _db().replace(signal)
        signals = await _db().recruiting_signals_for_run(run.run_id)
        run.reviewed_count = sum(1 for item in signals if item.review_status != RecruitingReviewStatus.PENDING)
        await _db().replace(run)
        audit = AuditLogDocument.model_construct(
            actor_user_id=user.subject,
            action="recruiting.review.created",
            target_type="recruiting_signal",
            target_id=f"{run.run_id}:{signal.member_login}",
            after={
                "run_id": run.run_id,
                "member_login": signal.member_login,
                "decision": request.decision.value,
                "final_rank": final_rank,
                "eligibility_decision": request.eligibility_decision.value if request.eligibility_decision else None,
            },
            at=review.created_at,
        )
        await _db().add("audit_log", audit)
        return {"review": review.public_dump(), "candidate": _recruiting_candidate_payload((await _recruiting_context(run))[1].get(signal.member_login), signal, await _db().recruiting_reviews_for_run(run.run_id))}


@router.post("/recruiting/people-portal-source")
async def ingest_recruiting_people_portal_source(
    request: RecruitingSourceRequest,
    user: AuthUser = Depends(require_roles(Role.ADMIN)),
) -> dict[str, Any]:
    """Local/service-facing source ingest; production should protect this route with service auth."""
    try:
        return await persist_people_portal_payload(_db(), request.payload, source_run_id=request.source_run_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
