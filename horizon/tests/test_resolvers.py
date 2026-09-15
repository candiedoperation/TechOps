"""Tests for the boundary and team-size resolvers in ``backend.resolvers``."""

from __future__ import annotations

from datetime import date

from backend.ingestion import AUTHENTIK_TEAMS_COLLECTION, PEOPLE_PORTAL_TEAMS_COLLECTION
from backend.models import RepositoryRef, SharedRepositoryRef
from backend.resolvers import build_boundary_resolver, build_team_size_resolver


# ---------------------------------------------------------------------------
# build_boundary_resolver()
# ---------------------------------------------------------------------------


async def test_boundary_resolver_maps_repo_keys_to_project_ids(
    in_memory_store, make_boundary
):
    await in_memory_store.insert(
        make_boundary(
            project_id="member-portal",
            primary_repos=[
                RepositoryRef(gitea_repo_id="gitea-1", repo_slug="member-portal"),
                RepositoryRef(gitea_repo_id="gitea-2", repo_slug="member-portal-api"),
            ],
        )
    )

    mapping = await build_boundary_resolver(in_memory_store, at=date(2026, 8, 3))

    # Both naming conventions resolve to the same owning project.
    assert mapping["member-portal"] == ["member-portal"]
    assert mapping["gitea-1"] == ["member-portal"]
    assert mapping["member-portal-api"] == ["member-portal"]
    assert mapping["gitea-2"] == ["member-portal"]


async def test_boundary_resolver_includes_shared_repositories(
    in_memory_store, make_boundary
):
    await in_memory_store.insert(
        make_boundary(
            project_id="member-portal",
            primary_repos=[RepositoryRef(gitea_repo_id="g1", repo_slug="member-portal")],
            shared_repos=[
                SharedRepositoryRef(
                    gitea_repo_id="g-shared",
                    repo_slug="shared-lib",
                    shared_with_project_ids=["campus-events"],
                )
            ],
        )
    )

    mapping = await build_boundary_resolver(in_memory_store, at=date(2026, 8, 3))
    assert mapping["shared-lib"] == ["member-portal"]


async def test_boundary_resolver_lists_every_owner_of_a_shared_repo(
    in_memory_store, make_boundary
):
    shared = RepositoryRef(gitea_repo_id="g-shared", repo_slug="shared-lib")
    await in_memory_store.insert(
        make_boundary(project_id="member-portal", primary_repos=[shared])
    )
    await in_memory_store.insert(
        make_boundary(
            project_id="campus-events",
            root_authentik_team_id="community-programs",
            primary_repos=[shared],
        )
    )

    mapping = await build_boundary_resolver(in_memory_store, at=date(2026, 8, 3))
    assert mapping["shared-lib"] == ["campus-events", "member-portal"]


async def test_boundary_resolver_honours_excluded_repos(in_memory_store, make_boundary):
    await in_memory_store.insert(
        make_boundary(
            primary_repos=[
                RepositoryRef(gitea_repo_id="g1", repo_slug="member-portal"),
                RepositoryRef(gitea_repo_id="g2", repo_slug="member-portal-sandbox"),
            ],
            excluded_repos=["member-portal-sandbox"],
        )
    )

    mapping = await build_boundary_resolver(in_memory_store, at=date(2026, 8, 3))
    assert "member-portal" in mapping
    assert "member-portal-sandbox" not in mapping
    # The gitea id of an excluded repo is still excluded only by matching key.
    assert mapping.get("g2") == ["member-portal"]


async def test_boundary_resolver_filters_by_effective_date(
    in_memory_store, make_boundary
):
    await in_memory_store.insert(
        make_boundary(
            effective_from=date(2026, 1, 1),
            effective_to=date(2026, 5, 31),
            primary_repos=[RepositoryRef(gitea_repo_id="g-old", repo_slug="old-repo")],
        )
    )
    await in_memory_store.insert(
        make_boundary(
            effective_from=date(2026, 6, 1),
            effective_to=None,
            primary_repos=[RepositoryRef(gitea_repo_id="g-new", repo_slug="new-repo")],
        )
    )

    in_march = await build_boundary_resolver(in_memory_store, at=date(2026, 3, 1))
    assert "old-repo" in in_march
    assert "new-repo" not in in_march

    in_august = await build_boundary_resolver(in_memory_store, at=date(2026, 8, 3))
    assert "new-repo" in in_august
    assert "old-repo" not in in_august

    before_any = await build_boundary_resolver(in_memory_store, at=date(2025, 1, 1))
    assert before_any == {}


async def test_boundary_resolver_defaults_to_today(in_memory_store, make_boundary):
    await in_memory_store.insert(
        make_boundary(
            effective_from=date(2020, 1, 1),
            primary_repos=[RepositoryRef(gitea_repo_id="g1", repo_slug="member-portal")],
        )
    )
    mapping = await build_boundary_resolver(in_memory_store)
    assert mapping["member-portal"] == ["member-portal"]


async def test_boundary_resolver_on_empty_database(in_memory_store):
    assert await build_boundary_resolver(in_memory_store, at=date(2026, 8, 3)) == {}


async def test_boundary_resolver_skips_boundaries_without_repos(
    in_memory_store, make_boundary
):
    await in_memory_store.insert(make_boundary(primary_repos=[]))
    assert await build_boundary_resolver(in_memory_store, at=date(2026, 8, 3)) == {}


async def test_boundary_resolver_over_the_seeded_portfolio(seeded_store):
    mapping = await build_boundary_resolver(seeded_store, at=date(2026, 8, 3))
    assert mapping["member-portal"] == ["member-portal"]
    assert mapping["campus-events"] == ["campus-events"]
    assert mapping["design-system"] == ["design-system"]


# ---------------------------------------------------------------------------
# build_team_size_resolver()
# ---------------------------------------------------------------------------


async def test_team_size_resolver_maps_project_ids_to_team_sizes(
    in_memory_store, staging_store, make_boundary
):
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one(
        {"team_id": "product-experience", "team_size": 8}
    )
    await in_memory_store.insert(
        make_boundary(
            project_id="member-portal",
            root_authentik_team_id="product-experience",
            primary_repos=[RepositoryRef(gitea_repo_id="g1", repo_slug="member-portal")],
        )
    )

    sizes = await build_team_size_resolver(
        staging_store, at=date(2026, 8, 3), boundaries=in_memory_store
    )

    assert sizes["member-portal"] == 8
    # Repository keys inherit the owning team's size for the floor gate.
    assert sizes["g1"] == 8


async def test_team_size_resolver_reads_both_directory_sources(
    in_memory_store, staging_store, make_boundary
):
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one(
        {"team_id": "product-experience", "team_size": 8}
    )
    staging_store[PEOPLE_PORTAL_TEAMS_COLLECTION].insert_one(
        {"team_id": "community-programs", "team_size": 7}
    )
    await in_memory_store.insert(
        make_boundary(project_id="member-portal", root_authentik_team_id="product-experience")
    )
    await in_memory_store.insert(
        make_boundary(project_id="campus-events", root_authentik_team_id="community-programs")
    )

    sizes = await build_team_size_resolver(
        staging_store, at=date(2026, 8, 3), boundaries=in_memory_store
    )
    assert sizes["member-portal"] == 8
    assert sizes["campus-events"] == 7


async def test_team_size_resolver_newest_staging_row_wins(
    in_memory_store, staging_store, make_boundary
):
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one(
        {"team_id": "product-experience", "team_size": 5}
    )
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one(
        {"team_id": "product-experience", "team_size": 9}
    )
    await in_memory_store.insert(make_boundary(root_authentik_team_id="product-experience"))

    sizes = await build_team_size_resolver(
        staging_store, at=date(2026, 8, 3), boundaries=in_memory_store
    )
    assert sizes["member-portal"] == 9


async def test_team_size_resolver_shared_repo_takes_the_largest_team(
    in_memory_store, staging_store, make_boundary
):
    shared = RepositoryRef(gitea_repo_id="g-shared", repo_slug="shared-lib")
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one(
        {"team_id": "small-team", "team_size": 4}
    )
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one(
        {"team_id": "big-team", "team_size": 12}
    )
    await in_memory_store.insert(
        make_boundary(
            project_id="member-portal",
            root_authentik_team_id="small-team",
            primary_repos=[shared],
        )
    )
    await in_memory_store.insert(
        make_boundary(
            project_id="campus-events",
            root_authentik_team_id="big-team",
            primary_repos=[shared],
        )
    )

    sizes = await build_team_size_resolver(
        staging_store, at=date(2026, 8, 3), boundaries=in_memory_store
    )
    assert sizes["shared-lib"] == 12


async def test_team_size_resolver_filters_by_effective_date(
    in_memory_store, staging_store, make_boundary
):
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one(
        {"team_id": "old-team", "team_size": 4}
    )
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one(
        {"team_id": "new-team", "team_size": 11}
    )
    await in_memory_store.insert(
        make_boundary(
            root_authentik_team_id="old-team",
            effective_from=date(2026, 1, 1),
            effective_to=date(2026, 5, 31),
        )
    )
    await in_memory_store.insert(
        make_boundary(root_authentik_team_id="new-team", effective_from=date(2026, 6, 1))
    )

    in_march = await build_team_size_resolver(
        staging_store, at=date(2026, 3, 1), boundaries=in_memory_store
    )
    assert in_march["member-portal"] == 4

    in_august = await build_team_size_resolver(
        staging_store, at=date(2026, 8, 3), boundaries=in_memory_store
    )
    assert in_august["member-portal"] == 11


async def test_team_size_resolver_omits_teams_without_a_published_size(
    in_memory_store, staging_store, make_boundary
):
    """A team below the aggregation floor publishes no size and stays unmapped."""
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one(
        {"team_id": "product-experience", "team_size": None}
    )
    await in_memory_store.insert(make_boundary(root_authentik_team_id="product-experience"))

    sizes = await build_team_size_resolver(
        staging_store, at=date(2026, 8, 3), boundaries=in_memory_store
    )
    assert "member-portal" not in sizes


async def test_team_size_resolver_ignores_rows_without_a_team_id(
    in_memory_store, staging_store, make_boundary
):
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one({"team_size": 8})
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one({"team_id": "", "team_size": 8})
    await in_memory_store.insert(make_boundary(root_authentik_team_id="product-experience"))

    sizes = await build_team_size_resolver(
        staging_store, at=date(2026, 8, 3), boundaries=in_memory_store
    )
    assert sizes == {}


async def test_team_size_resolver_with_no_boundaries(in_memory_store, staging_store):
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one(
        {"team_id": "product-experience", "team_size": 8}
    )
    sizes = await build_team_size_resolver(
        staging_store, at=date(2026, 8, 3), boundaries=in_memory_store
    )
    assert sizes == {}


async def test_team_size_resolver_over_the_seeded_portfolio(seeded_store, staging_store):
    staging_store[AUTHENTIK_TEAMS_COLLECTION].insert_one(
        {"team_id": "product-experience", "team_size": 8}
    )
    sizes = await build_team_size_resolver(
        staging_store, at=date(2026, 8, 3), boundaries=seeded_store
    )
    assert sizes["member-portal"] == 8
    assert "campus-events" not in sizes
