"""People Portal integration used by Horizon's live recruiting sync.

The live source is the generated ``peopleportal_sdk`` client. Horizon keeps
the SDK transport behind this adapter so the ranking and persistence layers
continue to consume the bounded candidate envelope they already use. The
adapter deliberately does not download resumes or consume browser export files.
"""

from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any

from .artifacts import payload_digest


class PeoplePortalApiError(RuntimeError):
    """A safe, non-PII error raised for an upstream API failure."""

    def __init__(self, path: str, status_code: int | None = None) -> None:
        self.path = path
        self.status_code = status_code
        suffix = f" (HTTP {status_code})" if status_code is not None else ""
        super().__init__(f"People Portal SDK request failed: {path}{suffix}")


def _text(value: Any, *, limit: int = 2_000) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    return result[:limit] or None


def _normalized_email(value: Any) -> str | None:
    value = _text(value, limit=320)
    return value.casefold() if value else None


def _bounded_strings(value: Any, *, limit: int, item_limit: int = 800) -> list[str]:
    if isinstance(value, str):
        values = [part.strip() for part in value.replace(";", "\n").splitlines() if part.strip()]
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray, str)):
        values = [str(part).strip() for part in value if str(part).strip()]
    else:
        values = []
    return [item[:item_limit] for item in values[:limit]]


def _profile_value(profile: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if profile.get(key) not in (None, ""):
            return profile[key]
    return None


def _response_evidence(responses: Any) -> list[str]:
    if not isinstance(responses, Mapping):
        return []
    values: list[str] = []
    for key, value in responses.items():
        text = _text(value, limit=760)
        if text:
            values.append(f"{key}: {text}")
        if len(values) >= 20:
            break
    return values


def _plain(value: Any) -> Any:
    """Convert generated SDK models or response containers to JSON-shaped data."""

    if isinstance(value, Mapping):
        return {str(key): _plain(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_plain(child) for child in value]
    if isinstance(value, tuple):
        return [_plain(child) for child in value]
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return _plain(to_dict())
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return _plain(model_dump(by_alias=True, exclude_none=True))
    return value


class PeoplePortalSdkClient:
    """Thin async facade over the generated People Portal Python SDK.

    The checked-in SDK currently emits a few operations with an empty
    OpenAPI auth list and some operations with inconsistent deserialization.
    We therefore use each generated operation's ``*_without_preload_content``
    request method, pass the service bearer header explicitly, and parse the
    JSON response after the SDK has serialized path/query parameters.
    """

    #: express-session signs its cookie values and prefixes them with ``s:``
    #: (``s%3A`` once URL-encoded for transport). A credential in that shape is
    #: a browser session, not a service bearer, and must be replayed in the
    #: Cookie header -- People Portal reads ``req.session``, and a signed
    #: cookie presented as a bearer authenticates nothing.
    _SIGNED_COOKIE_PREFIXES = ("s:", "s%3A", "s%3a")

    #: The session cookie name People Portal configures in ``app.ts``.
    DEFAULT_COOKIE_NAME = "peopleportal_sid"

    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        timeout: float = 60.0,
        max_pages: int = 10_000,
        auth_mode: str = "auto",
        cookie_name: str = DEFAULT_COOKIE_NAME,
    ) -> None:
        try:
            from peopleportal_sdk.api.applicant_portal_api import ApplicantPortalApi
            from peopleportal_sdk.api.people_management_api import PeopleManagementApi
            from peopleportal_sdk.api.project_catalog_api import ProjectCatalogApi
            from peopleportal_sdk.api.recruitment_actions_api import RecruitmentActionsApi
            from peopleportal_sdk.api.team_configuration_api import TeamConfigurationApi
            from peopleportal_sdk.api.team_management_api import TeamManagementApi
            from peopleportal_sdk.api_client import ApiClient
            from peopleportal_sdk.configuration import Configuration
        except ImportError as exc:  # pragma: no cover - misconfigured deployment
            raise PeoplePortalApiError("peopleportal_sdk (install the generated SDK package)") from exc

        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.max_pages = max(1, int(max_pages))
        self.cookie_name = cookie_name
        mode = (auth_mode or "auto").strip().casefold()
        if mode not in {"auto", "bearer", "cookie"}:
            raise PeoplePortalApiError(f"unknown People Portal auth mode: {mode}")
        if mode == "auto":
            mode = "cookie" if token.startswith(self._SIGNED_COOKIE_PREFIXES) else "bearer"
        self.auth_mode = mode
        configuration = Configuration(
            host=self.base_url,
            access_token=token,
            ignore_operation_servers=True,
        )
        self._api_client = ApiClient(configuration)
        self._people = PeopleManagementApi(self._api_client)
        self._project_catalog = ProjectCatalogApi(self._api_client)
        self._teams = TeamManagementApi(self._api_client)
        self._team_configuration = TeamConfigurationApi(self._api_client)
        self._applicant_portal = ApplicantPortalApi(self._api_client)
        self._recruitment = RecruitmentActionsApi(self._api_client)

    def _auth_headers(self) -> dict[str, str]:
        """Return the credential header for the configured auth mode.

        A cookie session is an interactive credential: People Portal stores
        sessions in an in-process ``MemoryStore``, so one stops working at the
        upstream's next restart. It is supported for an operator-driven pull,
        not as a substitute for a service credential on a schedule.
        """

        # Read defensively: the adapter seam constructs this class through
        # ``__new__`` with only the transport fields set, and a service bearer
        # is the default credential for every caller that does.
        if getattr(self, "auth_mode", "bearer") == "cookie":
            cookie_name = getattr(self, "cookie_name", self.DEFAULT_COOKIE_NAME)
            return {"Cookie": f"{cookie_name}={self.token}"}
        return {"Authorization": f"Bearer {self.token}"}

    def _call_raw(self, api: Any, operation: str, path: str, **kwargs: Any) -> Any:
        method = getattr(api, f"{operation}_without_preload_content", None)
        if method is None:
            method = getattr(api, operation, None)
        if method is None:
            raise PeoplePortalApiError(path)

        kwargs["_headers"] = {**self._auth_headers(), "Accept": "application/json"}
        try:
            response = method(_request_timeout=self.timeout, **kwargs)
        except Exception as exc:  # SDK exception details may contain response data.
            status = getattr(exc, "status", None)
            raise PeoplePortalApiError(path, status if isinstance(status, int) else None) from exc

        status = getattr(response, "status", getattr(response, "status_code", 200))
        if hasattr(response, "read"):
            try:
                body = response.read()
            except Exception as exc:
                raise PeoplePortalApiError(path, status if isinstance(status, int) else None) from exc
        else:
            body = response
        if isinstance(status, int) and (status < 200 or status >= 300):
            raise PeoplePortalApiError(path, status)
        if isinstance(body, (bytes, bytearray)):
            try:
                body = body.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise PeoplePortalApiError(path, status if isinstance(status, int) else None) from exc
        if isinstance(body, str):
            try:
                return json.loads(body)
            except ValueError as exc:
                raise PeoplePortalApiError(path, status if isinstance(status, int) else None) from exc
        return _plain(body)

    async def _call(self, api: Any, operation: str, path: str, **kwargs: Any) -> Any:
        return await asyncio.to_thread(self._call_raw, api, operation, path, **kwargs)

    async def list_active_members(self) -> list[dict[str, Any]]:
        members: list[dict[str, Any]] = []
        page = 1
        while page <= self.max_pages:
            payload = await self._call(self._people, "get_people", "/api/org/people", page=page)
            if not isinstance(payload, Mapping) or not isinstance(payload.get("users"), list):
                raise PeoplePortalApiError("/api/org/people")
            members.extend(
                item for item in payload["users"]
                if isinstance(item, Mapping) and item.get("active", True) is not False
            )
            pagination = payload.get("pagination")
            if not isinstance(pagination, Mapping):
                if len(payload["users"]) < 20:
                    break
                page += 1
                continue
            current = int(pagination.get("current") or page)
            total_pages = int(pagination.get("total_pages") or current)
            if current >= total_pages:
                break
            page += 1
        else:
            raise PeoplePortalApiError("/api/org/people (pagination limit)")
        return [dict(item) for item in members]

    async def list_team_hierarchy(self) -> list[dict[str, Any]]:
        """Return root teams and their subteams with aggregateable member lists."""

        roots: list[dict[str, Any]] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()
        while True:
            payload = await self._call(
                self._teams,
                "get_teams",
                "/api/org/teams",
                subgroups_only=False,
                include_users=False,
                include_archived=False,
                limit=100,
                cursor=cursor,
            )
            if not isinstance(payload, Mapping) or not isinstance(payload.get("teams"), list):
                raise PeoplePortalApiError("/api/org/teams")
            roots.extend(item for item in payload["teams"] if isinstance(item, Mapping))
            next_cursor = _text(payload.get("nextCursor") or payload.get("next_cursor"), limit=4_000)
            if not next_cursor or next_cursor in seen_cursors:
                break
            seen_cursors.add(next_cursor)
            cursor = next_cursor

        rows: list[dict[str, Any]] = []
        for root in roots:
            root_id = _text(root.get("pk") or root.get("id"))
            if not root_id:
                continue
            try:
                detail = await self._call(
                    self._team_configuration,
                    "get_team_info",
                    f"/api/org/teams/{root_id}",
                    team_id=root_id,
                )
            except PeoplePortalApiError:
                # A missing detail record must not invent a team size. The
                # root metadata remains useful for a later retry.
                rows.append(dict(root))
                continue
            if not isinstance(detail, Mapping):
                rows.append(dict(root))
                continue
            root_detail = detail.get("team") if isinstance(detail.get("team"), Mapping) else {}
            root_row = {**dict(root), **dict(root_detail)}
            root_row["members"] = root_detail.get("users", [])
            rows.append(root_row)
            subteams = detail.get("subteams") or root_detail.get("subteams") or []
            if isinstance(subteams, list):
                for subteam in subteams:
                    if not isinstance(subteam, Mapping):
                        continue
                    subteam_row = dict(subteam)
                    subteam_row.setdefault("parent", root_id)
                    subteam_row["members"] = subteam.get("users", [])
                    rows.append(subteam_row)
        return rows

    def list_team_hierarchy_sync(self) -> list[dict[str, Any]]:
        """Synchronous counterpart used by Horizon's legacy sync adapter seam."""

        roots: list[dict[str, Any]] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()
        while True:
            payload = self._call_raw(
                self._teams,
                "get_teams",
                "/api/org/teams",
                subgroups_only=False,
                include_users=False,
                include_archived=False,
                limit=100,
                cursor=cursor,
            )
            if not isinstance(payload, Mapping) or not isinstance(payload.get("teams"), list):
                raise PeoplePortalApiError("/api/org/teams")
            roots.extend(item for item in payload["teams"] if isinstance(item, Mapping))
            next_cursor = _text(payload.get("nextCursor") or payload.get("next_cursor"), limit=4_000)
            if not next_cursor or next_cursor in seen_cursors:
                break
            seen_cursors.add(next_cursor)
            cursor = next_cursor

        rows: list[dict[str, Any]] = []
        for root in roots:
            root_id = _text(root.get("pk") or root.get("id"))
            if not root_id:
                continue
            try:
                detail = self._call_raw(
                    self._team_configuration,
                    "get_team_info",
                    f"/api/org/teams/{root_id}",
                    team_id=root_id,
                )
            except PeoplePortalApiError:
                rows.append(dict(root))
                continue
            if not isinstance(detail, Mapping):
                rows.append(dict(root))
                continue
            root_detail = detail.get("team") if isinstance(detail.get("team"), Mapping) else {}
            root_row = {**dict(root), **dict(root_detail)}
            root_row["members"] = root_detail.get("users", [])
            rows.append(root_row)
            subteams = detail.get("subteams") or root_detail.get("subteams") or []
            if isinstance(subteams, list):
                for subteam in subteams:
                    if not isinstance(subteam, Mapping):
                        continue
                    subteam_row = dict(subteam)
                    subteam_row.setdefault("parent", root_id)
                    subteam_row["members"] = subteam.get("users", [])
                    rows.append(subteam_row)
        return rows

    async def list_project_catalog(self, *, include_archived: bool = False) -> dict[str, Any]:
        """Fetch the bounded People Portal project catalog snapshot.

        The endpoint is a complete snapshot rather than a cursor-paginated
        collection. Its response is validated as an object with a projects
        array so a truncated or otherwise malformed upstream response cannot
        silently become an empty Horizon catalog.
        """

        payload = await self._call(
            self._project_catalog,
            "get_project_catalog",
            "/api/projects/catalog",
            include_archived=include_archived,
        )
        return self._validate_project_catalog(payload)

    def list_project_catalog_sync(self, *, include_archived: bool = False) -> dict[str, Any]:
        """Synchronous counterpart used by Horizon's batch staging adapter."""

        payload = self._call_raw(
            self._project_catalog,
            "get_project_catalog",
            "/api/projects/catalog",
            include_archived=include_archived,
        )
        return self._validate_project_catalog(payload)

    @staticmethod
    def _validate_project_catalog(payload: Any) -> dict[str, Any]:
        if not isinstance(payload, Mapping) or not isinstance(payload.get("projects"), list):
            raise PeoplePortalApiError("/api/projects/catalog")
        identity_issues = payload.get("identityIssues", payload.get("identity_issues", []))
        if not isinstance(identity_issues, list):
            raise PeoplePortalApiError("/api/projects/catalog")
        return {
            "observedAt": payload.get("observedAt", payload.get("observed_at")),
            "projects": [dict(item) for item in payload["projects"] if isinstance(item, Mapping)],
            "identityIssues": [dict(item) for item in identity_issues if isinstance(item, Mapping)],
        }

    async def list_recruiting_teams(self) -> list[dict[str, Any]]:
        payload = await self._call(
            self._applicant_portal,
            "get_all_recruiting_teams",
            "/api/ats/openteams",
        )
        return [dict(item) for item in payload if isinstance(item, Mapping)] if isinstance(payload, list) else []

    async def list_team_applications(self, team_id: str) -> list[dict[str, Any]]:
        payload = await self._call(
            self._recruitment,
            "get_team_applications",
            f"/api/ats/applications/{team_id}",
            team_id=team_id,
        )
        return [dict(item) for item in payload if isinstance(item, Mapping)] if isinstance(payload, list) else []

    async def application_details(self, team_id: str, application_id: str) -> dict[str, Any]:
        payload = await self._call(
            self._recruitment,
            "get_application_details",
            f"/api/ats/applications/{team_id}/{application_id}/info",
            team_id=team_id,
            application_id=application_id,
        )
        if not isinstance(payload, Mapping):
            raise PeoplePortalApiError(f"/api/ats/applications/{team_id}/{application_id}/info")
        if payload.get("error"):
            raise PeoplePortalApiError(
                f"/api/ats/applications/{team_id}/{application_id}/info",
                404 if payload.get("error") == "NotFound" else 502,
            )
        return dict(payload)

    async def close(self) -> None:
        # The generated ApiClient owns a urllib3 pool and intentionally has no
        # async close hook. Dropping the facade lets the pool be reclaimed.
        self._api_client = None


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


class PeoplePortalRecruitingClient:
    """Fetch active People Portal members and recruiting evidence via the SDK."""

    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        sdk_client: Any | None = None,
        timeout: float = 60.0,
        max_concurrency: int = 8,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.max_concurrency = max(1, min(int(max_concurrency), 32))
        self._sdk = sdk_client or PeoplePortalSdkClient(base_url=base_url, token=token, timeout=timeout)
        self._owns_sdk = sdk_client is None

    @staticmethod
    def _application_path(team_id: str, application_id: str | None = None) -> str:
        path = f"/api/ats/applications/{team_id}"
        return f"{path}/{application_id}/info" if application_id else path

    @staticmethod
    def _member_pk(member: Mapping[str, Any]) -> int | None:
        try:
            value = int(member.get("memberPk", member.get("pk")))
        except (TypeError, ValueError):
            return None
        return value if value > 0 else None

    def _candidate(
        self,
        member: Mapping[str, Any],
        applications: list[Mapping[str, Any]],
        *,
        source_status: str = "complete",
    ) -> dict[str, Any]:
        member_pk = self._member_pk(member)
        if member_pk is None:
            raise ValueError("People Portal member has no stable primary key")
        login = _text(member.get("username"), limit=320) or _text(member.get("email"), limit=320) or f"member-{member_pk}"
        name = _text(member.get("name"), limit=320) or login
        email = _normalized_email(member.get("email"))
        profiles = [application.get("profile") for application in applications if isinstance(application.get("profile"), Mapping)]
        profile: dict[str, Any] = {}
        for item in profiles:
            profile.update(item)
        notes = [_text(application.get("notes"), limit=1_000) for application in applications]
        notes = [note for note in notes if note]
        scores = [application.get("stars") for application in applications if isinstance(application.get("stars"), (int, float))]
        interview_evidence: list[str] = []
        for application in applications:
            note = _text(application.get("notes"), limit=760)
            if note:
                interview_evidence.append(f"Interview notes: {note}")
            interview_evidence.extend(_response_evidence(application.get("responses")))
            if len(interview_evidence) >= 20:
                break
        source_id = f"people-portal-member-{member_pk}"
        source_refs = [{
            "source_type": "people_portal_sdk",
            "source_id": source_id,
            "source_field": "/api/org/people",
            "label": "People Portal member directory via generated SDK",
        }]
        for application in applications[:30]:
            application_id = _text(application.get("applicationId") or application.get("id"), limit=200)
            team_id = _text(application.get("teamId") or application.get("team_id"), limit=200) or "unknown-team"
            if application_id:
                source_refs.append({
                    "source_type": "people_portal_sdk",
                    "source_id": source_id,
                    "source_field": self._application_path(team_id, application_id),
                    "label": "People Portal application evidence via generated SDK",
                })
        resume_summary = _text(_profile_value(profile, "resumeSummary", "resume_summary", "impactSummary", "impact_summary"), limit=3_000)
        resume_evidence = _bounded_strings(_profile_value(profile, "impactBullets", "impact_bullets", "resumeEvidence", "resume_evidence"), limit=30)
        prior_employers = _bounded_strings(_profile_value(profile, "priorEmployers", "prior_employers"), limit=20, item_limit=320)
        return {
            "people_portal_member_pk": member_pk,
            "member_login": login,
            "member_name": name,
            "email": email,
            "applicant_id": _text(applications[0].get("applicantId"), limit=200) if applications else None,
            "source_status": source_status,
            "interview": {
                "score": max(scores) if scores else None,
                "summary": "\n".join(notes)[:2_000] or None,
                "evidence": interview_evidence[:20],
            },
            "resume": {
                "summary": resume_summary,
                "evidence": resume_evidence,
                "prior_employers": prior_employers,
                "employment": prior_employers,
            },
            "source_refs": source_refs,
        }

    async def fetch_source(self) -> dict[str, Any]:
        """Return a bounded recruiting source envelope from People Portal SDK APIs."""

        members = await _maybe_await(self._sdk.list_active_members())
        teams = await _maybe_await(self._sdk.list_recruiting_teams())
        if not isinstance(members, list):
            raise PeoplePortalApiError("/api/org/people")
        member_rows = [item for item in members if isinstance(item, Mapping)]
        warnings: list[str] = []
        by_pk: dict[int, Mapping[str, Any]] = {}
        duplicate_pks: set[int] = set()
        for item in member_rows:
            member_pk = self._member_pk(item)
            if member_pk is None:
                warnings.append("People Portal member is missing its stable primary key and was quarantined.")
                continue
            if member_pk in by_pk:
                duplicate_pks.add(member_pk)
                by_pk.pop(member_pk, None)
                continue
            if member_pk not in duplicate_pks:
                by_pk[member_pk] = item
        by_email: dict[str, Mapping[str, Any]] = {}
        duplicate_emails: set[str] = set()
        for item in by_pk.values():
            email = _normalized_email(item.get("email"))
            if not email:
                warnings.append("People Portal member is missing an email and was quarantined from cross-source joins.")
                continue
            if email in by_email:
                duplicate_emails.add(email)
                by_email.pop(email, None)
                continue
            if email not in duplicate_emails:
                by_email[email] = item
        if duplicate_pks:
            warnings.append("People Portal member primary-key collision quarantined.")
        if duplicate_emails:
            warnings.append("People Portal member email collision quarantined.")
        applications_by_pk: dict[int, list[dict[str, Any]]] = {}
        status_by_pk: dict[int, str] = {pk: "incomplete" for pk in by_pk}

        for team in teams if isinstance(teams, list) else []:
            if not isinstance(team, Mapping):
                continue
            team_id = _text(team.get("teamPk") or team.get("team_pk") or team.get("pk"), limit=200)
            if not team_id:
                warnings.append("People Portal returned a recruiting team without a stable ID.")
                continue
            try:
                cards = await _maybe_await(self._sdk.list_team_applications(team_id))
            except PeoplePortalApiError:
                warnings.append(f"People Portal recruiting applications unavailable for team {team_id}.")
                continue
            for card in cards if isinstance(cards, list) else []:
                if not isinstance(card, Mapping):
                    continue
                application_id = _text(card.get("id") or card.get("applicationId"), limit=200)
                if not application_id:
                    warnings.append(f"People Portal returned an application without an ID for team {team_id}.")
                    continue
                try:
                    detail = await _maybe_await(self._sdk.application_details(team_id, application_id))
                except PeoplePortalApiError:
                    warnings.append(f"People Portal application detail unavailable for team {team_id}.")
                    continue
                if not isinstance(detail, Mapping):
                    continue
                member: Mapping[str, Any] | None = None
                internal_pk = self._member_pk({"pk": detail.get("appDevInternalPk")})
                if internal_pk is not None:
                    member = by_pk.get(internal_pk)
                detail_email = _normalized_email(detail.get("email"))
                if member is None and detail_email:
                    member = by_email.get(detail_email.casefold())
                if member is None:
                    warnings.append(f"People Portal application has no active member match for team {team_id}.")
                    continue
                member_pk = self._member_pk(member)
                if member_pk is None:
                    continue
                application = {
                    "applicationId": application_id,
                    "applicantId": detail.get("applicantId") or card.get("applicantId"),
                    "profile": detail.get("profile") if isinstance(detail.get("profile"), Mapping) else {},
                    "responses": detail.get("responses") if isinstance(detail.get("responses"), Mapping) else {},
                    "stars": detail.get("stars", card.get("stars")),
                    "notes": detail.get("notes"),
                    "teamId": team_id,
                }
                applications_by_pk.setdefault(member_pk, []).append(application)
                status_by_pk[member_pk] = "complete"

        candidates = [
            self._candidate(member, applications_by_pk.get(pk, []), source_status=status_by_pk.get(pk, "incomplete"))
            for pk, member in by_pk.items()
            if _normalized_email(member.get("email")) and _normalized_email(member.get("email")) not in duplicate_emails
        ]
        generated_at = datetime.now(timezone.utc).isoformat()
        payload: dict[str, Any] = {
            "schema": "horizon.people-portal-sdk.v1",
            "generated_at": generated_at,
            "candidates": candidates,
            "source": {
                "system": "people_portal_sdk",
                "api": "/api",
                "directory_endpoint": "/api/org/people",
                "recruiting_teams_endpoint": "/api/ats/openteams",
                "application_endpoint": "/api/ats/applications/{teamId}/{applicationId}/info",
                "warnings": sorted(set(warnings)),
            },
        }
        payload["source_run_id"] = f"people-portal-sdk-{payload_digest(payload)[:32]}"
        return payload

    async def close(self) -> None:
        if self._owns_sdk:
            close = getattr(self._sdk, "close", None)
            if callable(close):
                result = close()
                if inspect.isawaitable(result):
                    await result


__all__ = ["PeoplePortalApiError", "PeoplePortalSdkClient", "PeoplePortalRecruitingClient"]
