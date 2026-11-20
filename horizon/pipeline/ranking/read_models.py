"""T4.5 read models: the published ranking document and its leaderboard row.

``RankingDocument`` is the exact shape stored in
``horizon_api.ranking_member_detail.document``; the API returns it unchanged
and T6.2 imports these field names. The builders are pure, so the publisher
and its tests share one definition of what a member page shows.

Horizon is open to everyone, so a document carries only allowlisted evidence:
counts, dates, repository and PR labels, never other people's ids or survey
answers.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .members import RankedMember
from .rubric import RoleRubric

Status = Literal["ranked", "insufficient_data", "group_too_small"]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, allow_inf_nan=False)


class DocumentMember(_Contract):
    user_pk: str = Field(alias="userPk", min_length=1)
    name: str
    role: Literal["engineer", "tech_lead"]
    role_title: str | None = Field(alias="roleTitle")
    project_pk: str = Field(alias="projectPk", min_length=1)
    project_name: str = Field(alias="projectName")


class DocumentOverall(_Contract):
    status: Status
    score: float | None = Field(ge=0, le=100)
    coverage: float = Field(ge=0, le=1)
    rank_in_group: int | None = Field(alias="rankInGroup", ge=1)
    ranked_in_group: int | None = Field(alias="rankedInGroup", ge=1)
    comparison_group: str = Field(alias="comparisonGroup")
    comparison_group_label: str = Field(alias="comparisonGroupLabel")


class DocumentMetric(_Contract):
    key: str
    label: str
    unit: str
    direction: Literal["higher_is_better", "lower_is_better"]
    share: float = Field(ge=0, le=1)
    raw_value: float | None = Field(alias="rawValue")
    percentile: float | None = Field(ge=0, le=100)
    group_size: int | None = Field(alias="groupSize", ge=0)
    missing_reason: str | None = Field(alias="missingReason")
    evidence: dict[str, Any]


class DocumentBucket(_Contract):
    key: str
    label: str
    weight: float = Field(ge=0, le=1)
    score: float | None = Field(ge=0, le=100)
    metric_coverage: float = Field(alias="metricCoverage", ge=0, le=1)
    note: str | None
    metrics: list[DocumentMetric]


class DocumentExplanation(_Contract):
    summary: str
    data_gaps: list[str] = Field(alias="dataGaps")
    model: str
    generated: bool


class DocumentHistory(_Contract):
    ranking_run_id: str = Field(alias="rankingRunId")
    as_of: str = Field(alias="asOf")
    status: Status
    overall_score: float | None = Field(alias="overallScore", ge=0, le=100)
    rank_in_group: int | None = Field(alias="rankInGroup", ge=1)


class RankingDocument(_Contract):
    ranking_run_id: str = Field(alias="rankingRunId", min_length=1)
    as_of: str = Field(alias="asOf")
    rubric_version: str = Field(alias="rubricVersion", min_length=1)
    member: DocumentMember
    overall: DocumentOverall
    buckets: list[DocumentBucket]
    explanation: DocumentExplanation | None
    history: list[DocumentHistory]


@dataclass(frozen=True)
class StoredMetric:
    """A scored ``metric_values`` row."""

    raw_value: float | None
    missing_reason: str | None
    percentile: float | None
    group_size: int | None
    evidence: Mapping[str, Any]


@dataclass(frozen=True)
class StoredScore:
    """A ``member_scores`` row; ``buckets`` is its JSONB column."""

    buckets: Mapping[str, Mapping[str, float | None]]
    overall_score: float | None
    coverage: float
    status: str
    rank_in_group: int | None
    ranked_in_group: int | None
    explanation: Mapping[str, Any] | None = None


def comparison_group_label(member: RankedMember) -> str:
    if member.role == "tech_lead":
        return "All tech leads"
    return f"Engineers on {member.project_name}"


# Evidence keys the metric steps write that are safe to show anyone. Lists of
# other members (review spread) are published as counts only.
_PUBLIC_EVIDENCE = frozenset({
    "per_repository", "source_runs", "log1p", "surviving_lines", "active_weeks",
    "weeks_in_window", "rows_by_source", "gap_start", "gap_end", "activity_dates",
    "late_start", "window_start", "window_end", "late_lines", "total_lines", "commits",
    "source", "pull_requests", "requests", "respondent_count", "rounds_counted",
    "today", "tasks", "project_run_id", "due_task_count",
})
_COUNTED_EVIDENCE = {"engineers_with_prs": "engineer_count", "engineers_reviewed": "reviewed_engineer_count"}


def public_evidence(evidence: Mapping[str, Any] | None) -> dict[str, Any]:
    if not isinstance(evidence, Mapping):
        return {}
    public = {key: value for key, value in evidence.items() if key in _PUBLIC_EVIDENCE}
    for key, count_key in _COUNTED_EVIDENCE.items():
        if isinstance(evidence.get(key), list):
            public[count_key] = len(evidence[key])
    return public


def public_explanation(stored: Mapping[str, Any] | None) -> tuple[dict | None, dict[str, str]]:
    """The document's explanation block and the bucket notes, from T4.6's column."""

    if not stored:
        return None, {}
    explanation = DocumentExplanation(
        summary=stored["summary"], dataGaps=list(stored.get("data_gaps", [])),
        model=stored["model"], generated=bool(stored["generated"]),
    )
    notes = {key: note for key, note in (stored.get("bucket_notes") or {}).items() if isinstance(note, str)}
    return explanation.model_dump(by_alias=True), notes


def build_document(
    *,
    ranking_run_id: str,
    as_of: datetime,
    rubric_version: str,
    member: RankedMember,
    role_rubric: RoleRubric,
    score: StoredScore,
    metrics: Mapping[str, StoredMetric],
    history: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """The member page document, validated against ``RankingDocument``."""

    explanation, notes = public_explanation(score.explanation)
    weights = role_rubric.effective_weights(member.excluded_buckets)
    buckets = []
    for bucket in role_rubric.buckets:
        if bucket.key not in weights:
            continue
        stored = score.buckets.get(bucket.key, {})
        buckets.append({
            "key": bucket.key, "label": bucket.label, "weight": weights[bucket.key] / 100,
            "score": stored.get("score"), "metricCoverage": stored.get("metricCoverage", 0.0),
            "note": notes.get(bucket.key),
            "metrics": [
                {
                    "key": metric.key, "label": metric.label, "unit": metric.unit,
                    "direction": metric.direction, "share": metric.share / 100,
                    "rawValue": metrics[metric.key].raw_value,
                    "percentile": metrics[metric.key].percentile,
                    "groupSize": metrics[metric.key].group_size,
                    "missingReason": metrics[metric.key].missing_reason,
                    "evidence": public_evidence(metrics[metric.key].evidence),
                }
                for metric in bucket.metrics
            ],
        })
    document = {
        "rankingRunId": ranking_run_id,
        "asOf": as_of.isoformat(),
        "rubricVersion": rubric_version,
        "member": {
            "userPk": member.authentik_user_pk, "name": member.display_name, "role": member.role,
            "roleTitle": member.role_title, "projectPk": member.project_pk,
            "projectName": member.project_name,
        },
        "overall": {
            "status": score.status, "score": score.overall_score, "coverage": score.coverage,
            "rankInGroup": score.rank_in_group, "rankedInGroup": score.ranked_in_group,
            "comparisonGroup": member.comparison_group,
            "comparisonGroupLabel": comparison_group_label(member),
        },
        "buckets": buckets,
        "explanation": explanation,
        "history": [dict(entry) for entry in history],
    }
    return RankingDocument.model_validate(document).model_dump(by_alias=True)


def leaderboard_row(
    *, ranking_run_id: str, season_type: str, season_year: int, as_of: datetime,
    member: RankedMember, score: StoredScore,
) -> tuple:
    """One ``horizon_api.ranking_leaderboard`` row, in column order."""

    return (
        ranking_run_id, season_type, season_year, as_of, member.authentik_user_pk,
        member.project_pk, member.display_name, member.project_name, member.role,
        member.comparison_group, comparison_group_label(member), score.status,
        score.overall_score, score.coverage, score.rank_in_group, score.ranked_in_group,
        member.tenure_semesters,
        {key: value.get("score") for key, value in score.buckets.items()},
    )


LEADERBOARD_COLUMNS = (
    "ranking_run_id", "season_type", "season_year", "as_of", "authentik_user_pk",
    "project_pk", "display_name", "project_name", "role", "comparison_group",
    "comparison_group_label", "status", "overall_score", "coverage", "rank_in_group",
    "ranked_in_group", "tenure_semesters", "bucket_scores",
)
