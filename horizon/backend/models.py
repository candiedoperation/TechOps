"""Privacy-safe Beanie documents and frontend-compatible response contracts."""

from __future__ import annotations

from datetime import date, datetime, timezone
from enum import StrEnum
from typing import Any, ClassVar, Literal

import uuid

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    computed_field,
    field_validator,
    model_validator,
)

from .errors import EvidenceTraceError, ImmutableSnapshotError, PrivacyViolationError


DocumentId = str


def new_id() -> str:
    """Generate a new random document ID."""
    return str(uuid.uuid4())


ProjectId = str


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class PrivacySafeModel(BaseModel):
    """Strict base contract for validated API evidence; access is enforced by auth."""

    model_config: ClassVar[ConfigDict] = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
        validate_assignment=True,
    )

    def public_dump(self) -> dict[str, Any]:
        """Serialize a response with null privacy-gated metrics omitted."""

        return self.model_dump(mode="json", by_alias=True, exclude_none=True)

    def model_dump(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        kwargs.setdefault("exclude_none", True)
        return super().model_dump(*args, **kwargs)


class LifecycleState(StrEnum):
    NEW = "new"
    ACTIVE = "active"
    MAINTENANCE = "maintenance"
    PAUSED = "paused"
    ARCHIVED = "archived"


class AttentionStatus(StrEnum):
    CLEAR = "clear"
    WATCH = "watch"
    AT_RISK = "at_risk"
    INSUFFICIENT_DATA = "insufficient_data"
    PLANNED_PAUSE = "planned_pause"


class WarningSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class FeedbackCategory(StrEnum):
    HELPFUL = "helpful"
    NOT_USEFUL = "not_useful"
    FALSE_POSITIVE = "false_positive"
    MISSED_RISK = "missed_risk"
    PLANNED_PAUSE = "planned_pause"
    EXPECTED_CYCLE = "expected_cycle"
    DATA_QUALITY = "data_quality"
    RISK_CONFIRMED = "risk_confirmed"
    RISK_RESOLVED = "risk_resolved"


class Role(StrEnum):
    ADMIN = "admin"
    PORTFOLIO_LEADER = "portfolio_leader"
    PROJECT_LEAD = "project_lead"


class PHIDocument(BaseModel):
    """Common persisted-document base (pure Pydantic, no ODM dependency)."""

    id: DocumentId | None = Field(default=None)

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
        validate_assignment=True,
    )

    def public_dump(self) -> dict[str, Any]:
        return self.model_dump(mode="json", by_alias=True, exclude_none=True)

    def model_dump(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        kwargs.setdefault("exclude_none", True)
        return super().model_dump(*args, **kwargs)


class RepositoryRef(PrivacySafeModel):
    gitea_repo_id: str = Field(min_length=1, max_length=160)
    repo_slug: str = Field(min_length=1, max_length=240)


class SharedRepositoryRef(RepositoryRef):
    shared_with_project_ids: list[ProjectId] = Field(default_factory=list, max_length=100)


class PlannedPause(PrivacySafeModel):
    starts_on: date
    ends_on: date | None = None
    reason: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_range(self) -> "PlannedPause":
        if self.ends_on is not None and self.ends_on < self.starts_on:
            raise ValueError("planned pause ends_on must be on or after starts_on")
        return self

    def overlaps(self, week_start: date, week_end: date) -> bool:
        return self.starts_on <= week_end and (
            self.ends_on is None or self.ends_on >= week_start
        )


class ScoringDecision(PrivacySafeModel):
    suppressed: bool
    status: AttentionStatus | None = None
    reason: str | None = None


class CatalogGiteaIdentity(PrivacySafeModel):
    """Stable Gitea member identity linked by the upstream exact-email join."""

    provider: str = Field(min_length=1, max_length=80)
    provider_id: str = Field(min_length=1, max_length=200)
    username: str = Field(min_length=1, max_length=320)
    email: str | None = Field(default=None, max_length=320)


class CatalogLeadReference(PrivacySafeModel):
    """Stable People Portal/AuthentiK lead identity retained as provenance."""

    id: str = Field(min_length=1, max_length=200)
    provider: str = Field(min_length=1, max_length=80)
    provider_id: str = Field(min_length=1, max_length=200)
    username: str = Field(min_length=1, max_length=320)
    name: str = Field(min_length=1, max_length=320)
    email: str | None = Field(default=None, max_length=320)
    role: str = Field(min_length=1, max_length=120)
    gitea: CatalogGiteaIdentity | None = None


class CatalogIdentityIssue(PrivacySafeModel):
    """Upstream identity collision/missing-key finding; never inferred around."""

    code: str = Field(min_length=1, max_length=80)
    provider: str = Field(min_length=1, max_length=80)
    project_ids: list[str] = Field(default_factory=list, max_length=100)
    person_ids: list[str] = Field(default_factory=list, max_length=100)
    email: str | None = Field(default=None, max_length=320)


class ProjectDocument(PHIDocument):
    project_id: ProjectId = Field(
        min_length=1,
        max_length=80,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    )
    display_name: str = Field(min_length=1, max_length=200)
    lifecycle_state: LifecycleState = LifecycleState.NEW
    created_at: datetime = Field(default_factory=utc_now)
    archived_at: datetime | None = None
    data_owner_user_id: str | None = Field(default=None, min_length=1, max_length=200)
    # People Portal team identity is three distinct values: Authentik's stable
    # PK, the Shared Resource ID/Gitea organization namespace, and the friendly
    # display name. Keep them explicit so consumers cannot substitute one.
    owning_authentik_team_id: str | None = Field(default=None, max_length=200)
    owning_shared_resource_id: str | None = Field(default=None, max_length=240)
    owning_team_display_name: str | None = Field(default=None, max_length=200)
    gitea_organization: str | None = Field(default=None, max_length=240)
    gitea_repository_snapshot: str | None = Field(default=None, max_length=32)
    gitea_member_snapshot: str | None = Field(default=None, max_length=32)
    catalog_leads: list[CatalogLeadReference] = Field(default_factory=list, max_length=100)
    catalog_identity_issues: list[CatalogIdentityIssue] = Field(default_factory=list, max_length=100)
    catalog_revision: str | None = Field(default=None, max_length=128)
    catalog_observed_at: datetime | None = None
    non_goals_ack: bool = False
    planned_pauses: list[PlannedPause] = Field(default_factory=list, max_length=100)

    class Settings:
        name = "projects"

    def scoring_decision(self, week_start: date, week_end: date) -> ScoringDecision:
        """Short-circuit pause/lifecycle state before any rule evaluation."""

        if self.lifecycle_state == LifecycleState.PAUSED:
            return ScoringDecision(
                suppressed=True,
                status=AttentionStatus.PLANNED_PAUSE,
                reason="project lifecycle is paused",
            )
        if self.lifecycle_state == LifecycleState.ARCHIVED:
            return ScoringDecision(
                suppressed=True,
                status=None,
                reason="project lifecycle is archived",
            )
        if any(pause.overlaps(week_start, week_end) for pause in self.planned_pauses):
            return ScoringDecision(
                suppressed=True,
                status=AttentionStatus.PLANNED_PAUSE,
                reason="planned pause overlaps snapshot window",
            )
        return ScoringDecision(suppressed=False)


class BoundaryDocument(PHIDocument):
    project_id: ProjectId = Field(
        min_length=1,
        max_length=80,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    )
    root_authentik_team_id: str = Field(min_length=1, max_length=200)
    root_shared_resource_id: str | None = Field(default=None, max_length=240)
    root_team_display_name: str | None = Field(default=None, max_length=200)
    gitea_organization: str | None = Field(default=None, max_length=240)
    gitea_repository_snapshot: str | None = Field(default=None, max_length=32)
    gitea_member_snapshot: str | None = Field(default=None, max_length=32)
    catalog_leads: list[CatalogLeadReference] = Field(default_factory=list, max_length=100)
    catalog_identity_issues: list[CatalogIdentityIssue] = Field(default_factory=list, max_length=100)
    catalog_revision: str | None = Field(default=None, max_length=128)
    included_subteam_ids: list[str] = Field(default_factory=list, max_length=500)
    primary_repos: list[RepositoryRef] = Field(default_factory=list, max_length=500)
    shared_repos: list[SharedRepositoryRef] = Field(default_factory=list, max_length=500)
    excluded_repos: list[str] = Field(default_factory=list, max_length=500)
    effective_from: date
    effective_to: date | None = None
    data_owner_user_id: str | None = Field(default=None, min_length=1, max_length=200)
    created_by: str = Field(min_length=1, max_length=200)
    created_at: datetime = Field(default_factory=utc_now)

    class Settings:
        name = "boundaries"

    @model_validator(mode="after")
    def validate_range(self) -> "BoundaryDocument":
        if self.effective_to is not None and self.effective_to < self.effective_from:
            raise ValueError("effective_to must be on or after effective_from")
        return self

    def is_effective_at(self, when: date) -> bool:
        return self.effective_from <= when and (
            self.effective_to is None or when <= self.effective_to
        )


class IdentityMapDocument(PHIDocument):
    """Records that contributor identity storage is enabled for this deployment."""

    record_type: Literal["identity_enabled"] = "identity_enabled"
    mapping_enabled: bool = True
    created_at: datetime = Field(default_factory=utc_now)

    class Settings:
        name = "identity_map"


class AggregateMetrics(PrivacySafeModel):
    """Repository/project aggregates including named contributor lists."""

    active_days: int | None = Field(default=None, ge=0)
    days_since_activity: int | None = Field(default=None, ge=0)
    open_prs: int | None = Field(default=None, ge=0)
    oldest_open_pr_days: float | None = Field(default=None, ge=0)
    review_latency_days: float | None = Field(default=None, ge=0)
    merged_count: int | None = Field(default=None, ge=0)
    active_contributors: int | None = Field(default=None, ge=0)
    contributors: list[str] = Field(default_factory=list)
    team_size: int | None = Field(default=None, ge=0)
    aggregation_floor: int | None = Field(default=None, ge=1)
    data_completeness_pct: float | None = Field(default=None, ge=0, le=100)
    last_sync_at: datetime | None = None

    def public_dump(self) -> dict[str, Any]:
        payload = super().public_dump()
        # ``PublicAggregateMetrics`` is the response projection and forbids
        # extra keys, so every internal-only field must be dropped here:
        # the floor itself plus the two inputs it gates (the contributor
        # roster and the exact team size).
        for internal_field in ("aggregation_floor", "contributors", "team_size"):
            payload.pop(internal_field, None)
        return payload


class RepoActivityDocument(PHIDocument):
    """Append-only raw evidence for one repository sync window, including named contributors."""

    project_id: ProjectId | None = Field(
        default=None,
        min_length=1,
        max_length=80,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    )
    gitea_repo_id: str = Field(min_length=1, max_length=160)
    repo_slug: str = Field(min_length=1, max_length=240)
    window_start: date
    window_end: date
    synced_at: datetime = Field(default_factory=utc_now)
    active_days: int | None = Field(default=None, ge=0)
    days_since_activity: int | None = Field(default=None, ge=0)
    open_prs: int | None = Field(default=None, ge=0)
    oldest_open_pr_days: float | None = Field(default=None, ge=0)
    review_latency_days: float | None = Field(default=None, ge=0)
    merged_count: int | None = Field(default=None, ge=0)
    # Work that exists but has not reached the default branch. The rest of this
    # system deliberately reads the default branch only, which makes a busy team
    # on long-lived feature branches indistinguishable from an idle one; this
    # count is the cheap portfolio-level correction for that blind spot.
    branches_ahead: int | None = Field(default=None, ge=0)
    open_issues: int | None = Field(default=None, ge=0)
    active_contributors: int | None = Field(default=None, ge=0)
    contributors: list[str] = Field(default_factory=list)
    team_size: int | None = Field(default=None, ge=0)
    aggregation_floor: int | None = Field(default=None, ge=1)
    data_completeness_pct: float | None = Field(default=None, ge=0, le=100)
    last_sync_at: datetime | None = None

    class Settings:
        name = "repo_activity"

    @model_validator(mode="after")
    def validate_window(self) -> "RepoActivityDocument":
        if self.window_end < self.window_start:
            raise ValueError("window_end must be on or after window_start")
        return self

    def aggregate_metrics(self) -> AggregateMetrics:
        return AggregateMetrics(
            active_days=self.active_days,
            days_since_activity=self.days_since_activity,
            open_prs=self.open_prs,
            oldest_open_pr_days=self.oldest_open_pr_days,
            review_latency_days=self.review_latency_days,
            merged_count=self.merged_count,
            active_contributors=self.active_contributors,
            contributors=list(self.contributors),
            team_size=self.team_size,
            aggregation_floor=self.aggregation_floor,
            data_completeness_pct=self.data_completeness_pct,
            last_sync_at=self.last_sync_at or self.synced_at,
        )


class EvidenceReference(PrivacySafeModel):
    """Pointer to an inspectable aggregate source row."""

    source_collection: Literal[
        "projects",
        "boundaries",
        "repo_activity",
        "weekly_snapshots",
        "feedback",
        "audit_log",
    ]
    source_id: str = Field(min_length=1, max_length=200)
    source_field: str = Field(min_length=1, max_length=120)
    observed_at: datetime


class WarningEvidenceItem(PrivacySafeModel):
    warning_id: str | None = None
    evidence_type: str = Field(
        default="metric",
        validation_alias=AliasChoices("evidence_type", "type"),
        serialization_alias="type",
        min_length=1,
        max_length=40,
    )
    icon: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=240)
    metric: str | None = Field(default=None, max_length=120)
    unit: str = Field(default="", max_length=30)
    current: int | float | str | None = None
    baseline: int | float | str | None = None
    source_refs: list[EvidenceReference] = Field(
        default_factory=list,
        validation_alias=AliasChoices("source_refs", "sourceEvidence"),
        serialization_alias="sourceEvidence",
        min_length=1,
        max_length=100,
    )


class WeeklySnapshotDocument(PHIDocument):
    """Immutable weekly unit of historical truth."""

    project_id: ProjectId = Field(
        min_length=1,
        max_length=80,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    )
    week_start: date
    week_end: date
    rule_set_version: str = Field(min_length=1, max_length=80)
    generated_at: datetime = Field(default_factory=utc_now)
    attention_status: AttentionStatus
    data_completeness_pct: float = Field(ge=0, le=100)
    last_sync_at: datetime | None = None
    metrics: AggregateMetrics
    baselines: AggregateMetrics | None = None
    warning_ids: list[DocumentId] = Field(default_factory=list, max_length=100)
    series: dict[str, list[float | int | None]] = Field(default_factory=dict)
    series_baselines: dict[str, list[float | int | None]] = Field(default_factory=dict)

    # Populated only when rule_set_version is an LLM-signal generation
    # (SIGNAL_VERSION in backend.signal_llm); absent/None on rule-engine rows.
    signal_source: Literal["rules", "llm"] | None = None
    signal_headline: str | None = Field(default=None, max_length=160)
    signal_summary: str | None = Field(default=None, max_length=800)
    signal_confidence: float | None = Field(default=None, ge=0, le=1)
    signal_work_volume: str | None = Field(default=None, max_length=20)
    signal_model: str | None = Field(default=None, max_length=120)
    signal_recommendations: list[str] = Field(default_factory=list, max_length=8)
    signal_changes: list[dict[str, Any]] = Field(default_factory=list, max_length=6)
    signal_concerns: list[dict[str, Any]] = Field(default_factory=list, max_length=5)
    signal_data_gaps: list[str] = Field(default_factory=list, max_length=8)
    signal_evidence_tier: str | None = None
    # {id, kind, repo_slug, sha, subject, files_changed, additions, deletions} --
    # which commits/files the judge saw, not diff text (avoids persisting
    # anything diff-shaped, which student repos can leak secrets into).
    signal_facts: list[dict[str, Any]] = Field(default_factory=list, max_length=60)

    class Settings:
        name = "weekly_snapshots"

    @model_validator(mode="after")
    def validate_window(self) -> "WeeklySnapshotDocument":
        if self.week_end < self.week_start:
            raise ValueError("week_end must be on or after week_start")
        if self.attention_status == AttentionStatus.PLANNED_PAUSE and self.warning_ids:
            raise ValueError("planned-pause snapshots cannot contain risk warnings")
        return self

    async def save(self, *args: Any, **kwargs: Any) -> Any:
        raise ImmutableSnapshotError("weekly snapshots are immutable; use the repository to insert")

    async def replace(self, *args: Any, **kwargs: Any) -> Any:
        raise ImmutableSnapshotError("weekly snapshots are immutable")

    async def update(self, *args: Any, **kwargs: Any) -> Any:
        raise ImmutableSnapshotError("weekly snapshots are immutable")

    async def delete(self, *args: Any, **kwargs: Any) -> Any:
        raise ImmutableSnapshotError("weekly snapshots are immutable")


class CumulativeCheckpointDocument(PHIDocument):
    """A project's synthesized progress as of a specific date.

    Deliberately a separate table from ``WeeklySnapshotDocument``: keyed on
    a date rather than an ISO week, and -- unlike weekly snapshots -- a
    checkpoint for the in-progress current week is a mutable, replaceable
    provisional row (see ``is_provisional``), not an immutable historical
    record. Built from a bounded "deep tail" of full diff-judged recent
    weeks (reusing ``WeeklySnapshotDocument``/``signal_llm`` unchanged) plus
    a cheap, metadata-only sweep over older history -- see
    ``backend.cumulative_llm`` and ``backend.jobs.generate_cumulative_checkpoint``.
    """

    project_id: ProjectId = Field(
        min_length=1,
        max_length=80,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    )
    as_of_date: date
    as_of_week_start: date
    coverage_start: date
    signal_version: str = Field(default="cumulative-v1", min_length=1, max_length=80)
    generated_at: datetime = Field(default_factory=utc_now)
    model: str = Field(default="", max_length=120)

    status: AttentionStatus
    confidence: float = Field(ge=0, le=1)
    # "stalled" was retired as a trajectory: it read as a verdict on the team
    # when all it ever described was the merge stream, and "slowing" carries the
    # same fact without the finality. Checkpoints persisted before the change
    # still hold it, so it is coerced on load rather than failing validation.
    trajectory: Literal["accelerating", "steady", "slowing", "unknown"] = "unknown"

    @field_validator("trajectory", mode="before")
    @classmethod
    def _retire_stalled(cls, value: Any) -> Any:
        return "slowing" if isinstance(value, str) and value.strip().lower() == "stalled" else value

    headline: str = Field(max_length=160)
    narrative: str = Field(max_length=2_000)
    work_to_date: str = Field(default="none", max_length=20)

    milestones: list[dict[str, Any]] = Field(default_factory=list, max_length=10)
    open_concerns: list[dict[str, Any]] = Field(default_factory=list, max_length=6)
    recommendations: list[str] = Field(default_factory=list, max_length=4)
    data_gaps: list[str] = Field(default_factory=list, max_length=4)

    # Which weeks got full diff-level review vs. commit-metadata-only, so
    # the UI can show an honest fidelity footnote ("N of M weeks reviewed").
    weeks_deep_judged: list[date] = Field(default_factory=list, max_length=52)
    weeks_shallow_counts: dict[str, int] = Field(default_factory=dict)

    source_snapshot_ids: list[DocumentId] = Field(default_factory=list, max_length=52)
    prior_checkpoint_id: DocumentId | None = None
    chain_depth: int = Field(default=0, ge=0)
    history_truncated: bool = False
    is_provisional: bool = False

    class Settings:
        name = "cumulative_checkpoints"


class WarningDocument(PHIDocument):
    snapshot_id: DocumentId
    project_id: ProjectId = Field(
        min_length=1,
        max_length=80,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    )
    rule_id: str = Field(min_length=1, max_length=120)
    rule_version: str = Field(min_length=1, max_length=80)
    signal_name: str = Field(min_length=1, max_length=160)
    current_value: float | int | None = None
    baseline_value: float | int | None = None
    time_window: str = Field(min_length=1, max_length=120)
    trigger_threshold: float | int | str | None = None
    severity: WarningSeverity
    explanation: str = Field(min_length=1, max_length=1_000)
    caveats: list[str] = Field(default_factory=list, max_length=50)
    data_freshness: str = Field(min_length=1, max_length=120)
    data_completeness_pct: float = Field(ge=0, le=100)
    evidence: list[WarningEvidenceItem] = Field(min_length=1, max_length=100)

    class Settings:
        name = "warnings"

    @model_validator(mode="after")
    def require_traceable_evidence(self) -> "WarningDocument":
        if not self.evidence or any(not item.source_refs for item in self.evidence):
            raise EvidenceTraceError("every warning must include inspectable source evidence")
        return self

    @computed_field(return_type=list[EvidenceReference])
    @property
    def evidence_refs(self) -> list[EvidenceReference]:
        return [reference for item in self.evidence for reference in item.source_refs]


class FeedbackDocument(PHIDocument):
    snapshot_id: DocumentId
    warning_id: DocumentId | None = None
    project_id: ProjectId = Field(
        min_length=1,
        max_length=80,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    )
    author_user_id: str = Field(min_length=1, max_length=200)
    category: FeedbackCategory
    note: str | None = Field(default=None, max_length=2_000)
    created_at: datetime = Field(default_factory=utc_now)

    class Settings:
        name = "feedback"


class AuditLogDocument(PHIDocument):
    actor_user_id: str = Field(min_length=1, max_length=200)
    action: str = Field(min_length=1, max_length=160)
    target_type: str = Field(min_length=1, max_length=80)
    target_id: str = Field(min_length=1, max_length=200)
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    at: datetime = Field(default_factory=utc_now)

    class Settings:
        name = "audit_log"



class PublicAggregateMetrics(PrivacySafeModel):
    """Response shape that omits the exact team-size enforcement fields."""

    active_days: int | None = Field(default=None, ge=0)
    days_since_activity: int | None = Field(default=None, ge=0)
    open_prs: int | None = Field(default=None, ge=0)
    oldest_open_pr_days: float | None = Field(default=None, ge=0)
    review_latency_days: float | None = Field(default=None, ge=0)
    merged_count: int | None = Field(default=None, ge=0)
    active_contributors: int | None = Field(default=None, ge=0)
    data_completeness_pct: float | None = Field(default=None, ge=0, le=100)
    last_sync_at: datetime | None = None

    @classmethod
    def from_metrics(cls, metrics: AggregateMetrics) -> "PublicAggregateMetrics":
        return cls.model_validate(metrics.public_dump())


class SeriesBaselines(PrivacySafeModel):
    open_prs: list[float | int | None] = Field(
        min_length=2,
        max_length=2,
        validation_alias=AliasChoices("open_prs", "openPRs"),
        serialization_alias="openPRs",
    )
    review_latency: list[float | int | None] = Field(
        min_length=2,
        max_length=2,
        validation_alias=AliasChoices("review_latency", "reviewLatency"),
        serialization_alias="reviewLatency",
    )
    contributors: list[float | int | None] | None = Field(default=None, min_length=2, max_length=2)


class Series(PrivacySafeModel):
    activity: list[float | int | None] = Field(default_factory=list, max_length=8)
    open_prs: list[float | int | None] = Field(
        default_factory=list,
        validation_alias=AliasChoices("open_prs", "openPRs"),
        serialization_alias="openPRs",
        max_length=8,
    )
    review_latency: list[float | int | None] = Field(
        default_factory=list,
        validation_alias=AliasChoices("review_latency", "reviewLatency"),
        serialization_alias="reviewLatency",
        max_length=8,
    )
    contributors: list[float | int | None] | None = Field(default=None, max_length=8)


class BoundaryView(PrivacySafeModel):
    root_team: str = Field(
        validation_alias=AliasChoices("root_team", "rootTeam"),
        serialization_alias="rootTeam",
    )
    subteams: list[str] = Field(default_factory=list)
    repos: list[str] = Field(default_factory=list)
    data_owner: str | None = Field(
        default=None,
        validation_alias=AliasChoices("data_owner", "dataOwner"),
        serialization_alias="dataOwner",
    )
    effective_since: date | str | None = Field(
        default=None,
        validation_alias=AliasChoices("effective_since", "effectiveSince"),
        serialization_alias="effectiveSince",
    )
    effective_until: date | str | None = Field(default=None, validation_alias=AliasChoices("effective_until", "effectiveUntil"), serialization_alias="effectiveUntil")
    version: str | None = None
    lifecycle: str


class HistoryItem(PrivacySafeModel):
    date: date | datetime | str
    actor: str
    action: str
    note: str | None = None


class AssessmentCitationView(PrivacySafeModel):
    """Safe, inspectable reference emitted by the CI health agent."""

    label: str | None = None
    reference: str = Field(min_length=1, max_length=512)


class HealthAssessmentView(PrivacySafeModel):
    """Frontend contract for a server-produced CI project-health assessment."""

    status: str
    score: int | float = Field(ge=0, le=100)
    confidence: float = Field(ge=0, le=1)
    expected_week: int = Field(
        validation_alias=AliasChoices("expected_week", "expectedWeek"),
        serialization_alias="expectedWeek",
        ge=1,
        le=52,
    )
    explanation: str = Field(min_length=1, max_length=1_000)
    blockers: list[str] = Field(default_factory=list, max_length=100)
    recommended_weekly_tasks: list[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices("recommended_weekly_tasks", "recommendedWeeklyTasks"),
        serialization_alias="recommendedWeeklyTasks",
        max_length=100,
    )
    citations: list[AssessmentCitationView] = Field(default_factory=list, max_length=200)
    assessment_id: str | None = None
    spec_version: str | None = None
    commit_sha: str | None = None
    generated_at: datetime | None = None


class ProjectResponse(PrivacySafeModel):
    """Frontend-compatible project projection with no contributor identities."""

    id: ProjectId
    name: str
    short: str
    team: str
    repo: str
    status: str
    status_class: str = Field(
        validation_alias=AliasChoices("status_class", "statusClass"),
        serialization_alias="statusClass",
    )
    signal: str
    signal_detail: str = Field(
        validation_alias=AliasChoices("signal_detail", "signalDetail"),
        serialization_alias="signalDetail",
    )
    signal_source: Literal["rules", "llm"] | None = Field(
        default=None,
        validation_alias=AliasChoices("signal_source", "signalSource"),
        serialization_alias="signalSource",
    )
    signal_confidence: float | None = Field(
        default=None,
        ge=0,
        le=1,
        validation_alias=AliasChoices("signal_confidence", "signalConfidence"),
        serialization_alias="signalConfidence",
    )
    signal_model: str | None = Field(
        default=None,
        max_length=120,
        validation_alias=AliasChoices("signal_model", "signalModel"),
        serialization_alias="signalModel",
    )
    signal_evidence_tier: str | None = Field(
        default=None,
        max_length=20,
        validation_alias=AliasChoices("signal_evidence_tier", "signalEvidenceTier"),
        serialization_alias="signalEvidenceTier",
    )
    last_activity: str = Field(
        validation_alias=AliasChoices("last_activity", "lastActivity"),
        serialization_alias="lastActivity",
    )
    trend: str
    weeks: list[float | int | None] = Field(min_length=8, max_length=8)
    flag_from: int = Field(
        validation_alias=AliasChoices("flag_from", "flagFrom"),
        serialization_alias="flagFrom",
    )
    series_baselines: SeriesBaselines = Field(
        validation_alias=AliasChoices("series_baselines", "seriesBaselines"),
        serialization_alias="seriesBaselines",
    )
    series: Series
    description: str
    boundary: BoundaryView
    evidence: list[WarningEvidenceItem] = Field(default_factory=list)
    history: list[HistoryItem] = Field(default_factory=list)
    metrics: PublicAggregateMetrics | None = None
    baselines: PublicAggregateMetrics | None = None
    data_completeness_pct: float | None = Field(default=None, ge=0, le=100)
    last_sync_at: datetime | None = None
    health_assessment: HealthAssessmentView | None = Field(
        default=None,
        validation_alias=AliasChoices("health_assessment", "healthAssessment"),
        serialization_alias="healthAssessment",
    )

    @model_validator(mode="after")
    def enforce_public_contributor_gate(self) -> "ProjectResponse":
        contributor_series_present = (
            self.series.contributors is not None
            or self.series_baselines.contributors is not None
        )
        contributor_evidence_present = any(
            item.metric in {"contributors", "active_contributors"}
            for item in self.evidence
        )
        if contributor_series_present or contributor_evidence_present:
            if self.metrics is None or self.metrics.active_contributors is None:
                raise PrivacyViolationError(
                    "contributor aggregates must be omitted below the configured floor"
                )
        return self
    snapshot_id: str | None = None




# ---------------------------------------------------------------------------
# Gitea member analytics
#
# These documents carry named, per-person contribution metrics, which is a
# deliberate exception to the aggregate-only shape of the rest of this module.
# They are populated from the Gitea analytics collector in
# ``scripts/member_analytics.py`` and are descriptive activity indicators, not
# a performance score: volume is driven by task size, role, collaboration
# style, generated code, and repository history.
# ---------------------------------------------------------------------------


class MemberMetricsDocument(PHIDocument):
    """One identity's aggregated activity for a single analytics run."""

    run_id: str = Field(min_length=1, max_length=64)
    login: str = Field(min_length=1, max_length=320)
    name: str | None = Field(default=None, max_length=320)
    email: str | None = Field(default=None, max_length=320)
    organizations: list[str] = Field(default_factory=list)
    admin: bool = False
    active_account: bool = True
    # False for commit identities that could not be matched to a Gitea roster
    # member. They may duplicate a member row rather than be another person.
    roster_member: bool = True
    service_or_admin: bool = False
    commits: int | None = Field(default=0, ge=0)
    commits_default_reachable: int | None = Field(default=None, ge=0)
    commits_branch_only: int | None = Field(default=None, ge=0)
    non_merge_commits: int | None = Field(default=0, ge=0)
    merge_commits: int | None = Field(default=0, ge=0)
    additions: int | None = Field(default=0, ge=0)
    deletions: int | None = Field(default=0, ge=0)
    files_changed: int | None = Field(default=0, ge=0)
    unique_files: int | None = Field(default=0, ge=0)
    commit_stats_status: str = Field(default="not_applicable", max_length=32)
    file_stats_status: str = Field(default="not_applicable", max_length=32)
    commit_stats_complete: int = Field(default=0, ge=0)
    commit_stats_unavailable: int = Field(default=0, ge=0)
    commit_stats_failed: int = Field(default=0, ge=0)
    file_stats_complete: int = Field(default=0, ge=0)
    file_stats_unavailable: int = Field(default=0, ge=0)
    file_stats_failed: int = Field(default=0, ge=0)
    identity_aliases: list[dict[str, Any]] = Field(default_factory=list)
    repositories: list[str] = Field(default_factory=list)
    branches: list[str] = Field(default_factory=list)
    pulls_opened: int | None = Field(default=0, ge=0)
    pulls_merged: int | None = Field(default=0, ge=0)
    pulls_contributed_to: int | None = Field(default=None, ge=0)
    pulls_merged_contributed_to: int | None = Field(default=None, ge=0)
    pull_commits_authored: int | None = Field(default=None, ge=0)
    merged_pull_commits_authored: int | None = Field(default=None, ge=0)
    pulls_closed: int | None = Field(default=0, ge=0)
    reviews_submitted: int | None = Field(default=0, ge=0)
    reviews_approved: int | None = Field(default=0, ge=0)
    reviews_changes_requested: int | None = Field(default=0, ge=0)
    reviews_other: int | None = Field(default=0, ge=0)
    issues_opened: int | None = Field(default=0, ge=0)
    active_days: int | None = Field(default=0, ge=0)
    first_activity: datetime | None = None
    last_activity: datetime | None = None
    blame_lines: int | None = Field(default=None, ge=0)
    blame_files: int | None = Field(default=None, ge=0)

    @property
    def has_activity(self) -> bool:
        return any(
            (self.commits, self.pulls_opened, self.pulls_merged_contributed_to,
             self.reviews_submitted,
             self.issues_opened, self.blame_lines)
        )


class MemberAnalyticsOrgSummary(BaseModel):
    """Per-organization rollup carried on the run document."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    organization: str = Field(min_length=1, max_length=160)
    member_count: int = Field(default=0, ge=0)
    repository_count: int = Field(default=0, ge=0)


class MemberAnalyticsRepoSummary(BaseModel):
    """Per-repository rollup carried on the run document."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    organization: str = Field(min_length=1, max_length=160)
    name: str = Field(min_length=1, max_length=240)
    default_branch: str | None = Field(default=None, max_length=240)
    html_url: str | None = Field(default=None, max_length=600)
    branch_count: int = Field(default=0, ge=0)
    commit_count: int = Field(default=0, ge=0)
    pull_count: int = Field(default=0, ge=0)
    merged_count: int = Field(default=0, ge=0)
    issue_count: int = Field(default=0, ge=0)


class MemberAnalyticsRunDocument(PHIDocument):
    payload_sha256: str | None = None
    """Metadata and rollups for one collection run; members are stored separately."""

    run_id: str = Field(min_length=1, max_length=64)
    generated_at: datetime
    ingested_at: datetime = Field(default_factory=utc_now)
    gitea_url: str = Field(default="", max_length=600)
    history_scope: str = Field(default="", max_length=240)
    commit_stats_scope: str | None = Field(default=None, max_length=240)
    blame_status: str = Field(default="unknown", max_length=32)
    blame_method: str | None = Field(default=None, max_length=240)
    api_calls: int = Field(default=0, ge=0)
    # Non-empty means part of the run is missing -- for example a repository
    # with pull requests disabled returns HTTP 404 and contributes no PR data.
    warnings: list[str] = Field(default_factory=list)
    coverage: list[dict[str, Any]] = Field(default_factory=list)
    organizations: list[MemberAnalyticsOrgSummary] = Field(default_factory=list)
    repositories: list[MemberAnalyticsRepoSummary] = Field(default_factory=list)
    member_count: int = Field(default=0, ge=0)


# ---------------------------------------------------------------------------
# Recruiting signal pipeline
#
# This is a separate, reviewer-gated surface from the descriptive member
# analytics page above. The source document intentionally keeps employer
# context available for inspection, while the scoring code never reads it.
# ---------------------------------------------------------------------------


class RecruitingDecision(StrEnum):
    CONFIRM = "confirm"
    ADJUST = "adjust"
    DEFER = "defer"


class RecruitingReviewStatus(StrEnum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    ADJUSTED = "adjusted"
    DEFERRED = "deferred"


class RecruitingSignalBand(StrEnum):
    UNDERRATED = "underrated"
    STRONG_SIGNAL = "strong_signal"
    NEEDS_REVIEW = "needs_review"


class RecruitingEligibilityStatus(StrEnum):
    """Outreach eligibility, kept separate from ability and contribution."""

    ELIGIBLE = "eligible"
    EXCLUDED = "excluded"
    NEEDS_REVIEW = "needs_review"


class RecruitingMemberStats(PrivacySafeModel):
    """Contribution indicators copied from a named Gitea analytics run."""

    commits: int | None = Field(default=None, ge=0)
    commits_default_reachable: int | None = Field(default=None, ge=0)
    commits_branch_only: int | None = Field(default=None, ge=0)
    additions: int | None = Field(default=None, ge=0)
    unique_files: int | None = Field(default=None, ge=0)
    pulls_opened: int | None = Field(default=None, ge=0)
    pulls_merged: int | None = Field(default=None, ge=0)
    pulls_contributed_to: int | None = Field(default=None, ge=0)
    pulls_merged_contributed_to: int | None = Field(default=None, ge=0)
    pull_commits_authored: int | None = Field(default=None, ge=0)
    merged_pull_commits_authored: int | None = Field(default=None, ge=0)
    reviews_submitted: int | None = Field(default=None, ge=0)
    reviews_approved: int | None = Field(default=None, ge=0)
    issues_opened: int | None = Field(default=None, ge=0)
    active_days: int | None = Field(default=None, ge=0)
    blame_lines: int | None = Field(default=None, ge=0)
    repositories: list[str] = Field(default_factory=list, max_length=200)
    commit_stats_status: str = Field(default="unknown", max_length=32)
    file_stats_status: str = Field(default="unknown", max_length=32)


class RecruitingEvidenceReference(PrivacySafeModel):
    """A source pointer a reviewer can use to inspect a signal claim."""

    source_type: str = Field(min_length=1, max_length=80)
    source_id: str = Field(min_length=1, max_length=240)
    source_field: str = Field(min_length=1, max_length=240)
    label: str = Field(min_length=1, max_length=320)


class RecruitingEvidenceClaim(PrivacySafeModel):
    """A bounded, source-backed claim extracted for reviewer inspection."""

    source_field: str = Field(min_length=1, max_length=240)
    claim: str = Field(min_length=1, max_length=500)
    supporting_text: str = Field(min_length=1, max_length=800)


class RecruitingEmploymentEvidence(PrivacySafeModel):
    """Structured, self-reported prior-employment evidence for eligibility review."""

    employer: str = Field(min_length=1, max_length=320)
    role: str | None = Field(default=None, max_length=240)
    start_date: str | None = Field(default=None, max_length=40)
    end_date: str | None = Field(default=None, max_length=40)
    engagement_type: str | None = Field(default=None, max_length=80)
    supporting_text: str | None = Field(default=None, max_length=1_000)
    source_field: str = Field(default="prior_employers", max_length=240)
    verification_status: str = Field(default="self_reported", max_length=40)


class RecruitingRankingSnapshot(PrivacySafeModel):
    """Exact scalar output imported from the shared People Portal + Gitea pipeline."""

    artifact_schema: str = Field(default="horizon.shared-ranking.v1", max_length=80)
    pipeline_run_id: str = Field(min_length=1, max_length=160)
    artifact_sha256: str = Field(min_length=1, max_length=128)
    export_manifest_sha256: str = Field(min_length=1, max_length=128)
    result_sha256: str | None = Field(default=None, max_length=128)
    ranking_status: str = Field(default="current_provisional", max_length=80)
    rubric_version: str = Field(min_length=1, max_length=160)
    combined_rank: int | None = Field(default=None, ge=1)
    builder_rank: int | None = Field(default=None, ge=1)
    technical_leadership_rank: int | None = Field(default=None, ge=1)
    technical_execution_score: float | None = Field(default=None, ge=0, le=5)
    technical_leadership_score: float | None = Field(default=None, ge=0, le=5)
    club_contribution_score: float | None = Field(default=None, ge=0, le=5)
    combined_score: float | None = Field(default=None, ge=0, le=5)
    evidence_completeness: str | None = Field(default=None, max_length=80)
    ranking_eligibility: str | None = Field(default=None, max_length=80)
    exclusion_status: str | None = Field(default=None, max_length=80)
    human_review_required: bool = True
    review_priority: str | None = Field(default=None, max_length=80)
    gitea_data_quality_status: str | None = Field(default=None, max_length=80)
    analytical_notes: str | None = Field(default=None, max_length=1_000)


class RecruitingSourceCandidateDocument(PHIDocument):
    """Normalized People Portal candidate evidence plus optional Gitea stats."""

    evidence_reviewed_for_scoring: bool = False
    person_id: str | None = None
    people_portal_member_pk: int | None = Field(default=None, ge=1)
    gitea_logins: list[str] = Field(default_factory=list)
    canonical_stats: bool = False
    source_run_id: str = Field(min_length=1, max_length=100)
    source_generated_at: datetime = Field(default_factory=utc_now)
    member_login: str = Field(min_length=1, max_length=320)
    member_name: str = Field(min_length=1, max_length=320)
    email: str | None = Field(default=None, max_length=320)
    applicant_id: str | None = Field(default=None, max_length=200)
    member_stats: RecruitingMemberStats = Field(default_factory=RecruitingMemberStats)
    interview_score: float | None = Field(default=None, ge=0, le=5)
    interview_summary: str | None = Field(default=None, max_length=2_000)
    interview_evidence: list[str] = Field(default_factory=list, max_length=20)
    resume_summary: str | None = Field(default=None, max_length=3_000)
    resume_evidence: list[str] = Field(default_factory=list, max_length=30)
    # Display-only context. The scoring pipeline deliberately does not read it.
    prior_employers: list[str] = Field(default_factory=list, max_length=20)
    prior_employment_evidence: list[RecruitingEmploymentEvidence] = Field(default_factory=list, max_length=30)
    eligibility_status: RecruitingEligibilityStatus = RecruitingEligibilityStatus.NEEDS_REVIEW
    eligibility_reasons: list[str] = Field(default_factory=list, max_length=10)
    eligibility_evidence: list[RecruitingEvidenceReference] = Field(default_factory=list, max_length=20)
    eligibility_reviewed_by: str | None = Field(default=None, max_length=200)
    eligibility_reviewed_at: datetime | None = None
    source_status: str = Field(default="complete", max_length=40)
    source_refs: list[RecruitingEvidenceReference] = Field(default_factory=list, max_length=100)
    ranking: RecruitingRankingSnapshot | None = None

    class Settings:
        name = "recruiting_candidates"


class RecruitingSourceRunDocument(PHIDocument):
    """Immutable source envelope, including a valid empty candidate snapshot."""
    source_run_id: str = Field(min_length=1, max_length=100)
    generated_at: datetime
    payload_sha256: str
    ingested_at: datetime = Field(default_factory=utc_now)
    source_system: str = Field(default="people_portal_payload", max_length=80)
    source_warnings: list[str] = Field(default_factory=list, max_length=50)
    member_analytics_run_id: str | None = None
    candidate_count: int = Field(ge=0)
    ranking_pipeline_run_id: str | None = Field(default=None, max_length=160)
    ranking_artifact_sha256: str | None = Field(default=None, max_length=128)
    ranking_export_manifest_sha256: str | None = Field(default=None, max_length=128)
    ranking_result_sha256: str | None = Field(default=None, max_length=128)
    ranking_status: str | None = Field(default=None, max_length=80)
    ranking_rubric_version: str | None = Field(default=None, max_length=160)

    class Settings:
        name = "recruiting_sources"


class RecruitingRunDocument(PHIDocument):
    """One immutable-ish provisional ranking run; later reviews are separate rows."""

    run_id: str = Field(min_length=1, max_length=100)
    generated_at: datetime = Field(default_factory=utc_now)
    model: str = Field(default="deterministic-rubric-v1", max_length=160)
    input_fingerprint: str | None = None
    signal_version: str = Field(default="recruiting-v1", max_length=80)
    member_analytics_run_id: str | None = Field(default=None, max_length=100)
    people_portal_source_run_id: str | None = Field(default=None, max_length=100)
    candidate_count: int = Field(default=0, ge=0)
    reviewed_count: int = Field(default=0, ge=0)
    llm_used: bool = False
    source_warnings: list[str] = Field(default_factory=list, max_length=30)
    scoring_policy: dict[str, Any] = Field(default_factory=dict)
    excluded_candidates: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    needs_review_count: int = Field(default=0, ge=0)

    class Settings:
        name = "recruiting_runs"


class RecruitingSignalDocument(PHIDocument):
    """Provisional signal for one candidate, before human confirmation."""

    run_id: str = Field(min_length=1, max_length=100)
    member_login: str = Field(min_length=1, max_length=320)
    member_name: str = Field(min_length=1, max_length=320)
    source_candidate: RecruitingSourceCandidateDocument | None = None
    provisional_rank: int | None = Field(default=None, ge=1)
    provisional_score: float | None = Field(default=None, ge=0, le=100)
    signal_band: RecruitingSignalBand
    contribution_score: float | None = Field(default=None, ge=0, le=100)
    ability_score: float | None = Field(default=None, ge=0, le=100)
    resume_score: float | None = Field(default=None, ge=0, le=100)
    interview_score: float | None = Field(default=None, ge=0, le=100)
    evidence_quality_score: float = Field(default=0, ge=0, le=100)
    score_breakdown: dict[str, float | None] = Field(default_factory=dict)
    evidence_claims: list[RecruitingEvidenceClaim] = Field(default_factory=list, max_length=30)
    contradictions: list[str] = Field(default_factory=list, max_length=10)
    duplicate_flags: list[str] = Field(default_factory=list, max_length=10)
    review_flags: list[str] = Field(default_factory=list, max_length=15)
    rationale: str = Field(min_length=1, max_length=2_000)
    strengths: list[str] = Field(default_factory=list, max_length=10)
    caveats: list[str] = Field(default_factory=list, max_length=15)
    evidence_refs: list[RecruitingEvidenceReference] = Field(default_factory=list, max_length=100)
    review_status: RecruitingReviewStatus = RecruitingReviewStatus.PENDING
    eligibility_status: RecruitingEligibilityStatus = RecruitingEligibilityStatus.NEEDS_REVIEW
    eligibility_reasons: list[str] = Field(default_factory=list, max_length=10)
    eligibility_evidence: list[RecruitingEvidenceReference] = Field(default_factory=list, max_length=20)
    eligibility_reviewed_by: str | None = Field(default=None, max_length=200)
    eligibility_reviewed_at: datetime | None = None
    reviewer_rank: int | None = Field(default=None, ge=1)
    reviewer_note: str | None = Field(default=None, max_length=2_000)
    reviewed_by: str | None = Field(default=None, max_length=200)
    reviewed_at: datetime | None = None

    class Settings:
        name = "recruiting_signals"


class RecruitingReviewDocument(PHIDocument):
    """Human decision attached to a provisional signal."""

    run_id: str = Field(min_length=1, max_length=100)
    member_login: str = Field(min_length=1, max_length=320)
    reviewer_user_id: str = Field(min_length=1, max_length=200)
    decision: RecruitingDecision
    final_rank: int | None = Field(default=None, ge=1)
    eligibility_decision: RecruitingEligibilityStatus | None = None
    note: str | None = Field(default=None, max_length=2_000)
    created_at: datetime = Field(default_factory=utc_now)

    class Settings:
        name = "recruiting_reviews"
