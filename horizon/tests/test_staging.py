"""Tests for the staging buffer and the folds in ``backend.staging``."""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from backend.ingestion import PEOPLE_PORTAL_PROJECTS_COLLECTION
from backend.models import BoundaryDocument, LifecycleState, ProjectDocument, RepoActivityDocument
from backend.staging import (
    REPO_ACTIVITY_STAGING_COLLECTION,
    STAGING_COLLECTIONS,
    InMemoryStagingStore,
    fold_people_portal_catalog,
    fold_staging_activity,
    open_staging_store,
)

WEEK_START = date(2026, 8, 3)
WEEK_END = date(2026, 8, 9)
SYNCED_AT = datetime(2026, 8, 9, 2, 0, tzinfo=timezone.utc)


def _activity_row(**overrides):
    row = {
        "gitea_repo_id": "repo-member-portal",
        "repo_slug": "member-portal",
        "project_ids": ["member-portal"],
        "window_start": WEEK_START.isoformat(),
        "window_end": WEEK_END.isoformat(),
        "synced_at": SYNCED_AT.isoformat(),
        "team_size": 8,
        "data_completeness_pct": 97.0,
        "contributors": ["ada", "grace"],
        "metrics": {
            "active_days": 4,
            "days_since_activity": 1,
            "open_prs": 3,
            "oldest_open_pr_days": 12.0,
            "review_latency_days": 2.5,
            "merged_count": 2,
            "active_contributors": 2,
        },
    }
    row.update(overrides)
    return row


def _portal_row(**overrides):
    row = {
        "project_id": "member-portal",
        "display_name": "Member Portal",
        "lifecycle_state": "active",
        "root_team_id": "product-experience",
        "included_subteam_ids": ["member-portal-core"],
        "data_owner_user_id": "priya-n",
        "effective_from": "2026-01-01",
        "repositories": [
            {"gitea_repo_id": "repo-1", "repo_slug": "member-portal"},
            {"gitea_repo_id": "repo-2", "repo_slug": "member-portal-api"},
        ],
    }
    row.update(overrides)
    return row


# ---------------------------------------------------------------------------
# InMemoryStagingStore
# ---------------------------------------------------------------------------


async def test_staging_store_insert_and_list_round_trip(staging_store):
    row = _activity_row()
    staging_store[REPO_ACTIVITY_STAGING_COLLECTION].insert_one(row)

    listed = await staging_store.list_staging(REPO_ACTIVITY_STAGING_COLLECTION)
    assert len(listed) == 1
    assert listed[0]["repo_slug"] == "member-portal"


async def test_staging_store_is_append_only(staging_store):
    for index in range(3):
        staging_store[REPO_ACTIVITY_STAGING_COLLECTION].insert_one(
            _activity_row(repo_slug=f"repo-{index}")
        )
    listed = await staging_store.list_staging(REPO_ACTIVITY_STAGING_COLLECTION)
    assert [row["repo_slug"] for row in listed] == ["repo-0", "repo-1", "repo-2"]


async def test_staging_store_copies_inserted_documents(staging_store):
    row = _activity_row()
    staging_store[REPO_ACTIVITY_STAGING_COLLECTION].insert_one(row)
    row["repo_slug"] = "mutated-after-insert"

    listed = await staging_store.list_staging(REPO_ACTIVITY_STAGING_COLLECTION)
    assert listed[0]["repo_slug"] == "member-portal"


async def test_staging_store_unknown_collection_is_empty(staging_store):
    assert await staging_store.list_staging("never-written") == []


async def test_staging_store_clear(staging_store):
    staging_store[REPO_ACTIVITY_STAGING_COLLECTION].insert_one(_activity_row())
    staging_store.clear()
    assert await staging_store.list_staging(REPO_ACTIVITY_STAGING_COLLECTION) == []


def test_staging_collection_registry_is_complete():
    assert REPO_ACTIVITY_STAGING_COLLECTION in STAGING_COLLECTIONS
    assert PEOPLE_PORTAL_PROJECTS_COLLECTION in STAGING_COLLECTIONS
    assert len(set(STAGING_COLLECTIONS)) == len(STAGING_COLLECTIONS)


def test_open_staging_store_returns_the_process_wide_buffer():
    assert open_staging_store() is open_staging_store()
    assert isinstance(open_staging_store(), InMemoryStagingStore)


def test_collection_find_returns_all_rows(staging_store):
    collection = staging_store[REPO_ACTIVITY_STAGING_COLLECTION]
    collection.insert_one(_activity_row())
    assert len(collection.find()) == 1
    assert len(collection.find({"repo_slug": "anything"})) == 1


# ---------------------------------------------------------------------------
# fold_staging_activity()
# ---------------------------------------------------------------------------


async def test_fold_staging_activity_writes_repo_activity_documents(
    in_memory_store, staging_store
):
    staging_store[REPO_ACTIVITY_STAGING_COLLECTION].insert_one(_activity_row())

    result = await fold_staging_activity(in_memory_store, staging_store)

    assert result["status"] == "ok"
    assert result["job"] == "fold_staging_activity"
    assert result["staging_rows_read"] == 1
    assert result["activity_rows_written"] == 1
    assert result["activity_rows_refreshed"] == 0
    assert result["unusable_rows"] == 0

    rows = await in_memory_store.list("repo_activity")
    assert len(rows) == 1
    document = rows[0]
    assert isinstance(document, RepoActivityDocument)
    assert document.project_id == "member-portal"
    assert document.repo_slug == "member-portal"
    assert document.window_start == WEEK_START
    assert document.window_end == WEEK_END
    assert document.open_prs == 3
    assert document.review_latency_days == 2.5
    assert document.active_contributors == 2
    assert document.team_size == 8
    assert document.contributors == ["ada", "grace"]


async def test_fold_staging_activity_fans_out_shared_repositories(
    in_memory_store, staging_store
):
    staging_store[REPO_ACTIVITY_STAGING_COLLECTION].insert_one(
        _activity_row(project_ids=["member-portal", "campus-events"])
    )

    result = await fold_staging_activity(in_memory_store, staging_store)
    assert result["activity_rows_written"] == 2

    rows = await in_memory_store.list("repo_activity")
    assert {row.project_id for row in rows} == {"member-portal", "campus-events"}


async def test_fold_staging_activity_refreshes_the_same_window_in_place(
    in_memory_store, staging_store
):
    staging_store[REPO_ACTIVITY_STAGING_COLLECTION].insert_one(_activity_row())
    await fold_staging_activity(in_memory_store, staging_store)
    original_id = (await in_memory_store.list("repo_activity"))[0].id

    later = datetime(2026, 8, 10, 2, 0, tzinfo=timezone.utc)
    staging_store[REPO_ACTIVITY_STAGING_COLLECTION].insert_one(
        _activity_row(
            synced_at=later.isoformat(),
            metrics={"active_days": 6, "open_prs": 5, "active_contributors": 3},
        )
    )
    result = await fold_staging_activity(in_memory_store, staging_store)

    assert result["activity_rows_refreshed"] == 1
    rows = await in_memory_store.list("repo_activity")
    assert len(rows) == 1, "the projection must not duplicate a window"
    assert rows[0].id == original_id
    assert rows[0].open_prs == 5
    assert rows[0].active_days == 6


async def test_fold_staging_activity_ignores_a_stale_observation(
    in_memory_store, staging_store
):
    staging_store[REPO_ACTIVITY_STAGING_COLLECTION].insert_one(_activity_row())
    await fold_staging_activity(in_memory_store, staging_store)

    earlier = datetime(2026, 8, 4, 2, 0, tzinfo=timezone.utc)
    staging_store[REPO_ACTIVITY_STAGING_COLLECTION].insert_one(
        _activity_row(synced_at=earlier.isoformat(), metrics={"open_prs": 99})
    )
    await fold_staging_activity(in_memory_store, staging_store)

    rows = await in_memory_store.list("repo_activity")
    assert len(rows) == 1
    assert rows[0].open_prs == 3, "an older sync must not overwrite a newer one"


@pytest.mark.parametrize(
    "bad_row",
    [
        {"repo_slug": "r", "project_ids": ["p"], "window_end": "2026-08-09"},
        {"repo_slug": "r", "project_ids": ["p"], "window_start": "2026-08-03"},
        {"project_ids": ["p"], "window_start": "2026-08-03", "window_end": "2026-08-09"},
        {"repo_slug": "r", "window_start": "2026-08-03", "window_end": "2026-08-09"},
        {"repo_slug": "r", "project_ids": [], "window_start": "2026-08-03", "window_end": "2026-08-09"},
    ],
    ids=["no-start", "no-end", "no-slug", "no-projects", "empty-projects"],
)
async def test_fold_staging_activity_counts_unusable_rows(
    in_memory_store, staging_store, bad_row
):
    staging_store[REPO_ACTIVITY_STAGING_COLLECTION].insert_one(bad_row)

    result = await fold_staging_activity(in_memory_store, staging_store)

    assert result["unusable_rows"] == 1
    assert result["activity_rows_written"] == 0
    assert await in_memory_store.list("repo_activity") == []


async def test_fold_staging_activity_on_empty_staging(in_memory_store, staging_store):
    result = await fold_staging_activity(in_memory_store, staging_store)
    assert result["staging_rows_read"] == 0
    assert result["activity_rows_written"] == 0
    assert await in_memory_store.list("repo_activity") == []


async def test_fold_staging_activity_tolerates_a_storeless_source(in_memory_store):
    result = await fold_staging_activity(in_memory_store, object())
    assert result["staging_rows_read"] == 0


# ---------------------------------------------------------------------------
# fold_people_portal_catalog()
# ---------------------------------------------------------------------------


async def test_fold_people_portal_catalog_writes_projects_and_boundaries(
    in_memory_store, staging_store
):
    staging_store[PEOPLE_PORTAL_PROJECTS_COLLECTION].insert_one(_portal_row())

    result = await fold_people_portal_catalog(in_memory_store, staging_store)

    assert result["status"] == "ok"
    assert result["job"] == "fold_people_portal_catalog"
    assert result["projects_written"] == 1
    assert result["boundaries_written"] == 1
    assert result["invalid_rows"] == 0

    projects = await in_memory_store.list("projects")
    assert len(projects) == 1
    project = projects[0]
    assert isinstance(project, ProjectDocument)
    assert project.project_id == "member-portal"
    assert project.display_name == "Member Portal"
    assert project.lifecycle_state == LifecycleState.ACTIVE
    assert project.data_owner_user_id == "priya-n"
    assert project.non_goals_ack is True

    boundaries = await in_memory_store.list("boundaries")
    assert len(boundaries) == 1
    boundary = boundaries[0]
    assert isinstance(boundary, BoundaryDocument)
    assert boundary.project_id == "member-portal"
    assert boundary.root_authentik_team_id == "product-experience"
    assert boundary.included_subteam_ids == ["member-portal-core"]
    assert [ref.repo_slug for ref in boundary.primary_repos] == [
        "member-portal",
        "member-portal-api",
    ]
    assert boundary.effective_from == date(2026, 1, 1)
    assert boundary.created_by == "people-portal-sync"


async def test_fold_people_portal_catalog_refreshes_existing_records(
    in_memory_store, staging_store
):
    staging_store[PEOPLE_PORTAL_PROJECTS_COLLECTION].insert_one(_portal_row())
    await fold_people_portal_catalog(in_memory_store, staging_store)
    original_project_id = (await in_memory_store.list("projects"))[0].id

    staging_store.clear()
    staging_store[PEOPLE_PORTAL_PROJECTS_COLLECTION].insert_one(
        _portal_row(display_name="Member Portal v2")
    )
    result = await fold_people_portal_catalog(in_memory_store, staging_store)

    assert result["projects_refreshed"] == 1
    assert result["boundaries_refreshed"] == 1
    assert result["projects_written"] == 0

    projects = await in_memory_store.list("projects")
    assert len(projects) == 1
    assert projects[0].display_name == "Member Portal v2"
    assert projects[0].id == original_project_id
    assert len(await in_memory_store.list("boundaries")) == 1


async def test_fold_people_portal_catalog_versions_a_new_effective_date(
    in_memory_store, staging_store
):
    staging_store[PEOPLE_PORTAL_PROJECTS_COLLECTION].insert_one(_portal_row())
    await fold_people_portal_catalog(in_memory_store, staging_store)

    staging_store.clear()
    staging_store[PEOPLE_PORTAL_PROJECTS_COLLECTION].insert_one(
        _portal_row(effective_from="2026-06-01", root_team_id="new-team")
    )
    result = await fold_people_portal_catalog(in_memory_store, staging_store)

    assert result["boundaries_written"] == 1
    boundaries = await in_memory_store.list("boundaries")
    assert {b.effective_from for b in boundaries} == {
        date(2026, 1, 1),
        date(2026, 6, 1),
    }


async def test_fold_people_portal_catalog_keeps_only_the_last_row_per_project(
    in_memory_store, staging_store
):
    staging_store[PEOPLE_PORTAL_PROJECTS_COLLECTION].insert_one(_portal_row())
    staging_store[PEOPLE_PORTAL_PROJECTS_COLLECTION].insert_one(
        _portal_row(display_name="Newest Name")
    )

    result = await fold_people_portal_catalog(in_memory_store, staging_store)

    assert result["source_rows"] == 2
    assert result["projects_written"] == 1
    assert (await in_memory_store.list("projects"))[0].display_name == "Newest Name"


async def test_fold_people_portal_catalog_falls_back_to_new_lifecycle(
    in_memory_store, staging_store
):
    staging_store[PEOPLE_PORTAL_PROJECTS_COLLECTION].insert_one(
        _portal_row(lifecycle_state="not-a-real-state")
    )
    await fold_people_portal_catalog(in_memory_store, staging_store)

    assert (await in_memory_store.list("projects"))[0].lifecycle_state is LifecycleState.NEW


@pytest.mark.parametrize(
    "bad_row",
    [
        {"project_id": "p", "repositories": [{"repo_slug": "r"}]},
        {"project_id": "p", "effective_from": "2026-01-01", "repositories": []},
        {"project_id": "p", "effective_from": "2026-01-01"},
    ],
    ids=["no-effective-from", "no-repositories", "missing-repositories-key"],
)
async def test_fold_people_portal_catalog_reports_invalid_rows(
    in_memory_store, staging_store, bad_row
):
    staging_store[PEOPLE_PORTAL_PROJECTS_COLLECTION].insert_one(bad_row)

    result = await fold_people_portal_catalog(in_memory_store, staging_store)

    assert result["status"] == "partial"
    assert result["invalid_rows"] == 1
    assert await in_memory_store.list("projects") == []


async def test_fold_people_portal_catalog_skips_rows_without_a_project_id(
    in_memory_store, staging_store
):
    staging_store[PEOPLE_PORTAL_PROJECTS_COLLECTION].insert_one(
        _portal_row(project_id="")
    )
    result = await fold_people_portal_catalog(in_memory_store, staging_store)

    assert result["source_rows"] == 1
    assert result["projects_written"] == 0
    assert await in_memory_store.list("projects") == []


async def test_fold_people_portal_catalog_on_empty_staging(
    in_memory_store, staging_store
):
    result = await fold_people_portal_catalog(in_memory_store, staging_store)
    assert result["status"] == "ok"
    assert result["source_rows"] == 0
    assert await in_memory_store.list("projects") == []
