"""Project roster and Gitea pull request source rows (T1.1).

Pure models and parsing only: no network, no database. The People Portal
payload is validated with pydantic, so a malformed member fails the asset
instead of silently dropping out of every later track.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator

SeasonType = Literal["FALL", "SPRING"]

_SEMESTERS_FILE = Path(__file__).parent / "semesters.yaml"


class PeoplePortalPayloadError(ValueError):
    """The People Portal projects payload is malformed or inconsistent."""


class _Payload(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


def _non_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("must not be blank")
    return value


class PeoplePortalMember(_Payload):
    user_pk: str = Field(alias="userPk")
    username: str
    email: str
    name: str
    roles: list[str]
    role_titles: dict[str, str] = Field(alias="roleTitles")
    tenure_semesters: StrictInt = Field(alias="tenureSemesters", ge=0)

    _pk = field_validator("user_pk")(_non_blank)


class PeoplePortalProject(_Payload):
    project_pk: str = Field(alias="projectPk")
    name: str
    friendly_name: str = Field(alias="friendlyName")
    team_start_date: date | None = Field(alias="teamStartDate")
    team_end_date: date | None = Field(alias="teamEndDate")
    archived: StrictBool
    members: list[PeoplePortalMember]

    _pk = field_validator("project_pk", "name")(_non_blank)


class PeoplePortalProjects(_Payload):
    season_type: SeasonType = Field(alias="seasonType")
    season_year: StrictInt = Field(alias="seasonYear", ge=2000, le=2200)
    generated_at: datetime = Field(alias="generatedAt")
    role_mapping_version: str = Field(alias="roleMappingVersion")
    projects: list[PeoplePortalProject]

    _version = field_validator("role_mapping_version")(_non_blank)


@dataclass(frozen=True)
class ProjectRow:
    project_pk: str
    season_type: str
    season_year: int
    name: str
    gitea_org: str
    friendly_name: str
    window_start: date
    window_end: date
    archived: bool


@dataclass(frozen=True)
class ProjectMemberRow:
    project_pk: str
    authentik_user_pk: str
    username: str
    email: str
    display_name: str
    roles: tuple[str, ...]
    role_titles: dict[str, str]
    tenure_semesters: int
    role_mapping_version: str


@dataclass(frozen=True)
class ProjectSources:
    """One validated People Portal snapshot for a semester."""

    season_type: str
    season_year: int
    role_mapping_version: str
    projects: list[ProjectRow]
    members: list[ProjectMemberRow]
    retrieved_at: datetime


@dataclass(frozen=True)
class ProjectRepositoryRow:
    project_pk: str
    organization: str
    repository: str
    default_branch: str


@dataclass(frozen=True)
class GiteaPullRequestRow:
    organization: str
    repository: str
    number: int
    title: str
    body: str
    author_login: str
    author_pk: str | None
    state: str
    merged: bool
    created_at: datetime
    merged_at: datetime | None
    closed_at: datetime | None
    base_branch: str | None
    head_branch: str | None
    html_url: str


@dataclass(frozen=True)
class GiteaPRReviewRow:
    organization: str
    repository: str
    pr_number: int
    review_id: int
    reviewer_login: str
    reviewer_pk: str | None
    state: str
    submitted_at: datetime | None


@dataclass(frozen=True)
class GiteaPRReviewRequestRow:
    organization: str
    repository: str
    pr_number: int
    event_id: int
    requested_login: str
    requested_pk: str | None
    requested_at: datetime


@dataclass(frozen=True)
class PullRequestSources:
    """Every PR, review and review request for the season's project repositories."""

    pull_requests: list[GiteaPullRequestRow]
    reviews: list[GiteaPRReviewRow]
    review_requests: list[GiteaPRReviewRequestRow]
    # org/repo -> (PR total Gitea reported, PR rows fetched)
    pull_request_totals: dict[str, tuple[int, int]] = field(default_factory=dict)
    retrieved_at: datetime | None = None


@lru_cache(maxsize=1)
def _semester_defaults() -> dict:
    return yaml.safe_load(_SEMESTERS_FILE.read_text()) or {}


def semester_window(season_type: str, season_year: int) -> tuple[date, date]:
    """Default (start, end) for a semester from semesters.yaml."""

    entry = (_semester_defaults().get(season_type) or {}).get(season_year)
    if not entry or "start" not in entry or "end" not in entry:
        raise PeoplePortalPayloadError(
            f"No default window for {season_type} {season_year} in pipeline/semesters.yaml."
        )
    start, end = entry["start"], entry["end"]
    if not isinstance(start, date) or not isinstance(end, date) or end < start:
        raise PeoplePortalPayloadError(
            f"semesters.yaml has an invalid window for {season_type} {season_year}."
        )
    return start, end


def project_window(
    project: PeoplePortalProject, season_type: str, season_year: int
) -> tuple[date, date]:
    """teamStartDate/teamEndDate, falling back to the semester default per side."""

    default_start, default_end = semester_window(season_type, season_year)
    start = project.team_start_date or default_start
    end = project.team_end_date or default_end
    if end < start:
        raise PeoplePortalPayloadError(
            f"Project {project.project_pk} ends ({end}) before it starts ({start})."
        )
    return start, end


def parse_project_sources(
    payload: object,
    season_type: str,
    season_year: int,
    retrieved_at: datetime,
) -> ProjectSources:
    """Validate the T3.1 payload and flatten it into table rows."""

    try:
        parsed = PeoplePortalProjects.model_validate(payload)
    except ValueError as error:
        # pydantic's message names the field path; never echo member values.
        raise PeoplePortalPayloadError(
            f"People Portal projects payload is malformed: {_error_locations(error)}"
        ) from None

    if (parsed.season_type, parsed.season_year) != (season_type, season_year):
        raise PeoplePortalPayloadError(
            f"People Portal returned {parsed.season_type} {parsed.season_year}, "
            f"expected {season_type} {season_year}."
        )

    projects: list[ProjectRow] = []
    members: list[ProjectMemberRow] = []
    seen_projects: set[str] = set()
    for project in parsed.projects:
        if project.project_pk in seen_projects:
            raise PeoplePortalPayloadError(
                f"People Portal returned project {project.project_pk} twice."
            )
        seen_projects.add(project.project_pk)
        start, end = project_window(project, season_type, season_year)
        projects.append(
            ProjectRow(
                project_pk=project.project_pk,
                season_type=season_type,
                season_year=season_year,
                name=project.name,
                gitea_org=project.name,  # the Authentik group name is the Gitea org
                friendly_name=project.friendly_name,
                window_start=start,
                window_end=end,
                archived=project.archived,
            )
        )
        seen_members: set[str] = set()
        for member in project.members:
            if member.user_pk in seen_members:
                raise PeoplePortalPayloadError(
                    f"Project {project.project_pk} lists member {member.user_pk} twice."
                )
            seen_members.add(member.user_pk)
            members.append(
                ProjectMemberRow(
                    project_pk=project.project_pk,
                    authentik_user_pk=member.user_pk,
                    username=member.username,
                    email=member.email,
                    display_name=member.name,
                    roles=tuple(member.roles),
                    role_titles=dict(member.role_titles),
                    tenure_semesters=member.tenure_semesters,
                    role_mapping_version=parsed.role_mapping_version,
                )
            )

    return ProjectSources(
        season_type=season_type,
        season_year=season_year,
        role_mapping_version=parsed.role_mapping_version,
        projects=projects,
        members=members,
        retrieved_at=retrieved_at,
    )


def _error_locations(error: ValueError) -> str:
    errors = getattr(error, "errors", None)
    if not callable(errors):
        return "invalid payload"
    locations = [".".join(str(part) for part in item["loc"]) for item in errors()]
    return ", ".join(sorted(set(locations))[:10]) or "invalid payload"
