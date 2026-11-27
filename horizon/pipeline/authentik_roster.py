"""Read the project roster straight from Authentik, using People Portal's T3.1 rules.

People Portal's Horizon service API (T3.1, ``GET /api/horizon/projects``) is not
deployed yet. Until it is, this resource builds the identical payload itself from
the same Authentik data People Portal reads:

- a project is a root group with ``peoplePortalCreation`` and ``teamType=PROJECT``;
- its members come from the root group and its Leadership/Engineering subteams;
- each membership's role title is the user's ``attributes.roles[<group pk>]`` and
  is classified with a Python port of People Portal's ``normalizeRole`` and
  ``projectSubteamContext`` (``peopleportal/server/src/utils/roles.ts``);
- tenure is the number of distinct project seasons the user appears in.

The payload then goes through the same ``parse_project_sources`` validation as the
People Portal client, so every downstream asset sees the same rows either way.
Remove this module once T3.1 is live: point ``HORIZON_ROSTER_SOURCE`` back at
``peopleportal`` (the default).
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

import httpx

from .config import PipelineConfigError
from .project_sources import PeoplePortalPayloadError, ProjectSources, parse_project_sources
from .resources import PeoplePortalClient, PeoplePortalError

ROLE_MAPPING_VERSION = "authentik-direct-2026-11-v1"  # T3.1 rules 2026-11-v1, read without People Portal
ROLE_ORDER = ["project_lead", "tech_lead", "engineer", "pm", "designer", "unknown"]


def sanitize_group_name(value: str) -> str:
    """Port of People Portal's sanitizeGroupName."""
    return re.sub(r"[^A-Za-z0-9\-_]", "", value or "")


def subteam_context(project: dict, subteam: dict) -> str:
    """Port of People Portal's projectSubteamContext: 'Leadership', 'Engineering' or 'unknown'."""
    name = subteam.get("name")
    if name in ("Leadership", "Engineering"):
        return name
    attributes = project.get("attributes") or {}
    project_name, season_type, season_year = project.get("name"), attributes.get("seasonType"), attributes.get("seasonYear")
    if not project_name or not season_type or season_year in (None, ""):
        return "unknown"
    season = f"{season_type}{season_year}"
    technical = sanitize_group_name(project_name)
    suffix = sanitize_group_name(season)
    if not technical.endswith(suffix):
        return "unknown"
    managed_prefix = sanitize_group_name(technical[: -len(suffix)])
    friendly_prefix = sanitize_group_name(attributes.get("friendlyName") or "")
    for context in ("Leadership", "Engineering"):
        child_suffix = sanitize_group_name(f"{context}{season}")
        if name in (f"{managed_prefix}{child_suffix}", f"{technical}{child_suffix}"):
            return context
        if friendly_prefix and name == f"{friendly_prefix}{child_suffix}":
            return context
    return "unknown"


def normalize_role(context: str, title: str | None) -> str:
    """Port of People Portal's normalizeRole (one membership title -> Horizon role)."""
    title = (title or "").strip()
    if not title:
        return "unknown"
    if re.search(r"project\s*lead", title, re.I) and context in ("project", "Leadership"):
        return "project_lead"
    if context == "Leadership" and re.search(r"tech(nical)?\s*lead", title, re.I):
        return "tech_lead"
    if re.search(r"product\s*manager|\bpm\b", title, re.I):
        return "pm"
    if re.search(r"ui|ux|design", title, re.I):
        return "designer"
    if context == "Engineering" and re.search(
            r"engineer|developer|swe|\bml\b|backend|frontend|full.?stack|ios|android|mobile", title, re.I):
        return "engineer"
    return "unknown"


def build_roster(projects: list[dict]) -> list[dict]:
    """Port of People Portal's buildHorizonRoster over Authentik group details.

    Each item is a root group detail with ``users`` and ``subteams`` (each subteam
    with its own ``users``), as returned by :class:`AuthentikRosterClient`.
    """
    def users_of(project):
        return [*project.get("users", []), *(u for team in project.get("subteams", []) for u in team.get("users", []))]

    tenure: dict[str, set[str]] = {}
    for project in projects:
        attributes = project.get("attributes") or {}
        season = f"{attributes.get('seasonType')}:{attributes.get('seasonYear')}"
        for user in users_of(project):
            tenure.setdefault(str(user["pk"]), set()).add(season)

    records = []
    for project in projects:
        members: dict[str, dict] = {}

        def add(user: dict, group_pk: str, context: str) -> None:
            user_pk = str(user["pk"])
            member = members.setdefault(user_pk, {
                "userPk": user_pk, "username": user.get("username") or "", "email": user.get("email") or "",
                "name": user.get("name") or "", "roles": [], "roleTitles": {},
                "tenureSemesters": len(tenure.get(user_pk, ())),
            })
            title = ((user.get("attributes") or {}).get("roles") or {}).get(str(group_pk))
            if isinstance(title, str):
                member["roleTitles"][str(group_pk)] = title
            if not (title or "").strip():
                return
            role = normalize_role(context, title)
            if role not in member["roles"]:
                member["roles"].append(role)

        for user in project.get("users", []):
            add(user, project["pk"], "project")
        for subteam in project.get("subteams", []):
            context = subteam_context(project, subteam)
            for user in subteam.get("users", []):
                add(user, subteam["pk"], context)
        ordered = []
        for member in sorted(members.values(), key=lambda m: m["userPk"]):
            roles = sorted(member["roles"], key=ROLE_ORDER.index) or ["unknown"]
            ordered.append({**member, "roles": roles})
        attributes = project.get("attributes") or {}
        records.append({
            "projectPk": str(project["pk"]), "name": project["name"],
            "friendlyName": attributes.get("friendlyName") or project["name"],
            "teamStartDate": attributes.get("teamStartDate") or None,
            "teamEndDate": attributes.get("teamEndDate") or None,
            "archived": bool(attributes.get("archivedAt")), "members": ordered,
        })
    return records


class AuthentikRosterClient(PeoplePortalClient):
    """Drop-in ``peopleportal`` resource that reads the roster from Authentik directly."""

    authentik_url: str | None = None
    authentik_token: str | None = None
    user_agent: str = "Horizon-Pipeline/1.0"
    # Past-season backfill (HORIZON_INCLUDE_ARCHIVED): a finished season's teams
    # are archived afterwards but were active during that season.
    include_archived: bool = False

    def _client(self) -> httpx.Client:
        base = (self.authentik_url or "").strip().rstrip("/")
        token = (self.authentik_token or "").strip()
        if not base or not token:
            raise PipelineConfigError(
                "HORIZON_ROSTER_SOURCE=authentik needs HORIZON_AUTHENTIK_URL and HORIZON_AUTHENTIK_API_TOKEN.")
        return httpx.Client(base_url=base, timeout=self.timeout_seconds, follow_redirects=False,
                            headers={"Authorization": f"Bearer {token}", "Accept": "application/json",
                                     "User-Agent": self.user_agent})

    @staticmethod
    def _json(response: httpx.Response):
        if response.status_code >= 400:
            raise PeoplePortalError(f"Authentik {response.request.url.path} returned {response.status_code}.")
        try:
            return response.json()
        except ValueError as exc:
            raise PeoplePortalError(f"Authentik {response.request.url.path} did not return JSON.") from exc

    def _project_groups(self, client: httpx.Client) -> list[dict]:
        roots, page = [], 1
        while True:
            body = self._json(client.get("/api/v3/core/groups/", params={
                "include_users": "false", "include_children": "true", "page": page, "page_size": 100,
                "ordering": "name"}))
            for group in body.get("results", []):
                attributes = group.get("attributes") or {}
                parent = group.get("parent") or (group.get("parents") or [None])[0]
                if not parent and attributes.get("peoplePortalCreation") and attributes.get("teamType") == "PROJECT":
                    roots.append(group)
            pagination = body.get("pagination") or {}
            if not pagination.get("next"):
                return roots
            page += 1

    def _group(self, client: httpx.Client, pk: str) -> dict:
        return self._json(client.get(f"/api/v3/core/groups/{pk}/", params={
            "include_users": "true", "include_children": "true"}))

    def _detail(self, client: httpx.Client, root: dict) -> dict:
        detail = self._group(client, root["pk"])
        subteams = []
        for child in detail.get("children_obj") or []:
            child_detail = self._group(client, child["pk"])
            subteams.append({"pk": str(child["pk"]), "name": child.get("name"),
                             "attributes": child.get("attributes") or {},
                             "users": child_detail.get("users_obj") or []})
        return {"pk": str(detail["pk"]), "name": detail["name"], "attributes": detail.get("attributes") or {},
                "users": detail.get("users_obj") or [], "subteams": subteams}

    def get_projects(self, season_type: str, season_year: int) -> ProjectSources:
        try:
            with self._client() as client:
                details = [self._detail(client, root) for root in self._project_groups(client)]
        except httpx.HTTPError as exc:
            raise PeoplePortalError(f"Authentik roster request failed: {type(exc).__name__}.") from exc
        selected = {d["pk"] for d in details
                    if (d["attributes"].get("seasonType"), str(d["attributes"].get("seasonYear"))) ==
                    (season_type, str(season_year))}
        payload = {"seasonType": season_type, "seasonYear": season_year,
                   "generatedAt": datetime.now(timezone.utc).isoformat(),
                   "roleMappingVersion": ROLE_MAPPING_VERSION,
                   "projects": [{**p, "archived": p["archived"] and not self.include_archived}
                                for p in build_roster(details) if p["projectPk"] in selected]}
        try:
            return parse_project_sources(payload, season_type, season_year, datetime.now(timezone.utc))
        except PeoplePortalPayloadError as exc:
            raise PeoplePortalError(str(exc)) from exc

