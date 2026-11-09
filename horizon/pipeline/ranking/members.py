"""Who is ranked in which role: pure logic over T1.1's project roster rows.

The Fall 2026 pilot ranks engineers and tech leads only. A member holding both
roles is ranked once, as a tech lead. Members whose roles are only project_lead,
pm, designer or unknown are not ranked.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo

CLUB_TIMEZONE = ZoneInfo("America/New_York")
TECH_LEAD_GROUP = "club:tech_lead"


@dataclass(frozen=True)
class ProjectRow:
    """The columns of ``horizon_gt_features.projects`` this step reads."""

    project_pk: str
    season_type: str
    season_year: int
    name: str
    friendly_name: str
    window_start: date
    window_end: date
    archived: bool


@dataclass(frozen=True)
class ProjectMemberRow:
    """The columns of ``horizon_gt_features.project_members`` this step reads."""

    project_pk: str
    authentik_user_pk: str
    username: str | None
    display_name: str | None
    roles: tuple[str, ...]
    role_titles: dict[str, str]
    tenure_semesters: int
    role_mapping_version: str


@dataclass(frozen=True)
class RankedMember:
    """One ``horizon_ranking.ranked_members`` row, minus the run id."""

    authentik_user_pk: str
    project_pk: str
    role: str
    display_name: str
    role_title: str | None
    project_name: str
    comparison_group: str
    tenure_semesters: int
    window_start: date
    window_end: date


class RoleMappingError(ValueError):
    """The season's roster does not carry exactly one role mapping version."""


def ranked_role(roles: Iterable[str]) -> str | None:
    """Return the role a member is ranked as, or None when they are not ranked."""

    held = set(roles)
    if "tech_lead" in held:
        return "tech_lead"
    if "engineer" in held:
        return "engineer"
    return None


def comparison_group(role: str, project_pk: str) -> str:
    if role == "tech_lead":
        return TECH_LEAD_GROUP
    return f"project:{project_pk}:engineer"


def select_ranked_members(
    projects: Sequence[ProjectRow],
    members: Sequence[ProjectMemberRow],
    as_of: datetime,
) -> list[RankedMember]:
    """Snapshot one row per ranked (member, project), skipping archived projects.

    ``window_end`` is capped at the ``as_of`` date in the club's timezone, so a
    mid-semester run never measures days that have not happened yet.
    """

    if as_of.tzinfo is None:
        raise ValueError("as_of must be timezone-aware")
    as_of_date = as_of.astimezone(CLUB_TIMEZONE).date()
    live_projects = {
        project.project_pk: project for project in projects if not project.archived
    }

    ranked: list[RankedMember] = []
    for member in members:
        project = live_projects.get(member.project_pk)
        if project is None:
            continue
        role = ranked_role(member.roles)
        if role is None:
            continue
        ranked.append(
            RankedMember(
                authentik_user_pk=member.authentik_user_pk,
                project_pk=project.project_pk,
                role=role,
                display_name=_display_name(member),
                role_title=_role_title(member.role_titles),
                project_name=project.friendly_name,
                comparison_group=comparison_group(role, project.project_pk),
                tenure_semesters=member.tenure_semesters,
                window_start=project.window_start,
                window_end=min(project.window_end, as_of_date),
            )
        )
    return sorted(ranked, key=lambda row: (row.project_pk, row.authentik_user_pk))


def resolve_role_mapping_version(
    projects: Sequence[ProjectRow],
    members: Sequence[ProjectMemberRow],
) -> str:
    """Return the one role mapping version used by the season's live roster."""

    live = {project.project_pk for project in projects if not project.archived}
    versions = {
        member.role_mapping_version for member in members if member.project_pk in live
    }
    if not versions:
        raise RoleMappingError(
            "No project members found for this season's non-archived projects."
        )
    if len(versions) > 1:
        raise RoleMappingError(
            f"Project members carry mixed role mapping versions: {sorted(versions)}."
        )
    return versions.pop()


def _display_name(member: ProjectMemberRow) -> str:
    for candidate in (member.display_name, member.username):
        if candidate and candidate.strip():
            return candidate.strip()
    return member.authentik_user_pk


def _role_title(role_titles: dict[str, str]) -> str | None:
    titles = sorted(
        {title.strip() for title in role_titles.values() if title and title.strip()}
    )
    return ", ".join(titles) or None
