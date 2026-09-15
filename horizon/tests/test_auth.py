"""Tests for the no-op public authentication layer in ``backend.auth``."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.auth import (
    AuthUser,
    get_ci_ingest_user,
    get_current_user,
    require_project_access,
    require_roles,
    visible_project_ids,
)
from backend.models import Role


# ---------------------------------------------------------------------------
# get_current_user()
# ---------------------------------------------------------------------------


async def test_get_current_user_returns_public_admin():
    user = await get_current_user()
    assert isinstance(user, AuthUser)
    assert user.subject == "public"
    assert user.roles == frozenset({Role.ADMIN})
    assert user.is_admin is True
    assert user.can_view_portfolio is True


async def test_get_current_user_is_stable_across_calls():
    first = await get_current_user()
    second = await get_current_user()
    assert first is second


async def test_ci_ingest_user_is_the_same_public_admin():
    assert await get_ci_ingest_user() is await get_current_user()


# ---------------------------------------------------------------------------
# AuthUser contract
# ---------------------------------------------------------------------------


def test_auth_user_is_frozen():
    user = AuthUser(subject="public", roles=frozenset({Role.ADMIN}))
    with pytest.raises(ValidationError):
        user.subject = "someone-else"


def test_auth_user_forbids_extra_fields():
    with pytest.raises(ValidationError):
        AuthUser(subject="public", roles=frozenset(), tenant="acme")


def test_auth_user_requires_a_subject():
    with pytest.raises(ValidationError):
        AuthUser(subject="")


def test_auth_user_role_predicates_for_non_admin():
    leader = AuthUser(subject="lead", roles=frozenset({Role.PORTFOLIO_LEADER}))
    assert leader.is_admin is False
    assert leader.can_view_portfolio is True

    project_lead = AuthUser(subject="pl", roles=frozenset({Role.PROJECT_LEAD}))
    assert project_lead.is_admin is False
    assert project_lead.can_view_portfolio is False


def test_auth_user_defaults_to_no_roles():
    anonymous = AuthUser(subject="nobody")
    assert anonymous.roles == frozenset()
    assert anonymous.is_admin is False


# ---------------------------------------------------------------------------
# require_roles()
# ---------------------------------------------------------------------------


async def test_require_roles_passes_for_admin():
    dependency = require_roles(Role.ADMIN)
    user = await dependency(await get_current_user())
    assert user.is_admin


async def test_require_roles_never_blocks_any_role_combination():
    for roles in (
        (Role.ADMIN,),
        (Role.PORTFOLIO_LEADER,),
        (Role.PROJECT_LEAD,),
        (Role.ADMIN, Role.PORTFOLIO_LEADER),
        (),
    ):
        dependency = require_roles(*roles)
        assert await dependency(await get_current_user()) is not None


async def test_require_roles_returns_a_fresh_callable_each_time():
    first = require_roles(Role.ADMIN)
    second = require_roles(Role.ADMIN)
    assert first is not second
    assert callable(first) and callable(second)


# ---------------------------------------------------------------------------
# require_project_access()
# ---------------------------------------------------------------------------


async def test_require_project_access_passes_for_admin():
    user = await get_current_user()
    granted = await require_project_access("member-portal", user)
    assert granted is user


async def test_require_project_access_grants_unknown_projects_too():
    """Access control is disabled; existence is checked by the route, not here."""
    user = await get_current_user()
    assert await require_project_access("no-such-project", user) is user


# ---------------------------------------------------------------------------
# visible_project_ids()
# ---------------------------------------------------------------------------


async def test_visible_project_ids_returns_all_ids_for_admin():
    user = await get_current_user()
    all_ids = ["member-portal", "campus-events", "design-system"]
    assert visible_project_ids(user, all_ids) == all_ids


async def test_visible_project_ids_returns_a_copy():
    user = await get_current_user()
    all_ids = ["member-portal"]
    result = visible_project_ids(user, all_ids)
    result.append("mutated")
    assert all_ids == ["member-portal"]


def test_visible_project_ids_handles_empty_portfolio():
    user = AuthUser(subject="public", roles=frozenset({Role.ADMIN}))
    assert visible_project_ids(user, []) == []


def test_visible_project_ids_hides_projects_for_roleless_user():
    anonymous = AuthUser(subject="nobody")
    assert visible_project_ids(anonymous, ["a", "b"]) == []
