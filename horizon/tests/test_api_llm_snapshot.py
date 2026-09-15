"""API coverage for the calendar's missing_project_ids and the lazy compute endpoint."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from backend.db import SqliteStore
from backend.models import AttentionStatus
from backend.signal_llm import SIGNAL_VERSION

PAST_WEEK_MONDAY = date(2026, 3, 2)


@pytest_asyncio.fixture
async def client_over_store(in_memory_store: SqliteStore):
    from backend.api import router

    app = FastAPI(title="test-llm-snapshot")
    app.include_router(router)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, in_memory_store


@pytest.mark.asyncio
async def test_missing_project_ids_lists_projects_without_a_snapshot(client_over_store, make_project, make_boundary) -> None:
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())

    response = await client.get("/snapshots/at", params={"date": PAST_WEEK_MONDAY.isoformat()})
    assert response.status_code == 200
    body = response.json()
    assert body["missing_project_ids"] == ["member-portal"]
    assert body["has_data"] is False


@pytest.mark.asyncio
async def test_post_snapshot_at_refuses_current_week(client_over_store, make_project, make_boundary) -> None:
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())

    today = date.today()
    response = await client.post("/projects/member-portal/snapshots/at", params={"date": today.isoformat()})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_post_snapshot_at_serves_cached_result_without_recompute(client_over_store, make_project, make_boundary, make_snapshot, monkeypatch) -> None:
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())
    await store.add(
        "snapshots",
        make_snapshot(
            week_start=PAST_WEEK_MONDAY,
            rule_set_version=SIGNAL_VERSION,
            attention_status=AttentionStatus.CLEAR,
        ),
    )

    async def fail_if_called(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("generate_llm_snapshot should not be called for a cached week")

    monkeypatch.setattr("backend.api.generate_llm_snapshot", fail_if_called)

    response = await client.post("/projects/member-portal/snapshots/at", params={"date": PAST_WEEK_MONDAY.isoformat()})
    assert response.status_code == 200
    body = response.json()
    assert body["cached"] is True
    assert body["computed"] is False


@pytest.mark.asyncio
async def test_project_detail_prefers_llm_signal_over_later_rules_row_for_same_week(client_over_store, make_project, make_boundary, make_snapshot) -> None:
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())
    await store.add(
        "snapshots",
        make_snapshot(
            generated_at=datetime(2026, 3, 10, tzinfo=timezone.utc),
            rule_set_version="rules-v1",
        ),
    )
    await store.add(
        "snapshots",
        make_snapshot(
            generated_at=datetime(2026, 3, 9, tzinfo=timezone.utc),
            rule_set_version=SIGNAL_VERSION,
            signal_source="llm",
            signal_headline="LLM signal headline",
            signal_summary="LLM signal explanation",
            signal_confidence=0.8,
            signal_model="test-model",
        ),
    )

    response = await client.get("/projects/member-portal/snapshots")
    assert response.status_code == 200
    project = response.json()["snapshots"][0]["project"]
    assert project["signal"] == "LLM signal headline"
    assert project["signalDetail"] == "LLM signal explanation"
    assert project["signalSource"] == "llm"
    assert project["signalConfidence"] == 0.8


@pytest.mark.asyncio
async def test_post_snapshot_at_computes_and_returns_result(client_over_store, make_project, make_boundary, make_snapshot, monkeypatch) -> None:
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())

    computed = make_snapshot(
        week_start=PAST_WEEK_MONDAY,
        rule_set_version=SIGNAL_VERSION,
        attention_status=AttentionStatus.WATCH,
    )

    async def fake_generate(*args: Any, **kwargs: Any) -> Any:
        await store.add("snapshots", computed)
        return computed

    monkeypatch.setattr("backend.api.generate_llm_snapshot", fake_generate)
    monkeypatch.setattr("backend.api.get_signal_judge", lambda settings: object())

    import backend.config as config_module
    config_module.get_settings.cache_clear()
    monkeypatch.setenv("PHI_LLM_ENABLED", "true")
    monkeypatch.setenv("PHI_GEMINI_API_KEY", "test-key")
    config_module.get_settings.cache_clear()
    try:
        response = await client.post("/projects/member-portal/snapshots/at", params={"date": PAST_WEEK_MONDAY.isoformat()})
    finally:
        config_module.get_settings.cache_clear()

    assert response.status_code == 200
    body = response.json()
    assert body["computed"] is True
    assert body["cached"] is False


# ---------------------------------------------------------------------
# GET /snapshots/latest -- the lazy-compute contract the live dashboard
# reads. The frontend fans out one POST per id in missing_project_ids, but
# only once that project's row scrolls into view.
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_latest_lists_projects_with_no_snapshot_as_missing(client_over_store, make_project, make_boundary) -> None:
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())

    body = (await client.get("/snapshots/latest")).json()

    assert body["missing_project_ids"] == ["member-portal"]
    # The project still renders a row -- the frontend needs its name and team
    # to draw the placeholder it will later fill in.
    assert [item["id"] for item in body["projects"]] == ["member-portal"]


@pytest.mark.asyncio
async def test_latest_omits_projects_that_already_have_a_snapshot(client_over_store, make_project, make_boundary, make_snapshot) -> None:
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())
    await store.add("snapshots", make_snapshot(week_start=PAST_WEEK_MONDAY))

    body = (await client.get("/snapshots/latest")).json()

    assert body["missing_project_ids"] == []


@pytest.mark.asyncio
async def test_latest_lazy_week_is_the_last_completed_week(client_over_store, make_project, make_boundary) -> None:
    """The week the frontend posts for must be one the POST route accepts.

    ``POST /projects/{id}/snapshots/at`` refuses the in-progress week, so a
    lazy_week_start inside the current week would make every fan-out 400.
    """
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())

    body = (await client.get("/snapshots/latest")).json()

    today = date.today()
    current_week_start = today - timedelta(days=today.weekday())
    lazy_week_start = date.fromisoformat(body["lazy_week_start"])
    assert lazy_week_start == current_week_start - timedelta(days=7)
    assert lazy_week_start < current_week_start
    # Same guard the POST route applies, asserted directly.
    assert lazy_week_start - timedelta(days=lazy_week_start.weekday()) == lazy_week_start


@pytest.mark.asyncio
async def test_latest_reports_computable_from_llm_configuration(client_over_store, make_project, make_boundary, monkeypatch) -> None:
    client, store = client_over_store
    await store.add("projects", make_project())
    await store.add("boundaries", make_boundary())

    assert (await client.get("/snapshots/latest")).json()["computable"] is False

    import backend.config as config_module
    config_module.get_settings.cache_clear()
    monkeypatch.setenv("PHI_LLM_ENABLED", "true")
    monkeypatch.setenv("PHI_GEMINI_API_KEY", "test-key")
    config_module.get_settings.cache_clear()
    try:
        body = (await client.get("/snapshots/latest")).json()
    finally:
        config_module.get_settings.cache_clear()

    assert body["computable"] is True
