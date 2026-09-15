"""End-to-end coverage for the live ingestion path.

These tests drive the real adapters against an in-process fake Gitea/Authentik
so that the whole chain -- pull, stage, fold, snapshot, warn -- is exercised
without a network. The central claim under test is that a week-segmented
backfill produces enough distinct weekly observations for the rule engine's
minimum-data gate to open, which a single wide-range replay cannot do.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest

from backend.config import Settings
from backend.db import SqliteStore, get_active_repository
from backend.ingestion import AuthentikTeamHierarchyAdapter, PeoplePortalDirectoryAdapter
from backend.jobs import (
    _week_windows,
    generate_weekly_snapshots,
    run_nightly_sync,
    run_weekly_backfill,
)
from backend.models import BoundaryDocument, LifecycleState, ProjectDocument, RepositoryRef
from backend.staging import InMemoryStagingStore, fold_people_portal_catalog, fold_staging_activity

pytestmark = pytest.mark.usefixtures("in_memory_store")

UTC = timezone.utc
PROJECT_ID = "member-portal"
REPO_SLUG = "member-portal"
THROUGH = date(2026, 8, 5)


class FakeGiteaClient:
    """Serve repo, PR, and commit pages from a deterministic activity plan.

    ``latency_by_week`` maps an ISO week-start to the review latency in days
    for PRs opened that week, which lets a test shape a rising trend.
    """

    def __init__(self, latency_by_week: dict[date, float], *, commits_per_week: int = 5) -> None:
        self.latency_by_week = latency_by_week
        self.commits_per_week = commits_per_week

    def get(self, url: str, params: dict[str, Any] | None = None, **_: Any) -> "FakeResponse":
        params = params or {}
        if "/repos" in url and "/pulls" not in url and "/commits" not in url:
            return FakeResponse([{"id": 41, "name": REPO_SLUG, "full_name": f"appdev/{REPO_SLUG}", "team_id": 7}])
        if url.endswith("/commits") or "/commits" in url:
            return FakeResponse(self._commits(params))
        if "/pulls" in url and "/reviews" in url:
            return FakeResponse(self._reviews(url))
        if "/pulls" in url:
            return FakeResponse(self._pulls(params))
        return FakeResponse([])

    def _window(self, params: dict[str, Any]) -> date | None:
        since = params.get("since") or params.get("created_at")
        if not since:
            return None
        text = str(since).replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        return parsed.date() - timedelta(days=parsed.date().weekday())

    def _commits(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        week = self._window(params)
        if week is None or week not in self.latency_by_week:
            return []
        return [
            {
                "sha": f"{week.isoformat()}-{index}",
                "commit": {"committer": {"date": datetime.combine(week + timedelta(days=index), datetime.min.time(), tzinfo=UTC).isoformat()}},
            }
            for index in range(self.commits_per_week)
        ]

    @staticmethod
    def _review_at(week: date) -> datetime:
        # Mid-week, so a slow review is still observed inside its own window.
        return datetime.combine(week + timedelta(days=3), datetime.min.time(), tzinfo=UTC)

    def _pulls(self, _params: dict[str, Any]) -> list[dict[str, Any]]:
        # The adapter asks for `state=all` with no date bound and does its own
        # windowing, so every pull request is returned on every call.
        pulls = []
        for week, latency in self.latency_by_week.items():
            reviewed = self._review_at(week)
            pulls.append(
                {
                    "number": int(week.strftime("%y%m%d")),
                    "state": "closed",
                    "created_at": (reviewed - timedelta(days=latency)).isoformat(),
                    "merged_at": (reviewed + timedelta(days=1)).isoformat(),
                }
            )
        return pulls

    def _reviews(self, url: str) -> list[dict[str, Any]]:
        number = url.rsplit("/pulls/", 1)[-1].split("/")[0]
        for week in self.latency_by_week:
            if str(int(week.strftime("%y%m%d"))) == number:
                return [{"id": 1, "submitted_at": self._review_at(week).isoformat()}]
        return []


class FakeAuthentikClient:
    def __init__(self, member_count: int = 8) -> None:
        self.member_count = member_count

    def get(self, url: str, params: dict[str, Any] | None = None, **_: Any) -> "FakeResponse":
        return FakeResponse([{"pk": "7", "name": "Product Experience", "member_count": self.member_count}])


class FakeResponse:
    def __init__(self, payload: Any) -> None:
        self._payload = payload
        self.headers: dict[str, str] = {}

    def json(self) -> Any:
        return self._payload

    def raise_for_status(self) -> None:
        return None


def _settings() -> Settings:
    return Settings(
        PHI_ENVIRONMENT="test",
        PHI_DEV_AUTH=True,
        PHI_GITEA_URL="https://gitea.invalid",
        PHI_GITEA_API_TOKEN="token",
        PHI_GITEA_ORG="appdev",
        PHI_AUTHENTIK_URL="https://authentik.invalid",
        PHI_AUTHENTIK_API_TOKEN="token",
        PHI_AGGREGATION_FLOOR=5,
    )


async def _database() -> SqliteStore:
    database = get_active_repository()
    # The local repository runs without Beanie initialization, so documents
    # are constructed the same way the rest of the suite constructs them.
    await database.add(
        "projects",
        ProjectDocument.model_construct(project_id=PROJECT_ID, display_name="Member Portal", lifecycle_state=LifecycleState.ACTIVE, non_goals_ack=True),
    )
    await database.add(
        "boundaries",
        BoundaryDocument.model_construct(
            project_id=PROJECT_ID,
            root_authentik_team_id="7",
            included_subteam_ids=[],
            primary_repos=[RepositoryRef(gitea_repo_id="41", repo_slug=REPO_SLUG)],
            shared_repos=[],
            excluded_repos=[],
            effective_from=date(2026, 1, 1),
            effective_to=None,
            created_by="test",
        ),
    )
    return database


def _rising_latency(weeks: int) -> dict[date, float]:
    windows = _week_windows(weeks, through=THROUGH)
    # A flat baseline followed by a sharp rise, so the review-latency rule
    # clears both its absolute floor and its increase-over-baseline threshold.
    return {start: (1.0 if index < weeks - 1 else 9.0) for index, (start, _) in enumerate(windows)}


async def _run_backfill(weeks: int, *, latency: dict[date, float] | None = None) -> tuple[SqliteStore, dict[str, Any]]:
    database = await _database()
    staging = InMemoryStagingStore()
    settings = _settings()
    gitea = FakeGiteaClient(latency or _rising_latency(weeks))

    from backend.jobs import build_gitea_adapter

    adapter = await build_gitea_adapter(settings, database, staging, at=THROUGH)
    adapter._client = gitea

    # Team sizes normally arrive from the Authentik pull; stage one directly so
    # the aggregation floor has a size to gate on.
    staging["authentik_teams"].insert_one({"team_id": "7", "team_size": 8, "aggregation_eligible": True})
    adapter.team_size_resolver = {PROJECT_ID: 8, REPO_SLUG: 8}

    result = await run_weekly_backfill(
        settings=settings,
        database=database,
        staging=staging,
        gitea_adapter=adapter,
        weeks=weeks,
        through=THROUGH,
    )
    return database, result


async def test_week_segmented_backfill_creates_one_activity_row_per_week() -> None:
    database, result = await _run_backfill(10)
    rows = await database.list("repo_activity")
    windows = {row.window_start for row in rows}

    assert len(windows) == 10, "each replayed week must land in its own bucket"
    assert result["fold"]["activity_rows_written"] == len(rows)
    assert all(row.project_id == PROJECT_ID for row in rows)


async def test_backfill_produces_evidence_backed_warnings() -> None:
    database, result = await _run_backfill(10)
    warnings = await database.list("warnings")

    assert result["snapshots_written"] == 10
    assert warnings, "a rising latency trend over ten weeks must trigger a warning"
    assert all(warning.evidence for warning in warnings), "warnings must carry inspectable evidence"
    assert any(warning.rule_id == "review_latency" for warning in warnings)


async def test_adapter_builds_team_sizes_from_the_staging_store() -> None:
    database = await _database()
    staging = InMemoryStagingStore()
    staging["authentik_teams"].insert_one(
        {"team_id": "7", "team_size": 8, "aggregation_eligible": True}
    )

    from backend.jobs import build_gitea_adapter

    adapter = await build_gitea_adapter(_settings(), database, staging, at=THROUGH)
    assert adapter.team_size_resolver[PROJECT_ID] == 8
    assert adapter.team_size_resolver[REPO_SLUG] == 8


def test_authentik_hierarchy_stages_child_team_ids() -> None:
    staging = InMemoryStagingStore()

    class HierarchyClient:
        def get(self, *_args: Any, **_kwargs: Any) -> FakeResponse:
            return FakeResponse(
                [
                    {
                        "pk": "root",
                        "name": "Root Team",
                        "member_count": 8,
                        "children": [{"pk": "child-a"}, {"pk": "child-b"}],
                    }
                ]
            )

    result = AuthentikTeamHierarchyAdapter(
        staging,
        base_url="https://authentik.invalid",
        client=HierarchyClient(),
    ).sync()

    assert result.status == "ok"
    assert staging["authentik_teams"].find()[0]["child_team_ids"] == ["child-a", "child-b"]


async def test_people_portal_directory_stages_team_metadata_only() -> None:
    staging = InMemoryStagingStore()

    class PeoplePortalClient:
        def get(self, url: str, **_kwargs: Any) -> FakeResponse:
            return FakeResponse({"results": [{"pk": "team-1", "name": "Team One", "member_count": 8}]})

    result = PeoplePortalDirectoryAdapter(
        staging,
        base_url="https://people-portal.invalid",
        token="service-token",
        client=PeoplePortalClient(),
    ).sync()
    assert result.status == "ok"
    assert result.records_written == 1
    assert staging["people_portal_teams"].find()[0]["team_id"] == "team-1"


def test_people_portal_directory_uses_generated_sdk_team_hierarchy():
    class PeoplePortalSdk:
        def list_team_hierarchy_sync(self):
            return [{"pk": "team-1", "name": "Team One", "members": [{"pk": 7}]}]

    adapter = PeoplePortalDirectoryAdapter(
        InMemoryStagingStore(),
        base_url="https://people-portal.invalid",
        token="service-token",
        sdk_client=PeoplePortalSdk(),
    )

    assert adapter.fetch_teams() == [{"pk": "team-1", "name": "Team One", "members": [{"pk": 7}]}]


async def test_people_portal_directory_stages_and_folds_authoritative_catalog(
    in_memory_store,
):
    staging = InMemoryStagingStore()

    class PeoplePortalSdk:
        def list_team_hierarchy_sync(self):
            return [{
                "pk": "team-1",
                "name": "shared-resource-1",
                "friendlyName": "Friendly Team",
                "members": [{"pk": 7}],
            }]

        def list_project_catalog_sync(self, *, include_archived=False):
            assert include_archived is False
            return {
                "observedAt": "2026-09-13T00:00:00Z",
                "projects": [{
                    "id": "team-1",
                    "slug": "shared-resource-1",
                    "displayName": "Friendly Team",
                    "owningTeam": {
                        "id": "team-1",
                        "slug": "shared-resource-1",
                        "displayName": "Friendly Team",
                    },
                    "leads": [{
                        "id": "user-7",
                        "provider": "authentik",
                        "providerId": "user-7",
                        "username": "alice",
                        "name": "Alice Example",
                        "email": " alice@example.test ",
                        "role": "project-lead",
                        "gitea": {
                            "provider": "gitea",
                            "providerId": "41",
                            "username": "alice-gitea",
                            "email": "ALICE@example.test",
                        },
                    }],
                    "gitea": {
                        "provider": "gitea",
                        "organization": "shared-resource-1",
                        "organizationSource": "people-portal-team-name",
                        "repositorySnapshot": "verified",
                        "memberSnapshot": "verified",
                        "repositories": [{
                            "id": 41,
                            "slug": "project-repo",
                            "fullName": "shared-resource-1/project-repo",
                            "url": "https://gitea.example.test/shared-resource-1/project-repo",
                            "archived": False,
                        }],
                    },
                    "revision": {
                        "value": "revision-1",
                        "effectiveFrom": "2026-01-01",
                        "observedAt": "2026-09-13T00:00:00Z",
                    },
                }],
                "identityIssues": [],
            }

    result = PeoplePortalDirectoryAdapter(
        staging,
        base_url="https://people.example.test",
        token="service-token",
        sdk_client=PeoplePortalSdk(),
    ).sync()
    assert result.status == "ok"
    row = staging["people_portal_projects"].find()[0]
    assert row["root_team_id"] == "team-1"
    assert row["root_shared_resource_id"] == "shared-resource-1"
    assert row["root_team_display_name"] == "Friendly Team"
    assert row["gitea_organization"] == "shared-resource-1"
    assert row["data_owner_user_id"] == "user-7"
    assert row["repositories"][0]["gitea_repo_id"] == "41"

    fold_result = await fold_people_portal_catalog(in_memory_store, staging)
    assert fold_result["status"] == "ok"
    project = (await in_memory_store.list("projects"))[0]
    boundary = (await in_memory_store.list("boundaries"))[0]
    assert project.owning_authentik_team_id == "team-1"
    assert project.owning_shared_resource_id == "shared-resource-1"
    assert project.owning_team_display_name == "Friendly Team"
    assert project.gitea_organization == "shared-resource-1"
    assert project.catalog_leads[0].provider_id == "user-7"
    assert project.catalog_leads[0].gitea.provider_id == "41"
    assert boundary.root_authentik_team_id == "team-1"
    assert boundary.root_shared_resource_id == "shared-resource-1"
    assert boundary.root_team_display_name == "Friendly Team"
    assert boundary.gitea_organization == "shared-resource-1"


async def test_single_wide_range_replay_cannot_satisfy_the_minimum_data_gate() -> None:
    """One replay over the whole range yields one observation, so no warning."""

    database, _ = await _run_backfill(1, latency={_week_windows(1, through=THROUGH)[0][0]: 9.0})
    warnings = await database.list("warnings")

    assert len(await database.list("repo_activity")) == 1
    assert warnings == [], "a single weekly observation must not clear the baseline gate"


async def test_each_replayed_week_is_scored_against_only_its_own_history() -> None:
    database, _ = await _run_backfill(10)
    snapshots = sorted(await database.list("snapshots"), key=lambda row: row.week_start)

    # The spike lands in the final week, so earlier weeks must not inherit it.
    early = [row for row in snapshots[:-1] if row.warning_ids]
    assert early == [], "historical weeks must not be scored with later data"
    assert snapshots[-1].warning_ids, "the spike week must carry the warning"


async def test_refolding_the_same_week_refreshes_instead_of_duplicating() -> None:
    database, _ = await _run_backfill(4)
    before = await database.list("repo_activity")
    staging = InMemoryStagingStore()

    # Replay one already-folded window with a newer sync stamp.
    target = before[-1]
    staging["repo_activity_staging"].insert_one(
        {
            "repo_slug": REPO_SLUG,
            "gitea_repo_id": "41",
            "project_ids": [PROJECT_ID],
            "window_start": target.window_start.isoformat(),
            "window_end": target.window_end.isoformat(),
            "synced_at": datetime.now(UTC).isoformat(),
            "metrics": {"open_prs": 99, "active_days": 3},
            "aggregation_floor": 5,
            "data_completeness_pct": 100,
        }
    )
    fold = await fold_staging_activity(database, staging)
    after = await database.list("repo_activity")

    assert fold["activity_rows_refreshed"] == 1
    assert len(after) == len(before), "a refreshed week must not add a second row"
    assert any(row.open_prs == 99 for row in after)


async def test_nightly_sync_writes_week_aligned_windows() -> None:
    database = await _database()
    staging = InMemoryStagingStore()
    settings = _settings()
    now = datetime(2026, 8, 5, 2, 0, tzinfo=UTC)

    from backend.jobs import build_gitea_adapter

    adapter = await build_gitea_adapter(settings, database, staging, at=now.date())
    adapter._client = FakeGiteaClient(_rising_latency(2))
    adapter.team_size_resolver = {PROJECT_ID: 8, REPO_SLUG: 8}
    authentik = type("_Adapter", (), {"sync": lambda self, **_: __import__("backend.ingestion", fromlist=["SyncResult"]).SyncResult(status="ok", sync_cycle_id="c", synced_at=now.isoformat())})()

    await run_nightly_sync(
        settings=settings,
        database=database,
        staging=staging,
        authentik_adapter=authentik,
        gitea_adapter=adapter,
        now=now,
        lookback_days=14,
    )
    rows = await database.list("repo_activity")

    assert rows, "the nightly pull must materialize activity rows"
    assert all(row.window_start.weekday() == 0 for row in rows), "windows must start on a Monday"


async def test_unmapped_repository_is_not_attributed_to_a_project() -> None:
    """A repo outside every boundary must not be folded into a project."""

    database = await _database()
    staging = InMemoryStagingStore()
    staging["repo_activity_staging"].insert_one(
        {
            "repo_slug": "unmapped-repo",
            "gitea_repo_id": "99",
            "project_ids": [],
            "window_start": "2026-08-03",
            "window_end": "2026-08-09",
            "synced_at": datetime.now(UTC).isoformat(),
            "metrics": {"open_prs": 4},
            "data_completeness_pct": 100,
        }
    )
    fold = await fold_staging_activity(database, staging)

    assert fold["activity_rows_written"] == 0
    assert fold["unusable_rows"] == 1
    assert await database.list("repo_activity") == []


async def test_contributor_counts_are_dropped_below_the_aggregation_floor() -> None:
    database = await _database()
    staging = InMemoryStagingStore()
    staging["repo_activity_staging"].insert_one(
        {
            "repo_slug": REPO_SLUG,
            "gitea_repo_id": "41",
            "project_ids": [PROJECT_ID],
            "window_start": "2026-08-03",
            "window_end": "2026-08-09",
            "synced_at": datetime.now(UTC).isoformat(),
            "metrics": {"active_contributors": 2, "open_prs": 1},
            "aggregation_eligible": False,
            "aggregation_floor": 5,
            "data_completeness_pct": 100,
        }
    )
    await fold_staging_activity(database, staging)
    rows = await database.list("repo_activity")

    assert len(rows) == 1
    assert rows[0].active_contributors is None, "counts must not survive a failed floor gate"
    assert rows[0].team_size is None
