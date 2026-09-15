"""Unit tests for the SQLite-backed repository in ``backend.db``."""

from __future__ import annotations

from datetime import date

import pytest

from backend.db import (
    DatabaseState,
    SqliteStore,
    close_db,
    get_active_repository,
    get_db_state,
    init_db,
)
from backend.errors import ImmutableSnapshotError
from backend.models import (
    AuditLogDocument,
    BoundaryDocument,
    FeedbackDocument,
    IdentityMapDocument,
    ProjectDocument,
    RepoActivityDocument,
    WarningDocument,
    WeeklySnapshotDocument,
)


# ---------------------------------------------------------------------------
# add() / insert() round-trips
# ---------------------------------------------------------------------------


async def test_add_assigns_id_and_round_trips_project(in_memory_store, make_project):
    project = make_project()
    assert project.id is None

    stored = await in_memory_store.add("projects", project)
    assert stored.id is not None

    rows = await in_memory_store.list("projects")
    assert len(rows) == 1
    assert isinstance(rows[0], ProjectDocument)
    assert rows[0].project_id == "member-portal"
    assert rows[0].id == stored.id


async def test_insert_uses_settings_name_for_each_collection(
    in_memory_store,
    make_project,
    make_boundary,
    make_activity,
    make_snapshot,
    make_warning,
    make_feedback,
    make_audit,
):
    snapshot = make_snapshot()
    await in_memory_store.insert(snapshot)

    documents = [
        ("projects", make_project(), ProjectDocument),
        ("boundaries", make_boundary(), BoundaryDocument),
        ("repo_activity", make_activity(), RepoActivityDocument),
        ("warnings", make_warning(str(snapshot.id)), WarningDocument),
        ("feedback", make_feedback(str(snapshot.id)), FeedbackDocument),
        ("audit_log", make_audit(), AuditLogDocument),
        ("identity_map", IdentityMapDocument(), IdentityMapDocument),
    ]
    for collection, document, model in documents:
        await in_memory_store.insert(document)
        rows = await in_memory_store.list(collection)
        assert len(rows) == 1, collection
        assert isinstance(rows[0], model), collection

    snapshots = await in_memory_store.list("weekly_snapshots")
    assert len(snapshots) == 1
    assert isinstance(snapshots[0], WeeklySnapshotDocument)


async def test_insert_rejects_document_without_settings_name(in_memory_store):
    class Orphan:
        id = None

    with pytest.raises(ValueError, match="has no Settings.name"):
        await in_memory_store.insert(Orphan())


async def test_insert_many_bulk_inserts(in_memory_store, make_project):
    projects = [
        make_project(project_id=f"project-{index}", display_name=f"Project {index}")
        for index in range(5)
    ]
    inserted = await in_memory_store.insert_many(projects)

    assert len(inserted) == 5
    assert all(item.id is not None for item in inserted)

    rows = await in_memory_store.list("projects")
    assert {row.project_id for row in rows} == {f"project-{i}" for i in range(5)}


async def test_list_returns_all_inserted_documents(in_memory_store, make_activity):
    for index in range(3):
        await in_memory_store.insert(
            make_activity(repo_slug=f"repo-{index}", gitea_repo_id=f"repo-{index}")
        )

    rows = await in_memory_store.list("repo_activity")
    assert len(rows) == 3
    assert {row.repo_slug for row in rows} == {"repo-0", "repo-1", "repo-2"}


async def test_list_of_empty_collection_is_empty(in_memory_store):
    assert await in_memory_store.list("projects") == []
    assert await in_memory_store.list("assessments") == []


# ---------------------------------------------------------------------------
# replace()
# ---------------------------------------------------------------------------


async def test_replace_updates_in_place(in_memory_store, make_project):
    project = make_project()
    await in_memory_store.insert(project)

    project.display_name = "Member Portal (renamed)"
    await in_memory_store.replace(project)

    rows = await in_memory_store.list("projects")
    assert len(rows) == 1
    assert rows[0].display_name == "Member Portal (renamed)"
    assert rows[0].id == project.id


async def test_replace_updates_indexed_columns(in_memory_store, make_boundary):
    boundary = make_boundary()
    await in_memory_store.insert(boundary)

    boundary.effective_to = date(2026, 6, 30)
    await in_memory_store.replace(boundary)

    assert await in_memory_store.boundary_at("member-portal", date(2026, 12, 1)) is None
    still_there = await in_memory_store.boundary_at("member-portal", date(2026, 3, 1))
    assert still_there is not None


async def test_replace_raises_for_weekly_snapshot(in_memory_store, make_snapshot):
    snapshot = make_snapshot()
    await in_memory_store.insert(snapshot)

    with pytest.raises(ImmutableSnapshotError):
        await in_memory_store.replace(snapshot)


async def test_snapshot_document_mutation_helpers_raise(make_snapshot):
    snapshot = make_snapshot()
    for method in ("save", "replace", "update", "delete"):
        with pytest.raises(ImmutableSnapshotError):
            await getattr(snapshot, method)()


# ---------------------------------------------------------------------------
# get_project()
# ---------------------------------------------------------------------------


async def test_get_project_by_project_id(in_memory_store, make_project):
    await in_memory_store.insert(make_project(project_id="alumni-network"))
    await in_memory_store.insert(make_project(project_id="campus-events"))

    found = await in_memory_store.get_project("campus-events")
    assert found is not None
    assert found.project_id == "campus-events"


async def test_get_project_returns_none_for_unknown_id(in_memory_store):
    assert await in_memory_store.get_project("does-not-exist") is None


# ---------------------------------------------------------------------------
# boundary_at()
# ---------------------------------------------------------------------------


async def test_boundary_at_respects_effective_window(in_memory_store, make_boundary):
    old = make_boundary(
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 5, 31),
        root_authentik_team_id="old-team",
    )
    new = make_boundary(
        effective_from=date(2026, 6, 1),
        effective_to=None,
        root_authentik_team_id="new-team",
    )
    await in_memory_store.insert_many([old, new])

    in_march = await in_memory_store.boundary_at("member-portal", date(2026, 3, 1))
    assert in_march is not None and in_march.root_authentik_team_id == "old-team"

    in_august = await in_memory_store.boundary_at("member-portal", date(2026, 8, 3))
    assert in_august is not None and in_august.root_authentik_team_id == "new-team"

    before_any = await in_memory_store.boundary_at("member-portal", date(2025, 1, 1))
    assert before_any is None


async def test_boundary_at_without_date_returns_latest(in_memory_store, make_boundary):
    await in_memory_store.insert(
        make_boundary(effective_from=date(2026, 1, 1), root_authentik_team_id="old-team")
    )
    await in_memory_store.insert(
        make_boundary(effective_from=date(2026, 6, 1), root_authentik_team_id="new-team")
    )

    latest = await in_memory_store.boundary_at("member-portal")
    assert latest is not None
    assert latest.root_authentik_team_id == "new-team"


async def test_boundary_at_unknown_project_is_none(in_memory_store, make_boundary):
    await in_memory_store.insert(make_boundary())
    assert await in_memory_store.boundary_at("other-project", date(2026, 3, 1)) is None


async def test_boundary_is_effective_at_helper(make_boundary):
    boundary = make_boundary(
        effective_from=date(2026, 1, 1), effective_to=date(2026, 3, 31)
    )
    assert boundary.is_effective_at(date(2026, 1, 1)) is True
    assert boundary.is_effective_at(date(2026, 3, 31)) is True
    assert boundary.is_effective_at(date(2026, 4, 1)) is False
    assert boundary.is_effective_at(date(2025, 12, 31)) is False


async def test_boundary_rejects_inverted_range(make_boundary):
    with pytest.raises(ValueError, match="effective_to must be on or after"):
        make_boundary(effective_from=date(2026, 6, 1), effective_to=date(2026, 1, 1))


# ---------------------------------------------------------------------------
# snapshot lookups
# ---------------------------------------------------------------------------


async def test_latest_snapshot_returns_most_recent(in_memory_store, make_snapshot):
    for week in (date(2026, 7, 6), date(2026, 7, 20), date(2026, 8, 3)):
        await in_memory_store.insert(make_snapshot(week_start=week))

    latest = await in_memory_store.latest_snapshot("member-portal")
    assert latest is not None
    assert latest.week_start == date(2026, 8, 3)


async def test_latest_snapshot_is_scoped_to_project(in_memory_store, make_snapshot):
    await in_memory_store.insert(
        make_snapshot(project_id="member-portal", week_start=date(2026, 8, 3))
    )
    await in_memory_store.insert(
        make_snapshot(project_id="campus-events", week_start=date(2026, 7, 6))
    )

    assert (await in_memory_store.latest_snapshot("campus-events")).week_start == date(
        2026, 7, 6
    )
    assert await in_memory_store.latest_snapshot("no-such-project") is None


async def test_snapshot_by_id(in_memory_store, make_snapshot):
    snapshot = make_snapshot()
    await in_memory_store.insert(snapshot)

    found = await in_memory_store.snapshot_by_id(str(snapshot.id))
    assert found is not None and found.id == snapshot.id
    assert await in_memory_store.snapshot_by_id("missing") is None


async def test_duplicate_snapshot_key_is_rejected(in_memory_store, make_snapshot):
    import sqlite3

    await in_memory_store.insert(make_snapshot())
    with pytest.raises(sqlite3.IntegrityError):
        await in_memory_store.insert(make_snapshot())


# ---------------------------------------------------------------------------
# warning lookups
# ---------------------------------------------------------------------------


async def test_warning_lookups(in_memory_store, make_snapshot, make_warning):
    snapshot = make_snapshot()
    await in_memory_store.insert(snapshot)
    warning = make_warning(str(snapshot.id))
    await in_memory_store.insert(warning)

    by_id = await in_memory_store.warning_by_id(str(warning.id))
    assert by_id is not None and by_id.rule_id == "open_pr_aging"

    for_snapshot = await in_memory_store.warnings_for_snapshot(str(snapshot.id))
    assert len(for_snapshot) == 1

    assert await in_memory_store.warnings_for_snapshot("nope") == []
    assert await in_memory_store.warning_by_id("nope") is None


# ---------------------------------------------------------------------------
# find_one() / find_many()
# ---------------------------------------------------------------------------


async def test_find_one_and_find_many(in_memory_store, make_project):
    await in_memory_store.insert(make_project(project_id="alumni-network"))
    await in_memory_store.insert(
        make_project(project_id="campus-events", display_name="Campus Events")
    )

    found = await in_memory_store.find_one(ProjectDocument, project_id="campus-events")
    assert found is not None and found.display_name == "Campus Events"
    assert await in_memory_store.find_one(ProjectDocument, project_id="nope") is None

    many = await in_memory_store.find_many(
        ProjectDocument, display_name="Member Portal"
    )
    assert len(many) == 1
    assert await in_memory_store.find_many(ProjectDocument, project_id="nope") == []


# ---------------------------------------------------------------------------
# assessments
# ---------------------------------------------------------------------------


async def test_latest_assessment_returns_newest(seeded_store):
    assessment = await seeded_store.latest_assessment("member-portal")
    assert assessment is not None
    assert assessment.project_id == "member-portal"
    assert await seeded_store.latest_assessment("no-such-project") is None


# ---------------------------------------------------------------------------
# clear()
# ---------------------------------------------------------------------------


async def test_clear_empties_all_tables(seeded_store):
    assert await seeded_store.list("projects")
    assert await seeded_store.list("weekly_snapshots")

    await seeded_store.clear()

    for collection in (
        "projects",
        "boundaries",
        "identity_map",
        "repo_activity",
        "weekly_snapshots",
        "warnings",
        "feedback",
        "audit_log",
        "assessments",
    ):
        assert await seeded_store.list(collection) == [], collection


async def test_clear_leaves_schema_usable(seeded_store, make_project):
    await seeded_store.clear()
    await seeded_store.insert(make_project(project_id="fresh-start"))
    assert len(await seeded_store.list("projects")) == 1


# ---------------------------------------------------------------------------
# module-level state helpers
# ---------------------------------------------------------------------------


async def test_get_db_state_and_active_repository(in_memory_store):
    state = get_db_state()
    assert isinstance(state, DatabaseState)
    assert isinstance(state.store, SqliteStore)
    assert state.in_memory is True
    assert get_active_repository() is in_memory_store


async def test_get_db_state_raises_before_init(test_settings):
    await close_db()
    with pytest.raises(RuntimeError, match="init_db"):
        get_db_state()
    # Restore module state so later tests in the same session are unaffected.
    await init_db(test_settings)
    await close_db()


async def test_init_db_is_idempotent_for_schema(test_settings):
    store = await init_db(test_settings)
    assert await store.list("projects") == []
    await close_db()
