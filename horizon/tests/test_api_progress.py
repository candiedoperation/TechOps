"""API coverage for the cumulative-progress-as-of-date endpoints."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from backend.cumulative_llm import CUMULATIVE_VERSION
from backend.db import SqliteStore
from backend.models import AttentionStatus, CumulativeCheckpointDocument

AS_OF = date(2026, 4, 13)
AS_OF_WEEK_START = date(2026, 4, 13)


@pytest_asyncio.fixture
async def client_over_store(in_memory_store: SqliteStore):
    from backend.api import router

    app = FastAPI(title="test-progress")
    app.include_router(router)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, in_memory_store


def _checkpoint(**overrides: Any) -> CumulativeCheckpointDocument:
    base = dict(
        id="chk-1", project_id="member-portal", as_of_date=AS_OF, as_of_week_start=AS_OF_WEEK_START,
        coverage_start=date(2026, 1, 1), signal_version=CUMULATIVE_VERSION, generated_at=datetime(2026, 4, 13, tzinfo=timezone.utc),
        model="gemini-2.5-flash", status=AttentionStatus.WATCH, confidence=0.7, trajectory="steady",
        headline="Steady progress", narrative="Narrative text.", work_to_date="moderate",
    )
    base.update(overrides)
    return CumulativeCheckpointDocument(**base)


@pytest.mark.asyncio
async def test_progress_at_lists_missing_projects(client_over_store, make_project, make_boundary) -> None:
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())

    response = await client.get("/progress/at", params={"date": AS_OF.isoformat()})
    assert response.status_code == 200
    body = response.json()
    assert body["missing_project_ids"] == ["member-portal"]


@pytest.mark.asyncio
async def test_progress_at_serves_cached_checkpoint(client_over_store, make_project, make_boundary) -> None:
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())
    await store.add("cumulative_checkpoints", _checkpoint())

    response = await client.get("/progress/at", params={"date": AS_OF.isoformat()})
    assert response.status_code == 200
    body = response.json()
    assert body["missing_project_ids"] == []
    project = body["projects"][0]
    assert project["headline"] == "Steady progress"
    assert project["statusClass"] == "watch"
    assert project["checkpointId"] == "chk-1"


@pytest.mark.asyncio
async def test_compute_progress_returns_503_when_llm_not_configured(client_over_store, make_project, make_boundary) -> None:
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())

    response = await client.post("/projects/member-portal/progress/at", params={"date": AS_OF.isoformat()})
    assert response.status_code == 503


@pytest.mark.asyncio
async def test_cache_only_reads_require_exact_date_and_freshness(client_over_store, make_project):
    from datetime import timedelta
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("cumulative_checkpoints", _checkpoint())
    response = await client.get("/progress/at", params={"date": (AS_OF + timedelta(days=1)).isoformat()})
    assert response.json()["missing_project_ids"] == ["member-portal"]
    today = datetime.now(timezone.utc).date()
    await store.add("cumulative_checkpoints", _checkpoint(id="stale", as_of_date=today, as_of_week_start=today - timedelta(days=today.weekday()), is_provisional=True))
    response = await client.get("/progress/at", params={"date": today.isoformat()})
    assert response.json()["missing_project_ids"] == ["member-portal"]


@pytest.mark.asyncio
async def test_cached_progress_post_works_with_provider_disabled(client_over_store, make_project):
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("cumulative_checkpoints", _checkpoint())
    response = await client.post("/projects/member-portal/progress/at", params={"date": AS_OF.isoformat()})
    assert response.status_code == 200
    assert response.json()["cached"] is True
    assert response.json()["computed"] is False


@pytest.mark.asyncio
async def test_compute_progress_returns_computed_result(client_over_store, make_project, make_boundary, monkeypatch) -> None:
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())

    checkpoint = _checkpoint()

    async def fake_generate(*args: Any, **kwargs: Any) -> Any:
        await store.add("cumulative_checkpoints", checkpoint)
        return checkpoint

    monkeypatch.setattr("backend.api.generate_cumulative_checkpoint", fake_generate)

    import backend.config as config_module
    config_module.get_settings.cache_clear()
    monkeypatch.setenv("PHI_LLM_ENABLED", "true")
    monkeypatch.setenv("PHI_GEMINI_API_KEY", "test-key")
    config_module.get_settings.cache_clear()
    try:
        response = await client.post("/projects/member-portal/progress/at", params={"date": AS_OF.isoformat()})
    finally:
        config_module.get_settings.cache_clear()

    assert response.status_code == 200
    body = response.json()
    assert body["computed"] is True
    assert body["project"]["headline"] == "Steady progress"


@pytest.mark.asyncio
async def test_compute_progress_today_is_allowed_no_400(client_over_store, make_project, make_boundary, monkeypatch) -> None:
    """Unlike the weekly-signal endpoint, today is a valid as-of date here."""
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())

    async def fake_generate(*args: Any, **kwargs: Any) -> Any:
        return _checkpoint(as_of_date=date.today())

    monkeypatch.setattr("backend.api.generate_cumulative_checkpoint", fake_generate)

    import backend.config as config_module
    config_module.get_settings.cache_clear()
    monkeypatch.setenv("PHI_LLM_ENABLED", "true")
    monkeypatch.setenv("PHI_GEMINI_API_KEY", "test-key")
    config_module.get_settings.cache_clear()
    try:
        response = await client.post("/projects/member-portal/progress/at", params={"date": date.today().isoformat()})
    finally:
        config_module.get_settings.cache_clear()

    assert response.status_code == 200
