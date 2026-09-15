"""Shared fixtures for the App Dev Horizon backend test suite.

Every fixture is function-scoped: an ``aiosqlite`` connection binds itself to
the running event loop, and pytest-asyncio creates a fresh loop per test.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone

# Settings reads a dotenv file by default (backend.config._ENV_FILE) so the
# server can't boot with an empty environment. Tests must stay hermetic:
# disable that file load outright, or a developer's real .env would hand the
# suite a live Gitea URL, a Gitea token and a Gemini key. Set before
# backend.config is imported below -- _ENV_FILE is resolved at import time.
os.environ["PHI_ENV_FILE"] = ""

# The settings singleton is read at import time by several modules, so the
# in-memory database path must be in the environment before anything else.
os.environ["PHI_SQLITE_PATH"] = ":memory:"
os.environ["PHI_ENVIRONMENT"] = "test"
os.environ["PHI_LLM_ENABLED"] = "false"
os.environ.pop("PHI_GEMINI_API_KEY", None)
os.environ.pop("GEMINI_API_KEY", None)

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from backend import db as db_module
from backend.config import Settings, get_settings
from backend.db import SqliteStore, close_db, init_db
from backend.models import (
    AggregateMetrics,
    AttentionStatus,
    AuditLogDocument,
    BoundaryDocument,
    EvidenceReference,
    FeedbackCategory,
    FeedbackDocument,
    LifecycleState,
    ProjectDocument,
    RepoActivityDocument,
    RepositoryRef,
    WarningDocument,
    WarningEvidenceItem,
    WarningSeverity,
    WeeklySnapshotDocument,
)
from backend.seed import seed_demo_data
from backend.staging import InMemoryStagingStore

get_settings.cache_clear()


WEEK_START = date(2026, 8, 3)
WEEK_END = date(2026, 8, 9)
OBSERVED_AT = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def test_settings() -> Settings:
    """Settings pinned to an ephemeral in-memory database."""
    return Settings(sqlite_path=":memory:", environment="test")


@pytest_asyncio.fixture
async def in_memory_store(test_settings: Settings):
    """A fully initialised ``SqliteStore`` backed by ``:memory:``."""
    store = await init_db(test_settings)
    try:
        yield store
    finally:
        await close_db()


@pytest_asyncio.fixture
async def seeded_store(in_memory_store: SqliteStore):
    """``in_memory_store`` with the demo fixture data already written."""
    await seed_demo_data()
    return in_memory_store


@pytest_asyncio.fixture
async def app_client(seeded_store: SqliteStore):
    """An ``httpx.AsyncClient`` bound to the router over the seeded store.

    The app is built without ``main.lifespan`` because ``ASGITransport`` does
    not run lifespan events; the database is initialised by the fixture chain
    instead, which keeps every test on the same in-memory connection.
    """
    from backend.api import router

    app = FastAPI(title="test")
    app.include_router(router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


@pytest_asyncio.fixture
async def empty_app_client(in_memory_store: SqliteStore):
    """An API client over an initialised but completely empty database."""
    from backend.api import router

    app = FastAPI(title="test-empty")
    app.include_router(router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


@pytest.fixture
def staging_store() -> InMemoryStagingStore:
    """A fresh append-only staging buffer."""
    return InMemoryStagingStore()


# ---------------------------------------------------------------------------
# Document factories
# ---------------------------------------------------------------------------


@pytest.fixture
def make_project():
    def _make(project_id: str = "member-portal", **overrides) -> ProjectDocument:
        payload = {
            "project_id": project_id,
            "display_name": "Member Portal",
            "lifecycle_state": LifecycleState.ACTIVE,
            "data_owner_user_id": "priya-n",
            "non_goals_ack": True,
        }
        payload.update(overrides)
        return ProjectDocument(**payload)

    return _make


@pytest.fixture
def make_boundary():
    def _make(project_id: str = "member-portal", **overrides) -> BoundaryDocument:
        payload = {
            "project_id": project_id,
            "root_authentik_team_id": "product-experience",
            "included_subteam_ids": ["member-portal-core"],
            "primary_repos": [
                RepositoryRef(gitea_repo_id="repo-1", repo_slug="member-portal")
            ],
            "effective_from": date(2026, 1, 1),
            "created_by": "seed",
        }
        payload.update(overrides)
        return BoundaryDocument(**payload)

    return _make


@pytest.fixture
def make_activity():
    def _make(project_id: str = "member-portal", **overrides) -> RepoActivityDocument:
        payload = {
            "project_id": project_id,
            "gitea_repo_id": "repo-1",
            "repo_slug": "member-portal",
            "window_start": WEEK_START,
            "window_end": WEEK_END,
            "synced_at": OBSERVED_AT,
            "active_days": 4,
            "days_since_activity": 1,
            "open_prs": 3,
            "review_latency_days": 2.5,
            "merged_count": 2,
            "active_contributors": 4,
            "team_size": 8,
            "data_completeness_pct": 97.0,
        }
        payload.update(overrides)
        return RepoActivityDocument(**payload)

    return _make


@pytest.fixture
def make_metrics():
    def _make(**overrides) -> AggregateMetrics:
        payload = {
            "active_days": 4,
            "days_since_activity": 1,
            "open_prs": 3,
            "review_latency_days": 2.5,
            "merged_count": 2,
            "active_contributors": 4,
            "team_size": 8,
            "data_completeness_pct": 97.0,
            "last_sync_at": OBSERVED_AT,
        }
        payload.update(overrides)
        return AggregateMetrics(**payload)

    return _make


@pytest.fixture
def make_snapshot(make_metrics):
    def _make(
        project_id: str = "member-portal",
        week_start: date = WEEK_START,
        **overrides,
    ) -> WeeklySnapshotDocument:
        payload = {
            "project_id": project_id,
            "week_start": week_start,
            "week_end": week_start + timedelta(days=6),
            "rule_set_version": "rules-v1",
            "generated_at": OBSERVED_AT,
            "attention_status": AttentionStatus.WATCH,
            "data_completeness_pct": 97.0,
            "last_sync_at": OBSERVED_AT,
            "metrics": make_metrics(),
        }
        payload.update(overrides)
        return WeeklySnapshotDocument(**payload)

    return _make


@pytest.fixture
def make_warning():
    def _make(snapshot_id: str, project_id: str = "member-portal", **overrides):
        evidence = WarningEvidenceItem(
            evidence_type="metric",
            icon="pull",
            title="Pull requests aging",
            metric="open_prs",
            current=4,
            baseline=1,
            source_refs=[
                EvidenceReference(
                    source_collection="repo_activity",
                    source_id="activity-1",
                    source_field="open_prs",
                    observed_at=OBSERVED_AT,
                )
            ],
        )
        payload = {
            "snapshot_id": snapshot_id,
            "project_id": project_id,
            "rule_id": "open_pr_aging",
            "rule_version": "rules-v1",
            "signal_name": "Pull requests aging",
            "current_value": 4,
            "baseline_value": 1,
            "time_window": "trailing 8 weeks",
            "trigger_threshold": "project baseline deviation",
            "severity": WarningSeverity.CRITICAL,
            "explanation": "Open PRs are outside the trailing baseline.",
            "data_freshness": OBSERVED_AT.isoformat(),
            "data_completeness_pct": 97.0,
            "evidence": [evidence],
        }
        payload.update(overrides)
        return WarningDocument(**payload)

    return _make


@pytest.fixture
def make_feedback():
    def _make(snapshot_id: str, project_id: str = "member-portal", **overrides):
        payload = {
            "snapshot_id": snapshot_id,
            "project_id": project_id,
            "author_user_id": "jordan-kim",
            "category": FeedbackCategory.RISK_CONFIRMED,
            "note": "Reviewer bandwidth is being backfilled.",
            "created_at": OBSERVED_AT,
        }
        payload.update(overrides)
        return FeedbackDocument(**payload)

    return _make


@pytest.fixture
def make_audit():
    def _make(**overrides) -> AuditLogDocument:
        payload = {
            "actor_user_id": "jordan-kim",
            "action": "feedback.created",
            "target_type": "feedback",
            "target_id": "feedback-1",
            "after": {"project_id": "member-portal", "category": "risk_confirmed"},
            "at": OBSERVED_AT,
        }
        payload.update(overrides)
        return AuditLogDocument(**payload)

    return _make


__all__ = ["db_module"]
