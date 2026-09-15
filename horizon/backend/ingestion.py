"""Pull-only Authentik and Gitea ingestion adapters.

The adapters in this module deliberately do not persist source payloads.  Both
Authentik and Gitea return identity-bearing objects, so those objects are
consumed in memory and reduced to team/repository aggregates before anything
is written.  The persisted documents are append-only and carry a sync-cycle
identifier so historical replays remain inspectable.

The real application supplies ``backend.models`` and a Mongo-like database.
This repository is currently a frontend mock, so the model import is optional
and collection/model seams are kept injectable for tests and for the backend
integration that will provide those foundation models.
"""

from __future__ import annotations

import importlib
import os
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, time, timezone
from typing import Any, Protocol
from urllib.parse import quote, urljoin, urlparse

try:  # httpx is a runtime dependency of the backend, but not of this mock.
    import httpx  # type: ignore
except ImportError:  # pragma: no cover - exercised only in the frontend-only mock
    httpx = None  # type: ignore[assignment]


try:
    # Import the foundation models when the backend package is present.  The
    # fallback keeps this module importable in this frontend-only checkout.
    foundation_models = importlib.import_module("backend.models")
except (ImportError, ModuleNotFoundError):  # pragma: no cover - local checkout
    foundation_models = None


AUTHENTIK_TEAMS_COLLECTION = "authentik_teams"
PEOPLE_PORTAL_TEAMS_COLLECTION = "people_portal_teams"
PEOPLE_PORTAL_PROJECTS_COLLECTION = "people_portal_projects"
GITEA_REPOS_COLLECTION = "gitea_repos"
REPO_ACTIVITY_COLLECTION = "repo_activity"
REPO_ACTIVITY_EVIDENCE_COLLECTION = "repo_activity_evidence"

# Five is intentionally conservative.  Deployments can lower/raise it only
# through explicit configuration; unknown team size is never aggregation-safe.
DEFAULT_AGGREGATION_FLOOR = 5
DEFAULT_PAGE_SIZE = 100
DEFAULT_MAX_PAGES = 10_000

_SENSITIVE_KEYS: set[str] = set()  # Identity storage is enabled; no fields are blocked.


class CollectionLike(Protocol):
    """Minimal Mongo-like collection contract used by the adapters."""

    def insert_one(self, document: Mapping[str, Any]) -> Any:
        ...


class DatabaseLike(Protocol):
    def __getitem__(self, name: str) -> CollectionLike:
        ...


class BoundaryResolver(Protocol):
    def __call__(self, repo_slug: str, repo: Mapping[str, Any]) -> Any:
        ...


class TeamSizeResolver(Protocol):
    def __call__(self, project_ids: Sequence[str], repo_slug: str) -> int | None:
        ...


class PrivacyBoundaryError(ValueError):
    """Raised when a document would cross the de-identification boundary."""


@dataclass(frozen=True)
class SyncResult:
    """Non-sensitive summary returned by a sync run."""

    status: str
    sync_cycle_id: str
    synced_at: str
    records_written: int = 0
    evidence_rows_written: int = 0
    repos_seen: int = 0
    data_quality_flags: tuple[str, ...] = ()
    message: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class _RunCounts:
    records_written: int = 0
    evidence_rows_written: int = 0
    repos_seen: int = 0
    flags: list[str] = field(default_factory=list)

    def flag(self, code: str) -> None:
        if code not in self.flags:
            self.flags.append(code)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | date | str | None) -> str | None:
    if value is None:
        return None
    parsed = _parse_datetime(value)
    if parsed is None:
        return str(value)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_datetime(value: datetime | date | str | None) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if isinstance(value, date):
        return datetime.combine(value, time.min, tzinfo=timezone.utc)
    if isinstance(value, str):
        candidate = value.strip()
        if not candidate:
            return None
        if candidate.endswith("Z"):
            candidate = candidate[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError:
            try:
                return datetime.combine(date.fromisoformat(candidate), time.min, tzinfo=timezone.utc)
            except ValueError:
                return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    return None


def _number(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _collection(db: DatabaseLike | Mapping[str, Any], name: str) -> CollectionLike:
    try:
        return db[name]  # type: ignore[index]
    except (KeyError, TypeError):
        getter = getattr(db, "get_collection", None)
        if getter is not None:
            return getter(name)
        collection = getattr(db, name, None)
        if collection is not None:
            return collection
        raise TypeError(f"database does not expose collection {name!r}")


def _foundation_document(kind: str, document: dict[str, Any]) -> dict[str, Any] | Any:
    """Validate through a supplied foundation model when one is available.

    Foundation-model class names differ slightly between backend revisions.
    Validation is therefore best-effort: a model is used if it accepts the
    complete document, otherwise the already-validated plain document is
    written.  In either case the privacy assertion below runs first.
    """

    if foundation_models is None:
        return document

    candidates = {
        AUTHENTIK_TEAMS_COLLECTION: ("AuthentikTeam", "AuthentikTeamRecord", "TeamRecord"),
        GITEA_REPOS_COLLECTION: ("GiteaRepo", "GiteaRepoRecord", "RepoRecord"),
        REPO_ACTIVITY_COLLECTION: (
            "RepoActivity",
            "RepoActivityRecord",
            "RepoActivityDocument",
        ),
        REPO_ACTIVITY_EVIDENCE_COLLECTION: (
            "RepoActivityEvidence",
            "RawEvidence",
            "RepoEvidence",
        ),
    }.get(kind, ())
    for name in candidates:
        model_class = getattr(foundation_models, name, None)
        if model_class is None:
            continue
        try:
            model = model_class(**document)
        except (TypeError, ValueError):
            continue
        for dumper_name in ("model_dump", "dict"):
            dumper = getattr(model, dumper_name, None)
            if dumper is not None:
                try:
                    return dumper()
                except TypeError:
                    continue
        return model
    return document


def _assert_safe_document(value: Any, path: str = "document") -> None:
    """Reject identity-bearing or line-level fields before persistence."""

    if isinstance(value, Mapping):
        for raw_key, child in value.items():
            key = str(raw_key).lower()
            if key in _SENSITIVE_KEYS:
                raise PrivacyBoundaryError(f"sensitive field rejected at {path}.{raw_key}")
            _assert_safe_document(child, f"{path}.{raw_key}")
    elif isinstance(value, (list, tuple, set)):
        for index, child in enumerate(value):
            _assert_safe_document(child, f"{path}[{index}]")


def _insert(db: DatabaseLike | Mapping[str, Any], collection_name: str, document: dict[str, Any]) -> None:
    _assert_safe_document(document)
    stored = _foundation_document(collection_name, document)
    if isinstance(stored, Mapping):
        _assert_safe_document(stored)
    _collection(db, collection_name).insert_one(stored)


def _extract_page(payload: Any) -> tuple[list[Mapping[str, Any]], str | None, bool]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, Mapping)], None, False
    if not isinstance(payload, Mapping):
        return [], None, False
    raw_results = payload.get("results", payload.get("data", payload.get("items", [])))
    if not isinstance(raw_results, list):
        raw_results = []
    pagination = payload.get("pagination")
    next_url: str | None = None
    has_more = False
    if isinstance(pagination, Mapping):
        raw_next = pagination.get("next")
        if isinstance(raw_next, str) and raw_next:
            next_url = raw_next
        has_more = bool(pagination.get("next") or pagination.get("next_page") or pagination.get("has_next"))
    raw_next = payload.get("next")
    if isinstance(raw_next, str) and raw_next:
        next_url = raw_next
        has_more = True
    elif isinstance(raw_next, Mapping):
        candidate = raw_next.get("url")
        if isinstance(candidate, str) and candidate:
            next_url = candidate
            has_more = True
    return [item for item in raw_results if isinstance(item, Mapping)], next_url, has_more


def _open_issue_count(repo: Mapping[str, Any]) -> int | None:
    """Gitea's own open-issue counter, already present on the repo payload.

    Free -- the repo listing this sync already walked carries it, so no extra
    request. ``None`` when absent or not a plain number, so a missing field
    reads as "unknown" rather than as zero open issues.
    """
    value = repo.get("open_issues_count")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(0, int(value))


def _header_has_more(headers: Any) -> bool:
    """Does the response advertise more pages in its headers?

    Gitea paginates bare JSON arrays -- the body carries no ``next``/
    ``pagination`` key at all, so ``_extract_page`` can never see that more
    pages exist. Gitea also silently caps ``limit`` at its own
    ``MAX_RESPONSE_ITEMS`` (50 by default), so a page shorter than the
    requested ``page_size`` is NOT evidence of the last page either. Without
    this header, ``pages()`` stopped after the first 50 items of every Gitea
    list endpoint and silently truncated history.

    Only the boolean ``X-HasMore`` is trusted; Gitea's companion ``Link:
    rel="next"`` URL has been observed pointing back at the page just
    fetched, which would loop forever. Our own ``page`` counter drives the
    walk instead.
    """

    if headers is None:
        return False
    getter = getattr(headers, "get", None)
    if getter is None:
        return False
    raw = getter("x-hasmore")
    if raw is None:
        raw = getter("X-HasMore")
    return str(raw).strip().lower() == "true" if raw is not None else False


def _safe_relative_or_same_host(url: str, base_url: str) -> str:
    """Keep pagination links on the configured service host."""

    parsed = urlparse(url)
    if not parsed.netloc:
        return url
    base = urlparse(base_url)
    if parsed.netloc != base.netloc:
        raise ValueError("pagination link points outside the configured service")
    return url


class _HttpxAdapter:
    def __init__(
        self,
        *,
        base_url: str | None,
        token: str | None,
        client: Any = None,
        client_factory: Callable[..., Any] | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.token = token
        self._client = client
        self._client_factory = client_factory
        self._timeout = timeout
        self._owns_client = False

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def _get_client(self) -> Any:
        if self._client is not None:
            return self._client
        if httpx is None:
            raise RuntimeError("httpx is required when no injectable client is supplied")
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        if self._client_factory is not None:
            try:
                self._client = self._client_factory(headers=headers, timeout=self._timeout)
            except TypeError:
                self._client = self._client_factory()
        else:
            self._client = httpx.Client(headers=headers, timeout=self._timeout)
        self._owns_client = True
        return self._client

    def close(self) -> None:
        if self._owns_client and self._client is not None:
            closer = getattr(self._client, "close", None)
            if closer is not None:
                closer()
        self._client = None if self._owns_client else self._client
        self._owns_client = False

    def _url(self, path_or_url: str) -> str:
        if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
            return _safe_relative_or_same_host(path_or_url, self.base_url)
        return urljoin(f"{self.base_url}/", path_or_url.lstrip("/"))

    def get_json(self, path_or_url: str, params: Mapping[str, Any] | None = None) -> Any:
        return self._get_json_with_headers(path_or_url, params)[0]

    def _get_json_with_headers(
        self, path_or_url: str, params: Mapping[str, Any] | None = None
    ) -> tuple[Any, Any]:
        response = self._get_client().get(self._url(path_or_url), params=dict(params or {}))
        raiser = getattr(response, "raise_for_status", None)
        if raiser is not None:
            raiser()
        return response.json(), getattr(response, "headers", None)

    def get_text(self, path_or_url: str, params: Mapping[str, Any] | None = None) -> str:
        response = self._get_client().get(self._url(path_or_url), params=dict(params or {}))
        raiser = getattr(response, "raise_for_status", None)
        if raiser is not None:
            raiser()
        return response.text

    def pages(
        self,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        page_size: int = DEFAULT_PAGE_SIZE,
        max_pages: int = DEFAULT_MAX_PAGES,
    ) -> list[Mapping[str, Any]]:
        collected: list[Mapping[str, Any]] = []
        page = 1
        next_url: str | None = None
        for _ in range(max_pages):
            if next_url is None:
                page_params = dict(params or {})
                page_params.setdefault("page", page)
                page_params.setdefault("limit", page_size)
                payload, headers = self._get_json_with_headers(path, page_params)
            else:
                # A server-supplied next link already encodes the full query
                # (filters included). Re-applying ``params`` on top of it would
                # overwrite that query -- including its ``page`` -- and re-fetch
                # the same page forever.
                payload, headers = self._get_json_with_headers(next_url, None)
            page_items, discovered_next, has_more = _extract_page(payload)
            collected.extend(page_items)
            # Header hints only fill in what the body could not say -- a
            # bare JSON array (Gitea) has no in-body next link at all.
            if not discovered_next and not has_more and page_items:
                has_more = _header_has_more(headers)
            if discovered_next:
                next_url = discovered_next
            elif has_more:
                page += 1
                next_url = None
            elif len(page_items) >= page_size:
                page += 1
                next_url = None
            else:
                break
        else:
            raise RuntimeError("pagination exceeded configured safety limit")
        return collected


def _authentik_id(value: Any) -> str | None:
    if isinstance(value, Mapping):
        value = value.get("pk", value.get("id", value.get("slug")))
    if value is None:
        return None
    return str(value)


def _team_document(
    team: Mapping[str, Any],
    *,
    aggregation_floor: int,
    source_system: str = "authentik",
) -> dict[str, Any]:
    team_id = _authentik_id(team.get("pk", team.get("id", team.get("slug"))))
    if team_id is None:
        raise ValueError("Authentik team has no stable id")
    parent_id = _authentik_id(team.get("parent", team.get("parent_pk")))
    children = team.get("children", team.get("child_teams", []))
    child_ids = []
    if isinstance(children, Sequence) and not isinstance(children, (str, bytes)):
        child_ids = [child_id for child_id in (_authentik_id(item) for item in children) if child_id]

    member_count = _number(team.get("member_count"))
    if member_count is None:
        members = team.get("members")
        if isinstance(members, Sequence) and not isinstance(members, (str, bytes)):
            # Identities are counted in memory and are never copied to the
            # staging document.
            member_count = len(members)

    document: dict[str, Any] = {
        "_id": _new_id("team"),
        "team_id": team_id,
        "name": str(team.get("name", team.get("slug", team_id))),
        "shared_resource_id": str(team.get("name", team.get("slug", team_id))),
        "gitea_organization": str(team.get("name", team.get("slug", team_id))),
        "display_name": str(team.get("friendlyName") or team.get("friendly_name") or team.get("name", team_id)),
        "parent_team_id": parent_id,
        "child_team_ids": child_ids,
        "synced_at": _iso(_utc_now()),
        "source": source_system,
        "aggregation_eligible": bool(member_count is not None and member_count >= aggregation_floor),
    }
    # The count is useful to the downstream floor check only when the team is
    # eligible.  A small team never gets a count field that could be returned.
    if member_count is not None and member_count >= aggregation_floor:
        document["team_size"] = member_count
    return document


class AuthentikTeamHierarchyAdapter(_HttpxAdapter):
    """Synchronize Authentik teams into an append-only staging collection."""

    def __init__(
        self,
        db: DatabaseLike | Mapping[str, Any],
        *,
        base_url: str | None = None,
        token: str | None = None,
        client: Any = None,
        client_factory: Callable[..., Any] | None = None,
        endpoint: str = "/api/v3/core/teams/",
        collection_name: str = AUTHENTIK_TEAMS_COLLECTION,
        aggregation_floor: int = DEFAULT_AGGREGATION_FLOOR,
        page_size: int = DEFAULT_PAGE_SIZE,
        max_pages: int = DEFAULT_MAX_PAGES,
        timeout: float = 30.0,
        source_system: str = "authentik",
    ) -> None:
        super().__init__(
            base_url=base_url,
            token=token,
            client=client,
            client_factory=client_factory,
            timeout=timeout,
        )
        self.db = db
        self.endpoint = endpoint
        self.collection_name = collection_name
        self.aggregation_floor = max(1, int(aggregation_floor))
        self.page_size = page_size
        self.max_pages = max_pages
        self.source_system = source_system

    @classmethod
    def from_env(cls, db: DatabaseLike | Mapping[str, Any], **kwargs: Any) -> "AuthentikTeamHierarchyAdapter":
        return cls(
            db,
            base_url=os.getenv("AUTHENTIK_URL") or os.getenv("AUTHENTIK_BASE_URL"),
            token=os.getenv("AUTHENTIK_API_TOKEN") or os.getenv("AUTHENTIK_TOKEN"),
            **kwargs,
        )

    def sync(
        self,
        *,
        sync_cycle_id: str | None = None,
        synced_at: datetime | str | None = None,
    ) -> SyncResult:
        cycle_id = sync_cycle_id or _new_id("sync")
        captured_at = _iso(synced_at or _utc_now()) or _iso(_utc_now())
        if not self.configured:
            return SyncResult(
                status="not_configured",
                sync_cycle_id=cycle_id,
                synced_at=captured_at or "",
                message="Authentik endpoint is not configured",
            )

        counts = _RunCounts()
        try:
            teams = self.fetch_teams()
        except Exception:
            # Do not expose client exception text: a URL or upstream payload
            # can contain identity-bearing data.
            counts.flag("authentik_team_fetch_failed")
            return SyncResult(
                status="partial",
                sync_cycle_id=cycle_id,
                synced_at=captured_at or "",
                data_quality_flags=tuple(counts.flags),
                message="Authentik team hierarchy could not be fetched",
            )

        for team in teams:
            try:
                document = _team_document(
                    team,
                    aggregation_floor=self.aggregation_floor,
                    source_system=self.source_system,
                )
                document["sync_cycle_id"] = cycle_id
                document["synced_at"] = captured_at
                _insert(self.db, self.collection_name, document)
                counts.records_written += 1
            except (PrivacyBoundaryError, TypeError, ValueError):
                counts.flag("authentik_team_record_rejected")

        status = "ok" if not counts.flags else "partial"
        return SyncResult(
            status=status,
            sync_cycle_id=cycle_id,
            synced_at=captured_at or "",
            records_written=counts.records_written,
            data_quality_flags=tuple(counts.flags),
        )

    def fetch_teams(self) -> list[Mapping[str, Any]]:
        """Fetch team rows; subclasses may replace transport, not fold semantics."""

        return self.pages(
            self.endpoint,
            page_size=self.page_size,
            max_pages=self.max_pages,
        )


class PeoplePortalDirectoryAdapter(AuthentikTeamHierarchyAdapter):
    """Pull aggregate team metadata from People Portal's generated SDK."""

    def __init__(
        self,
        db: DatabaseLike | Mapping[str, Any],
        *,
        base_url: str | None = None,
        token: str | None = None,
        client: Any = None,
        client_factory: Callable[..., Any] | None = None,
        sdk_client: Any = None,
        teams_endpoint: str = "/api/org/teams",
        aggregation_floor: int = DEFAULT_AGGREGATION_FLOOR,
        page_size: int = DEFAULT_PAGE_SIZE,
        max_pages: int = DEFAULT_MAX_PAGES,
        timeout: float = 30.0,
    ) -> None:
        super().__init__(
            db,
            base_url=base_url,
            token=token,
            client=client,
            client_factory=client_factory,
            endpoint=teams_endpoint,
            collection_name=PEOPLE_PORTAL_TEAMS_COLLECTION,
            aggregation_floor=aggregation_floor,
            page_size=page_size,
            max_pages=max_pages,
            timeout=timeout,
            source_system="people_portal",
        )
        self.sdk_client = sdk_client

    def fetch_teams(self) -> list[Mapping[str, Any]]:
        """Use the generated People Portal SDK for live team metadata."""

        if self.sdk_client is not None:
            fetch = getattr(self.sdk_client, "list_team_hierarchy_sync", None)
            if fetch is None:
                raise RuntimeError("People Portal SDK team facade must expose list_team_hierarchy_sync()")
            rows = fetch()
            return [row for row in rows if isinstance(row, Mapping)]
        return super().fetch_teams()

    def fetch_project_catalog(self) -> Mapping[str, Any]:
        """Fetch only the upstream catalog; never infer projects from Gitea."""

        if self.sdk_client is None:
            return {"projects": [], "identityIssues": []}
        fetch = getattr(self.sdk_client, "list_project_catalog_sync", None)
        if fetch is None:
            raise RuntimeError("People Portal SDK project facade must expose list_project_catalog_sync()")
        payload = fetch(include_archived=False)
        if isinstance(payload, list):
            return {"projects": payload, "identityIssues": []}
        if not isinstance(payload, Mapping) or not isinstance(payload.get("projects"), list):
            raise ValueError("People Portal project catalog response must contain a projects array")
        return payload

    @staticmethod
    def _catalog_identity_issue(issue: Mapping[str, Any]) -> dict[str, Any] | None:
        code = str(issue.get("code") or "").strip()
        provider = str(issue.get("provider") or "").strip()
        project_ids = issue.get("projectIds", issue.get("project_ids"))
        person_ids = issue.get("personIds", issue.get("person_ids"))
        if not code or not provider or not isinstance(project_ids, list) or not isinstance(person_ids, list):
            return None
        result: dict[str, Any] = {
            "code": code,
            "provider": provider,
            "project_ids": [str(item) for item in project_ids if item not in (None, "")],
            "person_ids": [str(item) for item in person_ids if item not in (None, "")],
        }
        if issue.get("email") not in (None, ""):
            result["email"] = str(issue["email"]).strip().casefold()
        return result

    @staticmethod
    def _catalog_lead(lead: Mapping[str, Any]) -> dict[str, Any] | None:
        person_id = str(lead.get("id") or "").strip()
        provider = str(lead.get("provider") or "").strip()
        provider_id = str(lead.get("providerId", lead.get("provider_id")) or "").strip()
        username = str(lead.get("username") or "").strip()
        name = str(lead.get("name") or "").strip()
        role = str(lead.get("role") or "").strip()
        if not all((person_id, provider, provider_id, username, name, role)):
            return None
        result: dict[str, Any] = {
            "id": person_id,
            "provider": provider,
            "provider_id": provider_id,
            "username": username,
            "name": name,
            "role": role,
        }
        if lead.get("email") not in (None, ""):
            result["email"] = str(lead["email"]).strip().casefold()
        gitea = lead.get("gitea")
        if gitea is not None:
            if not isinstance(gitea, Mapping):
                return None
            gitea_provider = str(gitea.get("provider") or "").strip()
            gitea_provider_id = str(gitea.get("providerId", gitea.get("provider_id")) or "").strip()
            gitea_username = str(gitea.get("username") or "").strip()
            if not all((gitea_provider, gitea_provider_id, gitea_username)):
                return None
            gitea_identity: dict[str, Any] = {
                "provider": gitea_provider,
                "provider_id": gitea_provider_id,
                "username": gitea_username,
            }
            if gitea.get("email") not in (None, ""):
                gitea_identity["email"] = str(gitea["email"]).strip().casefold()
            result["gitea"] = gitea_identity
        return result

    def _catalog_staging_row(
        self,
        entry: Mapping[str, Any],
        identity_issues: Sequence[Mapping[str, Any]],
        *,
        cycle_id: str,
        captured_at: str,
    ) -> dict[str, Any]:
        project_id = str(entry.get("id") or "").strip()
        project_slug = str(entry.get("slug") or "").strip()
        display_name = str(entry.get("displayName", entry.get("display_name")) or "").strip()
        owning_team = entry.get("owningTeam", entry.get("owning_team"))
        gitea = entry.get("gitea")
        revision = entry.get("revision")
        if not project_id or not project_slug or not display_name:
            raise ValueError("project catalog entry is missing stable identity or friendlyName display")
        if not isinstance(owning_team, Mapping) or not isinstance(gitea, Mapping) or not isinstance(revision, Mapping):
            raise ValueError("project catalog entry is missing owning team, Gitea, or revision metadata")
        owning_id = str(owning_team.get("id") or "").strip()
        owning_slug = str(owning_team.get("slug") or "").strip()
        owning_display_name = str(owning_team.get("displayName", owning_team.get("display_name")) or "").strip()
        organization = str(gitea.get("organization") or "").strip()
        if not owning_id or not owning_slug or not owning_display_name or not organization:
            raise ValueError("project catalog entry is missing explicit team identity fields")
        if project_id != owning_id or project_slug != owning_slug or organization != owning_slug:
            raise ValueError("project catalog team identity fields disagree")
        if gitea.get("organizationSource") not in (None, "people-portal-team-name"):
            raise ValueError("project catalog Gitea organization is not sourced from the team name")
        member_snapshot = str(gitea.get("memberSnapshot", gitea.get("member_snapshot")) or "").strip()
        if member_snapshot not in {"verified", "unconfigured", "unavailable"}:
            raise ValueError("project catalog entry is missing Gitea member snapshot status")
        repository_snapshot = str(gitea.get("repositorySnapshot", gitea.get("repository_snapshot")) or "").strip()
        if repository_snapshot not in {"verified", "unconfigured", "unavailable"}:
            raise ValueError("project catalog entry is missing Gitea repository snapshot status")
        effective_from = revision.get("effectiveFrom", revision.get("effective_from"))
        if not effective_from:
            # Observation time is not an effective date. Do not invent one.
            raise ValueError("project catalog entry has no authoritative effectiveFrom")
        raw_repositories = gitea.get("repositories")
        if not isinstance(raw_repositories, list) or not raw_repositories:
            raise ValueError("project catalog entry has no verified repository snapshot")
        repositories: list[dict[str, Any]] = []
        for repository in raw_repositories:
            if not isinstance(repository, Mapping) or repository.get("id") in (None, "") or not repository.get("slug"):
                raise ValueError("project catalog repository is missing its numeric ID or slug")
            repositories.append({
                "gitea_repo_id": str(repository["id"]),
                "repo_slug": str(repository["slug"]),
                "full_name": str(repository.get("fullName", repository.get("full_name")) or ""),
                "url": repository.get("url"),
                "archived": bool(repository.get("archived", False)),
            })
        raw_leads = entry.get("leads")
        if not isinstance(raw_leads, list):
            raise ValueError("project catalog entry leads must be an array")
        leads: list[dict[str, Any]] = []
        for lead in raw_leads:
            if not isinstance(lead, Mapping):
                continue
            normalized = self._catalog_lead(lead)
            if normalized is not None:
                leads.append(normalized)
        project_issues = [
            normalized
            for issue in identity_issues
            if isinstance(issue, Mapping)
            and project_id in [str(item) for item in issue.get("projectIds", issue.get("project_ids", []))]
            and (normalized := self._catalog_identity_issue(issue)) is not None
        ]
        owner_ids = {str(lead["provider_id"]) for lead in leads if lead.get("provider_id")}
        data_owner = next(iter(owner_ids)) if len(owner_ids) == 1 and not project_issues else None
        return {
            "_id": _new_id("people_portal_project"),
            "sync_cycle_id": cycle_id,
            "synced_at": captured_at,
            "source": "people_portal_sdk",
            "source_endpoint": "/api/projects/catalog",
            "project_id": project_id,
            "project_slug": project_slug,
            "display_name": display_name,
            "lifecycle_state": "active",
            "root_team_id": owning_id,
            "root_shared_resource_id": owning_slug,
            "root_team_display_name": owning_display_name,
            "gitea_organization": organization,
            "gitea_repository_snapshot": repository_snapshot,
            "gitea_member_snapshot": member_snapshot,
            "included_subteam_ids": [],
            "repositories": repositories,
            "effective_from": effective_from,
            "effective_to": revision.get("effectiveTo", revision.get("effective_to")),
            "data_owner_user_id": data_owner,
            "catalog_leads": leads,
            "catalog_identity_issues": project_issues,
            "catalog_revision": str(revision.get("value") or ""),
            "catalog_observed_at": revision.get("observedAt", revision.get("observed_at")),
        }

    def sync(
        self,
        *,
        sync_cycle_id: str | None = None,
        synced_at: datetime | str | None = None,
    ) -> SyncResult:
        team_result = super().sync(sync_cycle_id=sync_cycle_id, synced_at=synced_at)
        if team_result.status == "not_configured" or self.sdk_client is None:
            return team_result
        cycle_id = team_result.sync_cycle_id
        captured_at = team_result.synced_at
        flags = list(team_result.data_quality_flags)
        records_written = team_result.records_written
        try:
            catalog = self.fetch_project_catalog()
            identity_issues = catalog.get("identityIssues", catalog.get("identity_issues", []))
            if not isinstance(identity_issues, list):
                raise ValueError("project catalog identityIssues must be an array")
            for entry in catalog.get("projects", []):
                try:
                    if not isinstance(entry, Mapping):
                        raise ValueError("project catalog project is not an object")
                    row = self._catalog_staging_row(
                        entry,
                        identity_issues,
                        cycle_id=cycle_id,
                        captured_at=captured_at,
                    )
                    _insert(self.db, PEOPLE_PORTAL_PROJECTS_COLLECTION, row)
                    records_written += 1
                except (PrivacyBoundaryError, TypeError, ValueError):
                    flags.append("people_portal_project_record_rejected")
        except Exception:
            flags.append("people_portal_project_catalog_fetch_failed")
        return SyncResult(
            status="ok" if not flags else "partial",
            sync_cycle_id=cycle_id,
            synced_at=captured_at,
            records_written=records_written,
            data_quality_flags=tuple(dict.fromkeys(flags)),
        )

def _repo_slug(repo: Mapping[str, Any]) -> str:
    value = repo.get("name", repo.get("slug"))
    if value is None:
        raise ValueError("Gitea repository has no slug")
    return str(value)


def _repo_id(repo: Mapping[str, Any]) -> str:
    value = repo.get("id", repo.get("repo_id"))
    if value is None:
        # A slug is stable within the configured organization and is safe to
        # use as a de-identified repository key when Gitea omits numeric id.
        return _repo_slug(repo)
    return str(value)


def _project_ids_from_mapping(
    resolver: Mapping[Any, Any] | BoundaryResolver | None,
    repo_slug: str,
    repo: Mapping[str, Any],
) -> tuple[list[str], bool]:
    if resolver is None:
        return [], False
    if callable(resolver):
        value = resolver(repo_slug, repo)
    else:
        value = resolver.get(repo_slug, resolver.get(repo.get("id"), resolver.get(repo.get("repo_id"))))
    if isinstance(value, Mapping):
        value = value.get("project_ids", value.get("projects", value.get("project_id", [])))
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, Iterable):
        return [], True
    project_ids = sorted({str(project_id) for project_id in value if project_id is not None and str(project_id).strip()})
    return project_ids, True


def _team_or_owner_present(repo: Mapping[str, Any]) -> bool:
    for key in ("team_id", "team", "owner_team", "owner_team_id", "gitea_team_id"):
        value = repo.get(key)
        if value not in (None, "", [], {}):
            return True
    # An owner is used only as a boolean data-quality fact.  It is never
    # copied to a document because an owner may be a person account.
    return bool(repo.get("owner"))


def _repo_staging_document(
    repo: Mapping[str, Any],
    *,
    cycle_id: str,
    captured_at: str,
    project_ids: Sequence[str],
    mapping_available: bool,
) -> dict[str, Any]:
    repo_slug = _repo_slug(repo)
    flags = []
    if not mapping_available:
        flags.append("boundary_mapping_unavailable")
    if not project_ids:
        flags.append("unmapped_repo")
    if not _team_or_owner_present(repo):
        flags.append("repo_team_owner_missing")
    return {
        "_id": _new_id("gitea_repo"),
        "sync_cycle_id": cycle_id,
        "synced_at": captured_at,
        "source": "gitea",
        "gitea_repo_id": _repo_id(repo),
        "repo_slug": repo_slug,
        "project_ids": list(project_ids),
        "is_shared_repo": len(project_ids) > 1,
        "archived": bool(repo.get("archived", False)),
        "fork": bool(repo.get("fork", False)),
        "default_branch_present": bool(repo.get("default_branch")),
        "source_updated_at": _iso(repo.get("updated_at")),
        "data_quality_flags": flags,
    }


def _pr_number(pr: Mapping[str, Any]) -> str | int:
    value = pr.get("number", pr.get("index", pr.get("id")))
    if value is None:
        raise ValueError("pull request has no stable id")
    number = _number(value)
    return number if number is not None else str(value)


def _pr_state(pr: Mapping[str, Any]) -> str:
    state = str(pr.get("state", "")).lower()
    if state in {"open", "opened"}:
        return "open"
    if pr.get("merged") or pr.get("merged_at"):
        return "merged"
    if state in {"closed", "merged"}:
        return "closed" if state == "closed" and not pr.get("merged") else "merged"
    return state or "unknown"


def _in_window(value: Any, since: datetime | None, until: datetime | None) -> bool:
    parsed = _parse_datetime(value)
    if parsed is None:
        return since is None
    return (since is None or parsed >= since) and (until is None or parsed <= until)


def _safe_pr_document(
    pr: Mapping[str, Any],
    *,
    first_review_at: datetime | None,
    is_shared_repo_pr: bool,
) -> dict[str, Any]:
    opened_at = _parse_datetime(pr.get("created_at", pr.get("opened_at")))
    merged_at = _parse_datetime(pr.get("merged_at"))
    closed_at = _parse_datetime(pr.get("closed_at"))
    latency_days = None
    if opened_at is not None and first_review_at is not None:
        latency_days = round(max(0.0, (first_review_at - opened_at).total_seconds() / 86400), 3)
    author = pr.get("user") or {}
    author_login = author.get("login") or author.get("username") or None
    author_name = author.get("full_name") or author.get("name") or None
    return {
        "pr_id": _pr_number(pr),
        "author_login": author_login,
        "author_name": author_name,
        "opened_at": _iso(opened_at),
        "first_review_at": _iso(first_review_at),
        "merged_at": _iso(merged_at),
        "closed_at": _iso(closed_at),
        "state": _pr_state(pr),
        "is_shared_repo_pr": is_shared_repo_pr,
        "review_latency_days": latency_days,
    }


def _review_timestamp(review: Mapping[str, Any]) -> datetime | None:
    return _parse_datetime(review.get("submitted_at", review.get("created_at", review.get("updated_at"))))


def _identity_values(payload: Mapping[str, Any]) -> set[str]:
    """Extract contributor identifiers (login, username, full name) for storage."""

    values: set[str] = set()
    for key in ("login", "username", "full_name", "name"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            values.add(value.strip())
    return values


def _pr_contributors(pr: Mapping[str, Any]) -> set[str]:
    author = pr.get("user")
    return _identity_values(author) if isinstance(author, Mapping) else set()


def discover_gitea_orgs(
    *,
    base_url: str | None,
    token: str | None,
    client: Any = None,
    client_factory: Callable[..., Any] | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    max_pages: int = DEFAULT_MAX_PAGES,
    timeout: float = 30.0,
) -> list[dict[str, Any]]:
    """List every org the token can see and, for each, its repos.

    Used to auto-register one project boundary per org (rather than requiring
    ``PHI_GITEA_ORG`` to name a single org) when the Gitea instance hosts many
    independent project orgs, as App Dev Club's does — one org per team.

    Returns ``[{"org": <username>, "repos": [{"id": <int>, "name": <str>}, ...]}, ...]``.
    A repo's numeric ``id`` is Gitea-instance-wide unique, unlike its name, so
    callers should key boundary ``gitea_repo_id`` values on it rather than on
    the bare repo name to avoid same-named repos in different orgs colliding.
    """

    adapter = _HttpxAdapter(
        base_url=base_url,
        token=token,
        client=client,
        client_factory=client_factory,
        timeout=timeout,
    )
    try:
        orgs = adapter.pages("/api/v1/orgs", page_size=page_size, max_pages=max_pages)
        discovered: list[dict[str, Any]] = []
        for org in orgs:
            org_name = org.get("username") or org.get("name")
            if not org_name:
                continue
            repos = adapter.pages(
                f"/api/v1/orgs/{quote(str(org_name), safe='')}/repos",
                page_size=page_size,
                max_pages=max_pages,
            )
            discovered.append(
                {
                    "org": str(org_name),
                    "repos": [
                        {"id": repo.get("id"), "name": repo.get("name")}
                        for repo in repos
                        if repo.get("name")
                    ],
                }
            )
        return discovered
    finally:
        adapter.close()


class GiteaRepoActivityAdapter(_HttpxAdapter):
    """Synchronize de-identified Gitea repo activity into raw append-only rows."""

    def __init__(
        self,
        db: DatabaseLike | Mapping[str, Any],
        *,
        base_url: str | None = None,
        token: str | None = None,
        organization: str | None = None,
        org: str | None = None,
        client: Any = None,
        client_factory: Callable[..., Any] | None = None,
        repos_endpoint: str | None = None,
        collection_name: str = REPO_ACTIVITY_COLLECTION,
        repos_collection_name: str = GITEA_REPOS_COLLECTION,
        evidence_collection_name: str = REPO_ACTIVITY_EVIDENCE_COLLECTION,
        boundary_resolver: Mapping[Any, Any] | BoundaryResolver | None = None,
        team_size_resolver: TeamSizeResolver | Mapping[Any, Any] | None = None,
        aggregation_floor: int = DEFAULT_AGGREGATION_FLOOR,
        page_size: int = DEFAULT_PAGE_SIZE,
        max_pages: int = DEFAULT_MAX_PAGES,
        timeout: float = 30.0,
    ) -> None:
        super().__init__(
            base_url=base_url,
            token=token,
            client=client,
            client_factory=client_factory,
            timeout=timeout,
        )
        self.db = db
        self.organization = organization or org
        self.repos_endpoint = repos_endpoint
        self.collection_name = collection_name
        self.repos_collection_name = repos_collection_name
        self.evidence_collection_name = evidence_collection_name
        self.boundary_resolver = boundary_resolver
        self.team_size_resolver = team_size_resolver
        self.aggregation_floor = max(1, int(aggregation_floor))
        self.page_size = page_size
        self.max_pages = max_pages

    @classmethod
    def from_env(cls, db: DatabaseLike | Mapping[str, Any], **kwargs: Any) -> "GiteaRepoActivityAdapter":
        return cls(
            db,
            base_url=os.getenv("GITEA_URL") or os.getenv("GITEA_BASE_URL"),
            token=os.getenv("GITEA_API_TOKEN") or os.getenv("GITEA_TOKEN"),
            organization=os.getenv("GITEA_ORGANIZATION") or os.getenv("GITEA_ORG"),
            aggregation_floor=int(os.getenv("PHI_TEAM_SIZE_FLOOR", str(DEFAULT_AGGREGATION_FLOOR))),
            **kwargs,
        )

    def _repo_endpoint(self) -> str:
        if self.repos_endpoint:
            return self.repos_endpoint
        if not self.organization:
            raise ValueError("Gitea organization is not configured")
        return f"/api/v1/orgs/{quote(self.organization, safe='')}/repos"

    def _repo_path(self, repo_slug: str, suffix: str) -> str:
        if not self.organization:
            raise ValueError("Gitea organization is not configured")
        return (
            f"/api/v1/repos/{quote(self.organization, safe='')}/{quote(repo_slug, safe='')}/{suffix.lstrip('/')}"
        )

    def _first_review_at(self, repo_slug: str, pr: Mapping[str, Any]) -> datetime | None:
        try:
            reviews = self.pages(
                self._repo_path(repo_slug, f"pulls/{quote(str(_pr_number(pr)), safe='')}/reviews"),
                page_size=self.page_size,
                max_pages=self.max_pages,
            )
        except Exception:
            raise
        timestamps = [timestamp for timestamp in (_review_timestamp(review) for review in reviews) if timestamp]
        return min(timestamps) if timestamps else None

    def _branches_ahead(self, repo_slug: str, default_branch: str) -> int | None:
        """How many branches exist besides the default one.

        One paginated list call, no per-branch work -- negligible next to the
        PR-review walk this sync already performs. ``None`` on failure so the
        caller can tell "no branches" apart from "could not look".
        """
        try:
            branches = self.pages(
                self._repo_path(repo_slug, "branches"),
                page_size=self.page_size,
                max_pages=self.max_pages,
            )
        except Exception:
            return None
        return sum(1 for branch in branches if str(branch.get("name") or "") != default_branch)

    def _commit_pages(
        self,
        repo_slug: str,
        *,
        since: datetime | None,
        until: datetime | None,
    ) -> list[Mapping[str, Any]]:
        params: dict[str, Any] = {}
        if since is not None:
            params["since"] = _iso(since)
        if until is not None:
            params["until"] = _iso(until)
        return self.pages(
            self._repo_path(repo_slug, "commits"),
            params=params,
            page_size=self.page_size,
            max_pages=self.max_pages,
        )

    def _make_evidence(
        self,
        *,
        cycle_id: str,
        captured_at: str,
        repo_slug: str,
        evidence_type: str,
        title: str,
        metric: str,
        unit: str | None,
        current: Any,
        baseline: Any = None,
        source_ref: Any = None,
        facts: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        evidence_id = _new_id("evidence")
        row: dict[str, Any] = {
            "_id": evidence_id,
            "evidence_id": evidence_id,
            "sync_cycle_id": cycle_id,
            "observed_at": captured_at,
            "repo_slug": repo_slug,
            "type": evidence_type,
            "icon": "database" if evidence_type == "activity" else "alert",
            "title": title,
            "metric": metric,
            "unit": unit,
            "current": current,
            "baseline": baseline,
            "source": {
                "system": "gitea",
                "collection": self.evidence_collection_name,
                "evidence_id": evidence_id,
                "source_ref": source_ref,
            },
            "facts": dict(facts or {}),
        }
        return row

    def _write_evidence(self, row: dict[str, Any], counts: _RunCounts) -> dict[str, Any]:
        _insert(self.db, self.evidence_collection_name, row)
        counts.evidence_rows_written += 1
        return {
            "evidence_id": row["evidence_id"],
            "type": row["type"],
            "source": row["source"],
        }

    def _team_size(self, project_ids: Sequence[str], repo_slug: str) -> int | None:
        if self.team_size_resolver is None:
            return None
        if isinstance(self.team_size_resolver, Mapping):
            value: Any = self.team_size_resolver.get(repo_slug)
            if value is None and len(project_ids) == 1:
                value = self.team_size_resolver.get(project_ids[0])
            if isinstance(value, Mapping):
                value = value.get("team_size", value.get("member_count"))
            number = _number(value)
            return number if number is not None and number >= 0 else None
        try:
            value = self.team_size_resolver(project_ids, repo_slug)
        except TypeError:
            # Support the convenient single-project resolver shape while
            # retaining an explicit, injectable seam.
            if len(project_ids) != 1:
                return None
            value = self.team_size_resolver([project_ids[0]], repo_slug)
        number = _number(value)
        return number if number is not None and number >= 0 else None

    def sync(
        self,
        *,
        since: datetime | date | str | None = None,
        until: datetime | date | str | None = None,
        start_at: datetime | date | str | None = None,
        end_at: datetime | date | str | None = None,
        backfill: bool = False,
        sync_cycle_id: str | None = None,
        synced_at: datetime | str | None = None,
    ) -> SyncResult:
        """Append one repo activity document per repo for this sync cycle.

        ``backfill=True`` intentionally leaves the lower bound unset unless a
        caller supplies one, allowing Gitea's available history to be replayed.
        A normal/nightly sync can pass ``since`` and ``until`` to bound work.
        """

        if since is not None and start_at is not None:
            raise ValueError("use either since or start_at")
        if until is not None and end_at is not None:
            raise ValueError("use either until or end_at")
        since_value = _parse_datetime(start_at if start_at is not None else since)
        until_value = _parse_datetime(end_at if end_at is not None else until)
        if until_value is None:
            until_value = _parse_datetime(synced_at) or _utc_now()
        if backfill and start_at is None and since is None:
            since_value = None

        cycle_id = sync_cycle_id or _new_id("sync")
        captured_at = _iso(synced_at or _utc_now()) or _iso(_utc_now()) or ""
        if not self.configured or not self.organization:
            return SyncResult(
                status="not_configured",
                sync_cycle_id=cycle_id,
                synced_at=captured_at,
                message="Gitea endpoint or organization is not configured",
            )

        counts = _RunCounts()
        try:
            repos = self.pages(
                self._repo_endpoint(),
                page_size=self.page_size,
                max_pages=self.max_pages,
            )
        except Exception:
            counts.flag("gitea_repo_fetch_failed")
            return SyncResult(
                status="partial",
                sync_cycle_id=cycle_id,
                synced_at=captured_at,
                data_quality_flags=tuple(counts.flags),
                message="Gitea repository list could not be fetched",
            )

        for repo in repos:
            try:
                self._sync_repo(
                    repo,
                    cycle_id=cycle_id,
                    captured_at=captured_at,
                    since=since_value,
                    until=until_value,
                    backfill=backfill,
                    counts=counts,
                )
                counts.repos_seen += 1
            except PrivacyBoundaryError:
                counts.flag("repo_record_rejected")
            except (TypeError, ValueError):
                counts.flag("repo_record_invalid")
            except Exception:
                # The record itself is not silently fabricated.  A data-quality
                # flag is kept in the run result, while successful repos remain
                # append-only and available for rules.
                counts.flag("repo_sync_failed")

        status = "ok" if not counts.flags else "partial"
        return SyncResult(
            status=status,
            sync_cycle_id=cycle_id,
            synced_at=captured_at,
            records_written=counts.records_written,
            evidence_rows_written=counts.evidence_rows_written,
            repos_seen=counts.repos_seen,
            data_quality_flags=tuple(counts.flags),
        )

    def _sync_repo(
        self,
        repo: Mapping[str, Any],
        *,
        cycle_id: str,
        captured_at: str,
        since: datetime | None,
        until: datetime | None,
        backfill: bool,
        counts: _RunCounts,
    ) -> None:
        repo_slug = _repo_slug(repo)
        project_ids, mapping_available = _project_ids_from_mapping(
            self.boundary_resolver,
            repo_slug,
            repo,
        )
        staging = _repo_staging_document(
            repo,
            cycle_id=cycle_id,
            captured_at=captured_at,
            project_ids=project_ids,
            mapping_available=mapping_available,
        )
        staging_id = staging["_id"]
        _insert(self.db, self.repos_collection_name, staging)
        counts.records_written += 1
        repo_flags: set[str] = set(staging["data_quality_flags"])

        def add_repo_flag(code: str) -> None:
            repo_flags.add(code)
            counts.flag(code)

        for flag in staging["data_quality_flags"]:
            counts.flag(flag)

        evidence_refs: list[dict[str, Any]] = []
        evidence_rows: list[dict[str, Any]] = []

        def add_evidence(**kwargs: Any) -> dict[str, Any]:
            row = self._make_evidence(
                cycle_id=cycle_id,
                captured_at=captured_at,
                repo_slug=repo_slug,
                **kwargs,
            )
            ref = self._write_evidence(row, counts)
            evidence_rows.append(row)
            evidence_refs.append(ref)
            return ref

        for flag in staging["data_quality_flags"]:
            add_evidence(
                evidence_type="data_quality",
                title=flag.replace("_", " ").capitalize(),
                metric="data_quality",
                unit=None,
                current=flag,
                source_ref=staging_id,
                facts={"flag": flag, "repo_stage_id": staging_id},
            )

        try:
            prs = self.pages(
                self._repo_path(repo_slug, "pulls"),
                params={"state": "all"},
                page_size=self.page_size,
                max_pages=self.max_pages,
            )
            prs_available = True
        except Exception:
            prs = []
            prs_available = False
            add_repo_flag("pull_request_fetch_failed")
            add_evidence(
                evidence_type="data_quality",
                title="Pull request history unavailable",
                metric="pull_request_history",
                unit=None,
                current="unavailable",
                source_ref="pulls",
                facts={"flag": "pull_request_fetch_failed"},
            )

        contributor_keys: set[str] = set()
        open_prs: list[dict[str, Any]] = []
        merged_prs: list[dict[str, Any]] = []
        closed_prs: list[dict[str, Any]] = []
        latency_values: list[float] = []

        for pr in prs:
            state = _pr_state(pr)
            event_date = pr.get("merged_at") or pr.get("closed_at") or pr.get("updated_at") or pr.get("created_at")
            include_history = (backfill and since is None) or _in_window(event_date, since, until)
            if state == "open":
                include_history = True

            first_review_at: datetime | None = None
            review_failed = False
            try:
                first_review_at = self._first_review_at(repo_slug, pr)
            except Exception:
                review_failed = True
                add_repo_flag("review_fetch_failed")
                add_evidence(
                    evidence_type="data_quality",
                    title="Review timestamps unavailable",
                    metric="review_history",
                    unit=None,
                    current="unavailable",
                    source_ref=_pr_number(pr),
                    facts={"flag": "review_fetch_failed"},
                )
            if review_failed:
                first_review_at = None

            safe_pr = _safe_pr_document(
                pr,
                first_review_at=first_review_at,
                is_shared_repo_pr=len(project_ids) > 1,
            )
            # Both of these are windowed deliberately.  Accumulating them for
            # every pull request the repository has ever had would make the
            # row a lifetime average that is identical in every window, and a
            # metric that cannot vary can never form a trend or a baseline.
            if include_history or state == "open":
                contributor_keys.update(_pr_contributors(pr))
            if safe_pr["review_latency_days"] is not None and _in_window(first_review_at, since, until):
                latency_values.append(float(safe_pr["review_latency_days"]))
            if state == "open":
                open_prs.append(safe_pr)
            elif include_history and state == "merged":
                merged_prs.append(safe_pr)
            elif include_history and state == "closed":
                closed_prs.append(safe_pr)

            if include_history or state == "open":
                evidence_row = self._make_evidence(
                    cycle_id=cycle_id,
                    captured_at=captured_at,
                    repo_slug=repo_slug,
                    evidence_type="activity",
                    title="Pull request activity",
                    metric="pull_request",
                    unit="PR",
                    current=state,
                    source_ref=_pr_number(pr),
                    facts={
                        "opened_at": safe_pr["opened_at"],
                        "first_review_at": safe_pr["first_review_at"],
                        "merged_at": safe_pr["merged_at"],
                        "closed_at": safe_pr["closed_at"],
                    },
                )
                evidence_refs.append(self._write_evidence(evidence_row, counts))
                evidence_rows.append(evidence_row)

        commit_days: set[str] = set()
        commits_available = True
        try:
            commits = self._commit_pages(repo_slug, since=since, until=until)
        except Exception:
            commits = []
            commits_available = False
            add_repo_flag("commit_history_fetch_failed")
            add_evidence(
                evidence_type="data_quality",
                title="Commit-day history unavailable",
                metric="commit_days",
                unit="days",
                current="unavailable",
                source_ref="commits",
                facts={"flag": "commit_history_fetch_failed"},
            )

        for commit in commits:
            commit_object = commit.get("commit")
            if not isinstance(commit_object, Mapping):
                commit_object = {}
            author_object = commit.get("author")
            committer_object = commit.get("committer")
            if isinstance(author_object, Mapping):
                contributor_keys.update(_identity_values(author_object))
            if isinstance(committer_object, Mapping):
                contributor_keys.update(_identity_values(committer_object))
            commit_author = commit_object.get("author") if isinstance(commit_object, Mapping) else None
            commit_committer = commit_object.get("committer") if isinstance(commit_object, Mapping) else None
            if isinstance(commit_author, Mapping):
                contributor_keys.update(_identity_values(commit_author))
            if isinstance(commit_committer, Mapping):
                contributor_keys.update(_identity_values(commit_committer))

            timestamp = None
            for candidate in (
                commit.get("created_at"),
                commit.get("timestamp"),
                commit_author.get("date") if isinstance(commit_author, Mapping) else None,
                commit_committer.get("date") if isinstance(commit_committer, Mapping) else None,
            ):
                timestamp = _parse_datetime(candidate)
                if timestamp:
                    break
            if timestamp is None:
                continue
            if since is not None and timestamp < since:
                continue
            if until is not None and timestamp > until:
                continue
            day = timestamp.date().isoformat()
            if day not in commit_days:
                commit_days.add(day)
                evidence_row = self._make_evidence(
                    cycle_id=cycle_id,
                    captured_at=captured_at,
                    repo_slug=repo_slug,
                    evidence_type="activity",
                    title="Active commit day",
                    metric="active_days",
                    unit="days",
                    current=day,
                    source_ref="commits",
                    facts={"active_date": day},
                )
                evidence_refs.append(self._write_evidence(evidence_row, counts))
                evidence_rows.append(evidence_row)

        # The team size is resolved from the boundary/Authentik layer, not
        # persisted here.  Unknown or small teams omit active_contributors.
        team_size = self._team_size(project_ids, repo_slug)
        aggregation_eligible = team_size is not None and team_size >= self.aggregation_floor
        metrics: dict[str, Any] = {
            "active_days": len(commit_days),
            "days_since_activity": None,
            "open_prs": len(open_prs),
            "oldest_open_pr_days": None,
            "review_latency_days": round(sum(latency_values) / len(latency_values), 3) if latency_values else None,
            "merged_count": len(merged_prs),
            # Both describe the repo as it stands now rather than the sync
            # window: a branch or an open issue has no week it belongs to.
            "branches_ahead": self._branches_ahead(repo_slug, str(repo.get("default_branch") or "")),
            "open_issues": _open_issue_count(repo),
        }
        activity_dates: list[datetime] = []
        for day_value in commit_days:
            parsed_day = _parse_datetime(day_value)
            if parsed_day is not None:
                activity_dates.append(parsed_day)
        open_ages: list[float] = []
        for pr in open_prs:
            opened_at = _parse_datetime(pr.get("opened_at"))
            if opened_at is not None and until is not None:
                open_ages.append(max(0.0, (until - opened_at).total_seconds() / 86400))
        if activity_dates and until is not None:
            metrics["days_since_activity"] = max(0.0, (until - max(activity_dates)).total_seconds() / 86400)
        if open_ages:
            metrics["oldest_open_pr_days"] = round(max(open_ages), 3)
        metrics["active_contributors"] = len(contributor_keys)
        contributors_list = sorted(contributor_keys)

        completed_checks = sum(
            (
                True,  # repository list returned this repo
                prs_available,
                commits_available,
                (not prs or "review_fetch_failed" not in repo_flags),
            )
        )
        completeness = round(completed_checks / 4 * 100, 1)
        activity_document: dict[str, Any] = {
            "_id": _new_id("repo_activity"),
            "sync_cycle_id": cycle_id,
            "synced_at": captured_at,
            "last_sync_at": captured_at,
            "source": "gitea",
            "repo_slug": repo_slug,
            "gitea_repo_id": _repo_id(repo),
            "project_ids": project_ids,
            "is_shared_repo": len(project_ids) > 1,
            "backfill": backfill,
            "window_start": _iso(since),
            "window_end": _iso(until),
            "open_prs": open_prs,
            "merged_prs": merged_prs,
            "closed_prs": closed_prs,
            "commit_days": sorted(commit_days),
            "metrics": metrics,
            "aggregation_floor": self.aggregation_floor,
            "aggregation_eligible": aggregation_eligible,
            "data_completeness_pct": completeness,
            "data_quality_flags": sorted(
                {
                    flag
                    for flag in repo_flags
                    if flag
                    in {
                        "boundary_mapping_unavailable",
                        "unmapped_repo",
                        "repo_team_owner_missing",
                        "pull_request_fetch_failed",
                        "review_fetch_failed",
                        "commit_history_fetch_failed",
                    }
                }
            ),
            "contributors": contributors_list,
            "evidence_refs": evidence_refs,
            "evidence_rows": evidence_rows,
        }
        if team_size is not None:
            activity_document["team_size"] = team_size
        _insert(self.db, self.collection_name, activity_document)
        counts.records_written += 1

    def backfill(
        self,
        *,
        start_at: datetime | date | str | None = None,
        end_at: datetime | date | str | None = None,
        sync_cycle_id: str | None = None,
        synced_at: datetime | str | None = None,
    ) -> SyncResult:
        """Replay available historical PR/commit activity as a new cycle."""

        return self.sync(
            start_at=start_at,
            end_at=end_at,
            backfill=True,
            sync_cycle_id=sync_cycle_id,
            synced_at=synced_at,
        )


# Friendly aliases used by older backend call sites.
AuthentikAdapter = AuthentikTeamHierarchyAdapter
AuthentikTeamSyncAdapter = AuthentikTeamHierarchyAdapter
AuthentikIngestionAdapter = AuthentikTeamHierarchyAdapter
GiteaAdapter = GiteaRepoActivityAdapter
GiteaRepoSyncAdapter = GiteaRepoActivityAdapter
GiteaIngestionAdapter = GiteaRepoActivityAdapter


def sync_authentik_team_hierarchy(db: DatabaseLike | Mapping[str, Any], **kwargs: Any) -> SyncResult:
    return AuthentikTeamHierarchyAdapter(db, **kwargs).sync()


sync_authentik_teams = sync_authentik_team_hierarchy


def sync_gitea_repo_activity(db: DatabaseLike | Mapping[str, Any], **kwargs: Any) -> SyncResult:
    adapter_kwargs = dict(kwargs)
    sync_kwargs = {}
    for key in ("since", "until", "start_at", "end_at", "backfill", "sync_cycle_id", "synced_at"):
        if key in adapter_kwargs:
            sync_kwargs[key] = adapter_kwargs.pop(key)
    return GiteaRepoActivityAdapter(db, **adapter_kwargs).sync(**sync_kwargs)


sync_gitea_activity = sync_gitea_repo_activity


def backfill_gitea_repo_activity(db: DatabaseLike | Mapping[str, Any], **kwargs: Any) -> SyncResult:
    adapter_kwargs = dict(kwargs)
    sync_kwargs = {"backfill": True}
    for key in ("start_at", "end_at", "sync_cycle_id", "synced_at"):
        if key in adapter_kwargs:
            sync_kwargs[key] = adapter_kwargs.pop(key)
    return GiteaRepoActivityAdapter(db, **adapter_kwargs).sync(**sync_kwargs)


__all__ = [
    "AUTHENTIK_TEAMS_COLLECTION",
    "PEOPLE_PORTAL_TEAMS_COLLECTION",
    "PEOPLE_PORTAL_PROJECTS_COLLECTION",
    "GITEA_REPOS_COLLECTION",
    "REPO_ACTIVITY_COLLECTION",
    "REPO_ACTIVITY_EVIDENCE_COLLECTION",
    "DEFAULT_AGGREGATION_FLOOR",
    "PrivacyBoundaryError",
    "SyncResult",
    "AuthentikTeamHierarchyAdapter",
    "AuthentikTeamSyncAdapter",
    "AuthentikAdapter",
    "AuthentikIngestionAdapter",
    "PeoplePortalDirectoryAdapter",
    "GiteaRepoActivityAdapter",
    "GiteaRepoSyncAdapter",
    "GiteaAdapter",
    "GiteaIngestionAdapter",
    "sync_authentik_team_hierarchy",
    "sync_authentik_teams",
    "sync_gitea_repo_activity",
    "sync_gitea_activity",
    "backfill_gitea_repo_activity",
]
