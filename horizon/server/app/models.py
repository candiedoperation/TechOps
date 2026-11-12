"""T6.2 HTTP contract draft. Storage binding awaits Track 4/7 approval."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

SeasonType = Literal["FALL", "SPRING"]
Role = Literal["engineer", "tech_lead"]


class Model(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        allow_inf_nan=False,
    )


class Project(Model):
    project_pk: str
    friendly_name: str


class ErrorDetail(Model):
    code: str
    message: str


class ApiError(Model):
    error: ErrorDetail


class Me(Model):
    user_pk: str
    name: str
    is_exec: bool
    projects: list[Project]


class Semester(Model):
    season_type: SeasonType
    season_year: int = Field(ge=2000, le=2200)


class Bucket(Model):
    bucket_key: str
    weight: float = Field(ge=0, le=1)
    score: float | None = Field(default=None, ge=0, le=100)


class RankingRow(Model):
    user_pk: str
    name: str
    project_pk: str
    project_name: str
    role: Role
    comparison_group: str
    overall_score: float | None = Field(default=None, ge=0, le=100)
    coverage: float = Field(ge=0, le=1)
    status: Literal["ranked", "unranked", "insufficient_data"]
    rank_in_group: int | None = Field(default=None, ge=1)
    ranked_in_group: int = Field(ge=0)
    buckets: list[Bucket]

    @model_validator(mode="after")
    def missing_is_not_zero(self):
        if self.status == "insufficient_data" and (
            self.overall_score is not None or self.rank_in_group is not None
        ):
            raise ValueError("Insufficient-data rows cannot have a score or rank")
        if self.rank_in_group is not None and self.rank_in_group > self.ranked_in_group:
            raise ValueError("Rank exceeds group size")
        return self


class Run(Semester):
    ranking_run_id: UUID
    as_of: AwareDatetime
    is_final: bool
    rubric_version: str
    status: Literal["complete", "running", "failed"]


class RunMetadata(Model):
    ranking_run_id: UUID
    as_of: AwareDatetime
    is_final: bool
    rubric_version: str
    stale: bool


class RankingList(RunMetadata):
    items: list[RankingRow]
    page: int
    page_size: int
    total: int


class Metric(Model):
    metric_key: str
    raw_value: float | None = None
    percentile: float | None = Field(default=None, ge=0, le=100)
    missing_reason: str | None = None


class Evidence(Model):
    evidence_id: str
    source_type: str
    reference: str


class Explanation(Model):
    text: str
    model_version: str
    # Deliberately separate from evidence: never presented as a raw source fact.
    source_type: Literal["claude_generated"] = "claude_generated"


class MemberRow(Model):
    ranking: RankingRow
    metrics: list[Metric]
    evidence: list[Evidence]
    explanations: list[Explanation]


class History(Model):
    ranking_run_id: UUID
    as_of: AwareDatetime
    project_pk: str
    role: Role
    overall_score: float | None
    rank_in_group: int | None


class MemberDetail(RunMetadata):
    user_pk: str
    items: list[MemberRow]
    history: list[History]


def metadata(run: Run, now: datetime) -> dict:
    return {
        "ranking_run_id": run.ranking_run_id,
        "as_of": run.as_of,
        "is_final": run.is_final,
        "rubric_version": run.rubric_version,
        "stale": (now - run.as_of).total_seconds() > 8 * 86400,
    }
