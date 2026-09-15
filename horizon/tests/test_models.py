"""Tests for the Pydantic document and response models in ``backend.models``."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError

from backend import models as models_module
from backend.errors import (
    EvidenceTraceError,
    ImmutableSnapshotError,
    PrivacyViolationError,
)
from backend.models import (
    AggregateMetrics,
    AttentionStatus,
    AuditLogDocument,
    BoundaryView,
    LifecycleState,
    PlannedPause,
    PrivacySafeModel,
    ProjectDocument,
    ProjectResponse,
    PublicAggregateMetrics,
    RepoActivityDocument,
    Role,
    Series,
    SeriesBaselines,
    WarningEvidenceItem,
    WeeklySnapshotDocument,
    new_id,
    utc_now,
)


# ---------------------------------------------------------------------------
# new_id()
# ---------------------------------------------------------------------------


def test_new_id_generates_unique_uuid_strings():
    ids = {new_id() for _ in range(500)}
    assert len(ids) == 500
    for value in list(ids)[:20]:
        assert uuid.UUID(value).version == 4


def test_utc_now_is_timezone_aware():
    now = utc_now()
    assert now.tzinfo is not None
    assert now.utcoffset() == timezone.utc.utcoffset(None)


# ---------------------------------------------------------------------------
# PrivacySafeModel.reject_individual_level_data
# ---------------------------------------------------------------------------


def test_named_identity_storage_is_supported():
    metrics = AggregateMetrics(contributors=["ada", "grace"], active_contributors=2)
    assert metrics.contributors == ["ada", "grace"]


def test_privacy_violation_error_is_a_value_error():
    assert issubclass(PrivacyViolationError, ValueError)
    assert issubclass(EvidenceTraceError, ValueError)
    assert not issubclass(ImmutableSnapshotError, ValueError)


def test_privacy_safe_model_forbids_extra_fields():
    with pytest.raises(ValidationError):
        AggregateMetrics(active_days=3, unexpected_field="boom")


def test_privacy_safe_model_strips_whitespace_and_validates_assignment():
    pause = PlannedPause(starts_on=date(2026, 8, 1), reason="  summer freeze  ")
    assert pause.reason == "summer freeze"

    with pytest.raises(ValidationError):
        pause.reason = ""


def test_model_dump_excludes_none_by_default():
    metrics = AggregateMetrics(active_days=3)
    payload = metrics.model_dump()
    assert "active_days" in payload
    assert "open_prs" not in payload
    assert metrics.model_dump(exclude_none=False)["open_prs"] is None


def test_public_dump_omits_internal_floor_fields():
    """``public_dump`` must drop every key ``PublicAggregateMetrics`` forbids."""
    metrics = AggregateMetrics(
        active_days=3,
        aggregation_floor=5,
        team_size=8,
        contributors=["ada", "grace"],
        active_contributors=2,
    )
    payload = metrics.public_dump()
    assert "aggregation_floor" not in payload
    assert "team_size" not in payload
    assert "contributors" not in payload
    # The aggregate count itself is public; only its inputs are internal.
    assert payload["active_contributors"] == 2
    assert payload["active_days"] == 3


def test_public_dump_feeds_from_metrics_without_extra_keys():
    """Regression: ``from_metrics`` used to raise on any populated roster."""
    metrics = AggregateMetrics(
        active_days=3, team_size=8, contributors=["ada"], active_contributors=1
    )
    public = PublicAggregateMetrics.from_metrics(metrics)
    assert public.active_contributors == 1


def test_public_aggregate_metrics_drops_identity_fields():
    metrics = AggregateMetrics(
        active_days=3,
        active_contributors=2,
        contributors=["ada", "grace"],
        team_size=8,
        aggregation_floor=5,
    )
    public = PublicAggregateMetrics.from_metrics(metrics)
    payload = public.model_dump()
    assert payload["active_contributors"] == 2
    assert "contributors" not in payload
    assert "team_size" not in payload
    assert "aggregation_floor" not in payload


# ---------------------------------------------------------------------------
# PHIDocument constraints
# ---------------------------------------------------------------------------


def test_phi_document_id_defaults_to_none_and_accepts_a_uuid(make_project):
    project = make_project()
    assert project.id is None

    assigned = new_id()
    project.id = assigned
    assert project.id == assigned


def test_phi_document_forbids_extra_fields():
    with pytest.raises(ValidationError):
        ProjectDocument(
            project_id="member-portal", display_name="Member Portal", rogue=True
        )


@pytest.mark.parametrize(
    "project_id",
    ["Member-Portal", "member portal", "member_portal", "-member", "member-", ""],
)
def test_project_id_pattern_is_enforced(project_id):
    with pytest.raises(ValidationError):
        ProjectDocument(project_id=project_id, display_name="X")


def test_project_id_accepts_kebab_case():
    project = ProjectDocument(project_id="member-portal-api", display_name="X")
    assert project.project_id == "member-portal-api"


def test_project_display_name_length_is_bounded():
    with pytest.raises(ValidationError):
        ProjectDocument(project_id="a", display_name="x" * 201)


def test_repo_activity_bounds_are_enforced():
    with pytest.raises(ValidationError):
        RepoActivityDocument(
            gitea_repo_id="r",
            repo_slug="r",
            window_start=date(2026, 8, 3),
            window_end=date(2026, 8, 9),
            open_prs=-1,
        )
    with pytest.raises(ValidationError):
        RepoActivityDocument(
            gitea_repo_id="r",
            repo_slug="r",
            window_start=date(2026, 8, 3),
            window_end=date(2026, 8, 9),
            data_completeness_pct=101,
        )


def test_repo_activity_rejects_inverted_window():
    with pytest.raises(ValidationError, match="window_end must be on or after"):
        RepoActivityDocument(
            gitea_repo_id="r",
            repo_slug="r",
            window_start=date(2026, 8, 9),
            window_end=date(2026, 8, 3),
        )


def test_repo_activity_aggregate_metrics_projection(make_activity):
    activity = make_activity(contributors=["ada"], last_sync_at=None)
    metrics = activity.aggregate_metrics()
    assert isinstance(metrics, AggregateMetrics)
    assert metrics.open_prs == activity.open_prs
    assert metrics.contributors == ["ada"]
    # last_sync_at falls back to synced_at when unset.
    assert metrics.last_sync_at == activity.synced_at


# ---------------------------------------------------------------------------
# ProjectDocument.scoring_decision
# ---------------------------------------------------------------------------


def test_scoring_decision_suppresses_paused_lifecycle(make_project):
    project = make_project(lifecycle_state=LifecycleState.PAUSED)
    decision = project.scoring_decision(date(2026, 8, 3), date(2026, 8, 9))
    assert decision.suppressed is True
    assert decision.status == AttentionStatus.PLANNED_PAUSE


def test_scoring_decision_suppresses_archived_lifecycle(make_project):
    project = make_project(lifecycle_state=LifecycleState.ARCHIVED)
    decision = project.scoring_decision(date(2026, 8, 3), date(2026, 8, 9))
    assert decision.suppressed is True
    assert decision.status is None


def test_scoring_decision_suppresses_overlapping_planned_pause(make_project):
    project = make_project(
        planned_pauses=[
            PlannedPause(
                starts_on=date(2026, 8, 5), ends_on=date(2026, 8, 20), reason="freeze"
            )
        ]
    )
    assert project.scoring_decision(date(2026, 8, 3), date(2026, 8, 9)).suppressed


def test_scoring_decision_allows_active_project(make_project):
    decision = make_project().scoring_decision(date(2026, 8, 3), date(2026, 8, 9))
    assert decision.suppressed is False
    assert decision.status is None


def test_planned_pause_rejects_inverted_range():
    with pytest.raises(ValidationError, match="ends_on must be on or after"):
        PlannedPause(
            starts_on=date(2026, 8, 20), ends_on=date(2026, 8, 1), reason="freeze"
        )


def test_planned_pause_open_ended_overlaps_all_later_weeks():
    pause = PlannedPause(starts_on=date(2026, 8, 1), reason="freeze")
    assert pause.overlaps(date(2027, 1, 1), date(2027, 1, 7)) is True
    assert pause.overlaps(date(2026, 7, 1), date(2026, 7, 7)) is False


# ---------------------------------------------------------------------------
# WeeklySnapshotDocument
# ---------------------------------------------------------------------------


async def test_weekly_snapshot_is_immutable(make_snapshot):
    snapshot = make_snapshot()
    with pytest.raises(ImmutableSnapshotError):
        await snapshot.save()
    with pytest.raises(ImmutableSnapshotError):
        await snapshot.replace()
    with pytest.raises(ImmutableSnapshotError):
        await snapshot.update()
    with pytest.raises(ImmutableSnapshotError):
        await snapshot.delete()


def test_weekly_snapshot_rejects_inverted_window(make_snapshot):
    with pytest.raises(ValidationError, match="week_end must be on or after"):
        make_snapshot(week_end=date(2026, 7, 1))


def test_weekly_snapshot_rejects_warnings_on_planned_pause(make_snapshot):
    with pytest.raises(ValidationError, match="planned-pause snapshots"):
        make_snapshot(
            attention_status=AttentionStatus.PLANNED_PAUSE,
            warning_ids=[new_id()],
        )


def test_weekly_snapshot_allows_planned_pause_without_warnings(make_snapshot):
    snapshot = make_snapshot(attention_status=AttentionStatus.PLANNED_PAUSE)
    assert snapshot.warning_ids == []


def test_weekly_snapshot_completeness_bounds(make_snapshot):
    with pytest.raises(ValidationError):
        make_snapshot(data_completeness_pct=101)
    with pytest.raises(ValidationError):
        make_snapshot(data_completeness_pct=-1)


# ---------------------------------------------------------------------------
# WarningDocument evidence tracing
# ---------------------------------------------------------------------------


def test_warning_requires_traceable_evidence(make_warning):
    with pytest.raises((EvidenceTraceError, ValidationError)):
        make_warning("snapshot-1", evidence=[])


def test_warning_evidence_item_requires_source_refs():
    with pytest.raises(ValidationError):
        WarningEvidenceItem(icon="pull", title="Aging", source_refs=[])


def test_warning_evidence_refs_are_flattened(make_warning, make_snapshot):
    snapshot = make_snapshot()
    warning = make_warning(str(snapshot.id) if snapshot.id else new_id())
    assert len(warning.evidence_refs) == 1
    assert warning.evidence_refs[0].source_collection == "repo_activity"


def test_warning_evidence_type_serializes_under_the_type_alias(make_warning):
    warning = make_warning(new_id())
    payload = warning.evidence[0].model_dump(by_alias=True)
    assert payload["type"] == "metric"
    assert "sourceEvidence" in payload


# ---------------------------------------------------------------------------
# ProjectResponse contributor gate
# ---------------------------------------------------------------------------


def _project_response_kwargs(**overrides):
    payload = {
        "id": "member-portal",
        "name": "Member Portal",
        "short": "MP",
        "team": "product-experience",
        "repo": "member-portal",
        "status": "Watch",
        "statusClass": "watch",
        "signal": "Review latency rising",
        "signalDetail": "6.2 days",
        "lastActivity": "Today",
        "trend": "down",
        "weeks": [1, 2, 3, 4, 5, 6, 7, 8],
        "flagFrom": 6,
        "seriesBaselines": SeriesBaselines(open_prs=[1, 4], review_latency=[2.1, 5.4]),
        "series": Series(activity=[1] * 8),
        "description": "",
        "boundary": BoundaryView(rootTeam="product-experience", lifecycle="active"),
    }
    payload.update(overrides)
    return payload


def test_project_response_allows_contributor_series_with_aggregate():
    response = ProjectResponse(
        **_project_response_kwargs(
            series=Series(activity=[1] * 8, contributors=[2] * 8),
            metrics=PublicAggregateMetrics(active_contributors=2),
        )
    )
    assert response.series.contributors == [2] * 8


def test_project_response_rejects_contributor_series_without_aggregate():
    with pytest.raises((PrivacyViolationError, ValidationError)):
        ProjectResponse(
            **_project_response_kwargs(
                series=Series(activity=[1] * 8, contributors=[2] * 8),
                metrics=None,
            )
        )


def test_project_response_rejects_contributor_evidence_without_aggregate(make_warning):
    warning = make_warning(new_id())
    evidence_item = warning.evidence[0].model_copy(update={"metric": "contributors"})
    with pytest.raises((PrivacyViolationError, ValidationError)):
        ProjectResponse(
            **_project_response_kwargs(evidence=[evidence_item], metrics=None)
        )


def test_project_response_requires_exactly_eight_weeks():
    with pytest.raises(ValidationError):
        ProjectResponse(**_project_response_kwargs(weeks=[1, 2, 3]))


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


def test_enum_string_values_are_stable():
    assert AttentionStatus.AT_RISK == "at_risk"
    assert LifecycleState.MAINTENANCE == "maintenance"
    assert Role.PORTFOLIO_LEADER == "portfolio_leader"


def test_audit_log_accepts_safe_payloads(make_audit):
    audit = make_audit()
    assert audit.after == {"project_id": "member-portal", "category": "risk_confirmed"}
    assert isinstance(audit.at, datetime)


def test_privacy_safe_model_is_the_shared_base():
    assert issubclass(AggregateMetrics, PrivacySafeModel)
    assert issubclass(Series, PrivacySafeModel)
