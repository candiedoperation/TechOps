from datetime import date, datetime, timezone

import pytest

from pipeline.ranking.members import (
    ProjectMemberRow,
    ProjectRow,
    RoleMappingError,
    resolve_role_mapping_version,
    select_ranked_members,
)

AS_OF = datetime(2026, 11, 9, 15, 0, tzinfo=timezone.utc)


def _project(pk="p1", *, archived=False, window_end=date(2026, 12, 15), **overrides):
    values = dict(
        project_pk=pk,
        season_type="FALL",
        season_year=2026,
        name=f"group-{pk}",
        friendly_name=f"Project {pk.upper()}",
        window_start=date(2026, 9, 1),
        window_end=window_end,
        archived=archived,
    )
    values.update(overrides)
    return ProjectRow(**values)


def _member(user, roles, project="p1", **overrides):
    values = dict(
        project_pk=project,
        authentik_user_pk=user,
        username=f"user-{user}",
        display_name=f"Member {user}",
        roles=tuple(roles),
        role_titles={},
        tenure_semesters=2,
        role_mapping_version="2026-11-v1",
    )
    values.update(overrides)
    return ProjectMemberRow(**values)


def _by_user(rows):
    return {row.authentik_user_pk: row for row in rows}


def test_a_member_with_both_roles_is_ranked_once_as_tech_lead():
    rows = select_ranked_members(
        [_project()], [_member("u1", ["engineer", "tech_lead"])], AS_OF
    )

    assert len(rows) == 1
    assert rows[0].role == "tech_lead"
    assert rows[0].comparison_group == "club:tech_lead"


def test_engineers_are_grouped_by_project():
    rows = select_ranked_members(
        [_project("p1"), _project("p2")],
        [_member("u1", ["engineer"], "p1"), _member("u2", ["engineer"], "p2")],
        AS_OF,
    )

    assert {row.comparison_group for row in rows} == {
        "project:p1:engineer",
        "project:p2:engineer",
    }


@pytest.mark.parametrize(
    "roles",
    [["pm"], ["designer"], ["project_lead"], ["unknown"], ["pm", "designer", "project_lead"], []],
)
def test_members_without_an_engineer_or_tech_lead_role_are_skipped(roles):
    assert select_ranked_members([_project()], [_member("u1", roles)], AS_OF) == []


def test_project_leads_who_also_engineer_are_ranked_as_engineers():
    rows = select_ranked_members(
        [_project()], [_member("u1", ["project_lead", "engineer"])], AS_OF
    )

    assert [row.role for row in rows] == ["engineer"]


def test_archived_projects_and_members_of_unknown_projects_are_skipped():
    rows = select_ranked_members(
        [_project("p1", archived=True), _project("p2")],
        [
            _member("u1", ["engineer"], "p1"),
            _member("u2", ["engineer"], "p2"),
            _member("u3", ["engineer"], "p9"),
        ],
        AS_OF,
    )

    assert set(_by_user(rows)) == {"u2"}


def test_window_end_is_capped_at_the_as_of_date_in_new_york():
    # 03:00 UTC on Nov 10 is still Nov 9 in New York (UTC-5).
    late_evening = datetime(2026, 11, 10, 3, 0, tzinfo=timezone.utc)
    rows = select_ranked_members([_project()], [_member("u1", ["engineer"])], late_evening)

    assert rows[0].window_start == date(2026, 9, 1)
    assert rows[0].window_end == date(2026, 11, 9)


def test_window_end_is_kept_when_the_semester_already_ended():
    rows = select_ranked_members(
        [_project(window_end=date(2026, 11, 1))], [_member("u1", ["engineer"])], AS_OF
    )

    assert rows[0].window_end == date(2026, 11, 1)


def test_naive_as_of_is_rejected():
    with pytest.raises(ValueError, match="timezone-aware"):
        select_ranked_members([_project()], [], datetime(2026, 11, 9))


def test_display_name_falls_back_to_username_then_pk():
    rows = select_ranked_members(
        [_project()],
        [
            _member("u1", ["engineer"]),
            _member("u2", ["engineer"], display_name="  "),
            _member("u3", ["engineer"], display_name=None, username=None),
        ],
        AS_OF,
    )
    names = {pk: row.display_name for pk, row in _by_user(rows).items()}

    assert names == {"u1": "Member u1", "u2": "user-u2", "u3": "u3"}


def test_role_titles_are_deduplicated_sorted_and_joined():
    rows = select_ranked_members(
        [_project()],
        [
            _member(
                "u1",
                ["tech_lead", "engineer"],
                role_titles={"t2": "Tech Lead", "t1": "Backend Engineer", "t3": "Tech Lead"},
            ),
            _member("u2", ["engineer"], role_titles={"t1": " "}),
        ],
        AS_OF,
    )
    titles = {pk: row.role_title for pk, row in _by_user(rows).items()}

    assert titles == {"u1": "Backend Engineer, Tech Lead", "u2": None}


def test_project_name_and_tenure_come_from_the_roster():
    rows = select_ranked_members(
        [_project("p1")], [_member("u1", ["engineer"], tenure_semesters=4)], AS_OF
    )

    assert rows[0].project_name == "Project P1"
    assert rows[0].tenure_semesters == 4


def test_role_mapping_version_is_the_single_live_value():
    projects = [_project("p1"), _project("p2", archived=True)]
    members = [
        _member("u1", ["engineer"], "p1"),
        _member("u2", ["pm"], "p1"),
        _member("u3", ["engineer"], "p2", role_mapping_version="2026-09-v0"),
    ]

    assert resolve_role_mapping_version(projects, members) == "2026-11-v1"


def test_mixed_role_mapping_versions_are_rejected():
    members = [
        _member("u1", ["engineer"]),
        _member("u2", ["engineer"], role_mapping_version="2026-12-v2"),
    ]

    with pytest.raises(RoleMappingError, match="mixed role mapping versions"):
        resolve_role_mapping_version([_project()], members)


def test_an_empty_roster_has_no_role_mapping_version():
    with pytest.raises(RoleMappingError, match="No project members"):
        resolve_role_mapping_version([_project()], [])
