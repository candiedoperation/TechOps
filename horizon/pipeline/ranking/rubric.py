"""Load and validate a versioned ranking rubric from ``rubrics/<version>.yaml``.

Weights and shares are percentages in the file. The loader rejects a rubric
whose bucket weights per role, or metric shares per bucket, do not each sum to
100, so a typo can never silently rescale a score.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

RUBRICS_DIR = Path(__file__).parent / "rubrics"

_SUM_TOLERANCE = 1e-9

Unit = Literal[
    "lines", "files", "commits", "PRs", "hours", "ratio", "rating_1_3", "semesters"
]
Direction = Literal["higher_is_better", "lower_is_better"]
RankedRole = Literal["engineer", "tech_lead"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Metric(_Strict):
    key: str = Field(min_length=1)
    label: str = Field(min_length=1)
    unit: Unit
    share: float = Field(gt=0, le=100)
    direction: Direction

    @field_validator("label")
    @classmethod
    def _label_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("metric label must not be blank")
        return value


class Bucket(_Strict):
    key: str = Field(min_length=1)
    label: str = Field(min_length=1)
    weight: float = Field(gt=0, le=100)
    metrics: tuple[Metric, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def _shares_sum_to_100(self) -> Bucket:
        total = sum(metric.share for metric in self.metrics)
        if not math.isclose(total, 100, abs_tol=_SUM_TOLERANCE):
            raise ValueError(
                f"metric shares in bucket {self.key!r} sum to {total:g}, not 100"
            )
        return self


class RoleRubric(_Strict):
    comparison_group: Literal["project", "club"]
    buckets: tuple[Bucket, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def _weights_sum_to_100_and_keys_are_unique(self) -> RoleRubric:
        total = sum(bucket.weight for bucket in self.buckets)
        if not math.isclose(total, 100, abs_tol=_SUM_TOLERANCE):
            raise ValueError(f"bucket weights sum to {total:g}, not 100")
        bucket_keys = [bucket.key for bucket in self.buckets]
        if len(set(bucket_keys)) != len(bucket_keys):
            raise ValueError("bucket keys must be unique within a role")
        metric_keys = [metric.key for bucket in self.buckets for metric in bucket.metrics]
        if len(set(metric_keys)) != len(metric_keys):
            raise ValueError("metric keys must be unique within a role")
        return self


class RubricRules(_Strict):
    min_coverage: float = Field(ge=0, le=1)
    min_group_size: int = Field(ge=2)


class Rubric(_Strict):
    version: str = Field(min_length=1)
    rules: RubricRules
    roles: dict[RankedRole, RoleRubric]

    @model_validator(mode="after")
    def _every_ranked_role_has_a_rubric(self) -> Rubric:
        missing = {"engineer", "tech_lead"} - set(self.roles)
        if missing:
            raise ValueError(f"rubric has no buckets for role(s): {sorted(missing)}")
        return self


@dataclass(frozen=True)
class LoadedRubric:
    """A validated rubric plus what ``rubric_versions`` stores for it."""

    rubric: Rubric
    definition: dict
    sha256: str

    @property
    def version(self) -> str:
        return self.rubric.version


def load_rubric(version: str = "v1", path: Path | None = None) -> LoadedRubric:
    """Read, validate and hash one rubric file.

    The hash is over the file bytes, so any edit -- even to a label or a
    comment -- counts as a change to that version.
    """

    source = path or RUBRICS_DIR / f"{version}.yaml"
    raw = source.read_bytes()
    rubric = Rubric.model_validate(yaml.safe_load(raw))
    if rubric.version != version:
        raise ValueError(
            f"{source.name} declares version {rubric.version!r}, expected {version!r}"
        )
    return LoadedRubric(
        rubric=rubric,
        definition=rubric.model_dump(mode="json"),
        sha256=hashlib.sha256(raw).hexdigest(),
    )
