"""Aggregate-only local fixtures for running the disconnected UI against FastAPI."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

import uuid

from .ci_agent import CIEvidence, CheckResult, assess_project, assessment_document, normalize_spec
from .config import get_settings
from .db import get_db_state, init_db
from .models import (
    AggregateMetrics,
    AttentionStatus,
    AuditLogDocument,
    BoundaryDocument,
    EvidenceReference,
    FeedbackCategory,
    FeedbackDocument,
    IdentityMapDocument,
    LifecycleState,
    ProjectDocument,
    RepoActivityDocument,
    RepositoryRef,
    WarningDocument,
    WarningEvidenceItem,
    WarningSeverity,
    WeeklySnapshotDocument,
)

WEEK_START = date(2026, 8, 3)
WEEK_END = date(2026, 8, 9)
GENERATED_AT = datetime(2026, 8, 3, 13, 34, tzinfo=timezone.utc)
LAST_SYNC = datetime(2026, 8, 3, 13, 8, tzinfo=timezone.utc)


def _oid(number: int) -> str:
    """Return a deterministic UUID string from an integer seed."""
    return str(uuid.UUID(int=number))


def _doc(model: Any, **values: Any) -> Any:
    """Construct documents without full validation (for seeding only)."""
    return model.model_construct(**values)


def _demo_assessment(spec: dict[str, Any], index: int) -> Any:
    """Create deterministic, inspectable week-three CI health evidence."""

    week = 3
    plan = normalize_spec(
        {
            "project_id": spec["id"],
            "version": "appdev-plan-v1",
            "lifecycle_weeks": 12,
            "weeks": [
                {
                    "week": week,
                    "title": "Core milestone",
                    "milestone": "Core flow ready for review",
                    "tasks": [
                        "Implement the core user flow",
                        "Connect the project data boundary",
                        "Validate the primary acceptance path",
                    ],
                    "acceptance_criteria": [
                        "Primary flow is testable",
                        "Project data boundary is documented",
                    ],
                    "artifacts": ["Milestone notes and test evidence"],
                }
            ],
        }
    )
    expected_criteria = [chunk.content for chunk in plan.chunks if chunk.kind == "acceptance"]
    status = spec["status"]
    if status == AttentionStatus.PLANNED_PAUSE:
        evidence = CIEvidence(project_id=spec["id"], commit_sha=f"seed-{index:02d}-pause", expected_week=week, observed_at=GENERATED_AT, planned_pause=True)
    elif status == AttentionStatus.INSUFFICIENT_DATA:
        evidence = CIEvidence(project_id=spec["id"], commit_sha=f"seed-{index:02d}-insufficient", expected_week=week, observed_at=GENERATED_AT)
    elif status == AttentionStatus.AT_RISK:
        evidence = CIEvidence(
            project_id=spec["id"], commit_sha=f"seed-{index:02d}-risk", branch="main", expected_week=week,
            changed_files=["src/core-flow.ts", "tests/core-flow.test.ts"], tests_total=12, tests_passed=8, tests_failed=4,
            coverage_pct=48, check_results=[CheckResult(name="required-checks", status="failed", detail="Acceptance checks are incomplete")],
            scope_change_count=5, docs_updated=False, observed_at=GENERATED_AT,
        )
    elif status == AttentionStatus.WATCH:
        evidence = CIEvidence(
            project_id=spec["id"], commit_sha=f"seed-{index:02d}-watch", branch="main", expected_week=week,
            changed_files=["src/core-flow.ts"], tests_total=12, tests_passed=11, tests_failed=1, coverage_pct=68,
            acceptance_criteria_refs=expected_criteria[:1], check_results=[CheckResult(name="required-checks", status="passed")],
            scope_change_count=2, docs_updated=True, observed_at=GENERATED_AT,
        )
    else:
        evidence = CIEvidence(
            project_id=spec["id"], commit_sha=f"seed-{index:02d}-clear", branch="main", expected_week=week,
            changed_files=["src/core-flow.ts", "tests/core-flow.test.ts"], tests_total=12, tests_passed=12, tests_failed=0,
            coverage_pct=88, milestone_refs=["core-flow-ready"], acceptance_criteria_refs=expected_criteria,
            artifact_refs=["milestone-notes"], check_results=[CheckResult(name="required-checks", status="passed")],
            scope_change_count=1, docs_updated=True, observed_at=GENERATED_AT,
        )
    assessment = assess_project(plan, evidence)
    assessment.created_at = GENERATED_AT
    return assessment_document(assessment)


def _specs() -> list[dict[str, Any]]:
    common: dict[str, Any] = {}
    return [
        dict(id="member-portal", name="Member Portal", short="MP", team="Product Experience", repo="member-portal", status=AttentionStatus.AT_RISK, signal="PR review queue is aging", detail="4 PRs · oldest 18 days", last="Yesterday", lifecycle=LifecycleState.ACTIVE, root="product-experience", subteams=["member-portal-core", "growth"], repos=["member-portal", "member-portal-api"], owner="priya-n", metrics=dict(active_days=1, days_since_activity=1, open_prs=4, oldest_open_pr_days=18, review_latency_days=5.4, merged_count=1, active_contributors=2, team_size=8), series=dict(activity=[6, 5, 5, 4, 4, 2, 1, 1], open_prs=[1, 1, 2, 2, 2, 3, 3, 4], review_latency=[2.1, 2.4, 2.8, 3.1, 3.4, 4.3, 4.9, 5.4], contributors=[5, 5, 4, 4, 3, 3, 2, 2]), baselines=dict(open_prs=[1, 4], review_latency=[2.1, 5.4], contributors=[5, 2]), warnings=[("open_pr_aging", "Pull requests aging", "open_prs", 4, 1, WarningSeverity.CRITICAL), ("activity_decline", "Activity below baseline", "active_days", 1, 4, WarningSeverity.WARNING), ("contributor_resilience", "Concentrated contributors", "active_contributors", 2, 5, WarningSeverity.WARNING)], **common),
        dict(id="campus-events", name="Campus Events", short="CE", team="Community Programs", repo="campus-events", status=AttentionStatus.WATCH, signal="Review latency is rising", detail="6.2 days · +2.1 vs baseline", last="Today", lifecycle=LifecycleState.ACTIVE, root="community-programs", subteams=["events-ops"], repos=["campus-events"], owner="marcus-t", metrics=dict(active_days=4, days_since_activity=0, open_prs=2, oldest_open_pr_days=6, review_latency_days=6.2, merged_count=3, active_contributors=4, team_size=7), series=dict(activity=[4, 4, 4, 5, 4, 3, 3, 4], open_prs=[2, 2, 2, 1, 2, 2, 2, 2], review_latency=[4.1, 4.0, 4.3, 4.5, 4.8, 5.2, 5.8, 6.2], contributors=[4, 4, 4, 5, 4, 4, 4, 4]), baselines=dict(open_prs=[2, 3], review_latency=[4.1, 6.2], contributors=[4, 4]), warnings=[("review_latency", "Review latency rising", "review_latency_days", 6.2, 4.1, WarningSeverity.WARNING)], **common),
        dict(id="design-system", name="Design System", short="DS", team="Platform Experience", repo="design-system", status=AttentionStatus.WATCH, signal="Contributor count dipped", detail="3 → 1 active contributors", last="2 days ago", lifecycle=LifecycleState.ACTIVE, root="platform-experience", subteams=["design-systems-guild"], repos=["design-system", "design-tokens"], owner="alex-r", metrics=dict(active_days=2, days_since_activity=2, open_prs=1, oldest_open_pr_days=2, review_latency_days=1.8, merged_count=1, active_contributors=1, team_size=6), series=dict(activity=[5, 5, 5, 4, 4, 3, 2, 2], open_prs=[1, 1, 1, 1, 1, 1, 1, 1], review_latency=[1.8, 1.8, 1.9, 1.7, 1.8, 1.8, 1.7, 1.8], contributors=[3, 3, 3, 2, 2, 2, 1, 1]), baselines=dict(open_prs=[1, 1], review_latency=[1.8, 1.8], contributors=[3, 1]), warnings=[("contributor_resilience", "Contributor count dipped", "active_contributors", 1, 3, WarningSeverity.WARNING)], **common),
        dict(id="alumni-network", name="Alumni Network", short="AN", team="Community Programs", repo="alumni-network", status=AttentionStatus.CLEAR, signal="No current concern detected", detail="12 active days · steady flow", last="Today", lifecycle=LifecycleState.ACTIVE, root="community-programs", subteams=["alumni-relations"], repos=["alumni-network"], owner="marcus-t", metrics=dict(active_days=12, days_since_activity=0, open_prs=1, oldest_open_pr_days=1, review_latency_days=1.2, merged_count=4, active_contributors=5, team_size=8), series=dict(activity=[4, 4, 5, 5, 6, 7, 7, 7], open_prs=[1, 1, 1, 1, 1, 1, 1, 1], review_latency=[1.5, 1.5, 1.4, 1.4, 1.5, 1.3, 1.3, 1.2], contributors=[4, 4, 4, 4, 4, 5, 5, 5]), baselines=dict(open_prs=[1, 2], review_latency=[1.5, 1.2], contributors=[4, 5]), warnings=[], **common),
        dict(id="onboarding", name="Onboarding Refresh", short="OR", team="People Operations", repo="onboarding-refresh", status=AttentionStatus.CLEAR, signal="No current concern detected", detail="9 active days · 3 PRs merged", last="Today", lifecycle=LifecycleState.ACTIVE, root="people-operations", subteams=["member-experience"], repos=["onboarding-refresh"], owner="priya-n", metrics=dict(active_days=9, days_since_activity=0, open_prs=1, oldest_open_pr_days=1, review_latency_days=.9, merged_count=3, active_contributors=3, team_size=5), series=dict(activity=[3, 3, 4, 4, 4, 5, 5, 6], open_prs=[1, 1, 1, 1, 1, 1, 1, 1], review_latency=[1.1, 1.1, 1.0, 1.0, 1.0, .9, .9, .9], contributors=[2, 2, 2, 2, 2, 3, 3, 3]), baselines=dict(open_prs=[1, 1], review_latency=[1.1, .9], contributors=[2, 3]), warnings=[], **common),
        dict(id="mobile-lab", name="Mobile Lab", short="ML", team="Innovation Studio", repo="mobile-lab", status=AttentionStatus.INSUFFICIENT_DATA, signal="Repository mapping incomplete", detail="Ownership review required", last="11 days ago", lifecycle=LifecycleState.NEW, root="innovation-studio", subteams=["mobile-spikes"], repos=["mobile-lab", "mobile-lab-experiments (unmapped)"], owner=None, metrics=dict(active_days=1, days_since_activity=11, data_completeness_pct=62), series=dict(activity=[2, 1, None, None, 2, None, None, 1], open_prs=[None] * 8, review_latency=[None] * 8, contributors=[None] * 8), baselines=dict(open_prs=[None, None], review_latency=[None, None], contributors=[None, None]), warnings=[], completeness=62, **common),
        dict(id="winter-campaign", name="Winter Campaign", short="WC", team="Marketing", repo="winter-campaign", status=AttentionStatus.PLANNED_PAUSE, signal="Inactivity is expected", detail="Pause recorded through Aug 20", last="16 days ago", lifecycle=LifecycleState.PAUSED, root="marketing", subteams=[], repos=["winter-campaign"], owner="sam-d", metrics=dict(active_days=0, days_since_activity=16, open_prs=0, merged_count=0), series=dict(activity=[4, 3, 1, 0, 0, 0, 0, 0], open_prs=[1, 1, 0, 0, 0, 0, 0, 0], review_latency=[None] * 8, contributors=[None] * 8), baselines=dict(open_prs=[1, 0], review_latency=[None, None], contributors=[None, None]), warnings=[], **common),
    ]


async def seed_demo_data() -> dict[str, str]:
    settings = get_settings()
    try:
        state = get_db_state()
    except RuntimeError:
        await init_db(settings)
        state = get_db_state()
    repository = state.store
    existing = await repository.list("projects")
    if existing:
        existing_project_ids = {project.project_id for project in existing}
        existing_assessments = await repository.list("assessments")
        assessed_project_ids = {assessment.project_id for assessment in existing_assessments}
        for index, spec in enumerate(_specs(), start=1):
            if spec["id"] in existing_project_ids and spec["id"] not in assessed_project_ids:
                await repository.insert(_demo_assessment(spec, index))
        return {"status": "already_seeded"}
    await repository.insert(_doc(IdentityMapDocument))
    first_snapshot = ""
    for index, spec in enumerate(_specs(), start=1):
        project = _doc(ProjectDocument, project_id=spec["id"], display_name=spec["name"], lifecycle_state=spec["lifecycle"], data_owner_user_id=spec["owner"], non_goals_ack=True)
        boundary = _doc(BoundaryDocument, project_id=spec["id"], root_authentik_team_id=spec["root"], included_subteam_ids=spec["subteams"], primary_repos=[RepositoryRef(gitea_repo_id=repo, repo_slug=repo) for repo in spec["repos"] if "unmapped" not in repo], effective_from=WEEK_START if spec["id"] == "mobile-lab" else date(2026, 1, 1), data_owner_user_id=spec["owner"], created_by="seed")
        completeness = spec.get("completeness", 97)
        activity = _doc(RepoActivityDocument, id=_oid(1000 + index), project_id=spec["id"], gitea_repo_id=f"repo-{spec['id']}", repo_slug=spec["repo"], window_start=WEEK_START, window_end=WEEK_END, synced_at=LAST_SYNC, **{key: value for key, value in spec["metrics"].items() if key in RepoActivityDocument.model_fields and key != "data_completeness_pct"}, data_completeness_pct=completeness, last_sync_at=LAST_SYNC)
        snapshot_id = _oid(index)
        warning_ids: list[str] = []
        for warning_index, (rule_id, title, metric, current, baseline, severity) in enumerate(spec["warnings"], start=1):
            warning_id = _oid(index * 100 + warning_index)
            warning_ids.append(warning_id)
            evidence = WarningEvidenceItem(evidence_type="metric", icon="pull" if "PR" in title or "review" in title.lower() else "users" if "contributor" in title.lower() else "activity", title=title, metric=metric, unit="d" if "latency" in title.lower() else "", current=current, baseline=baseline, source_refs=[EvidenceReference(source_collection="repo_activity", source_id=str(activity.id), source_field=metric, observed_at=LAST_SYNC)])
            warning = _doc(WarningDocument, id=warning_id, snapshot_id=snapshot_id, project_id=spec["id"], rule_id=rule_id, rule_version=settings.rule_set_version, signal_name=title, current_value=current, baseline_value=baseline, time_window="trailing 8 weeks", trigger_threshold="project baseline deviation", severity=severity, explanation=f"{title} is outside the project's trailing baseline.", caveats=["Conversation prompt only; not an individual performance measure."], data_freshness=LAST_SYNC.isoformat(), data_completeness_pct=completeness, evidence=[evidence])
            await repository.insert(warning)
        metric_values = {key: value for key, value in spec["metrics"].items() if key != "data_completeness_pct"}
        metrics = AggregateMetrics(**metric_values, data_completeness_pct=completeness, last_sync_at=LAST_SYNC)
        baselines = AggregateMetrics(open_prs=spec["baselines"]["open_prs"][0], review_latency_days=spec["baselines"]["review_latency"][0], active_contributors=spec["baselines"]["contributors"][0], team_size=spec["metrics"].get("team_size"), aggregation_floor=settings.aggregation_floor, data_completeness_pct=completeness, last_sync_at=LAST_SYNC)
        snapshot = _doc(WeeklySnapshotDocument, id=snapshot_id, project_id=spec["id"], week_start=WEEK_START, week_end=WEEK_END, rule_set_version=settings.rule_set_version, generated_at=GENERATED_AT, attention_status=spec["status"], data_completeness_pct=completeness, last_sync_at=LAST_SYNC, metrics=metrics, baselines=baselines, warning_ids=warning_ids, series=spec["series"], series_baselines=spec["baselines"])
        assessment = _demo_assessment(spec, index)
        await repository.insert(project)
        await repository.insert(boundary)
        await repository.insert(activity)
        await repository.insert(snapshot)
        await repository.insert(assessment)
        if not first_snapshot:
            first_snapshot = str(snapshot.id)
    feedback = _doc(FeedbackDocument, id=_oid(900), snapshot_id=_oid(1), warning_id=_oid(101), project_id="member-portal", author_user_id="jordan-kim", category=FeedbackCategory.RISK_CONFIRMED, note="Reviewer bandwidth is being backfilled.", created_at=datetime(2026, 7, 27, 15, tzinfo=timezone.utc))
    audit = _doc(AuditLogDocument, actor_user_id="jordan-kim", action="feedback.created", target_type="feedback", target_id=str(feedback.id), after={"project_id": "member-portal", "category": "risk_confirmed"}, at=datetime(2026, 7, 27, 15, tzinfo=timezone.utc))
    await repository.insert(feedback)
    await repository.insert(audit)
    return {"status": "seeded", "snapshot_id": first_snapshot}
