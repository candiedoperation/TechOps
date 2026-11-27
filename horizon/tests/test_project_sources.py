"""T1.1: People Portal payload validation and semester windows."""

from datetime import date

import pytest

from pipeline.project_sources import PeoplePortalPayloadError, parse_project_sources, semester_window
from project_source_fixtures import NOW, member, payload


# --- payload validation -------------------------------------------------------


def test_valid_payload_flattens_to_rows():
    sources = parse_project_sources(payload(), "FALL", 2026, NOW)
    [project] = sources.projects
    assert project.gitea_org == "Atlas" and project.friendly_name == "Atlas App"
    assert [m.authentik_user_pk for m in sources.members] == ["123", "7"]
    assert sources.members[0].roles == ("tech_lead",)
    assert sources.members[0].role_mapping_version == "2026-11-v1"
    assert sources.retrieved_at == NOW


@pytest.mark.parametrize(
    "bad_member",
    [
        member(userPk=""),
        member(tenureSemesters="3"),
        member(tenureSemesters=-1),
        member(roles="tech_lead"),
        {k: v for k, v in member().items() if k != "email"},
        member(roleTitles=["Tech Lead"]),
    ],
)
def test_any_malformed_member_fails_the_payload(bad_member):
    project = payload()["projects"][0] | {"members": [member(), bad_member]}
    with pytest.raises(PeoplePortalPayloadError, match="malformed"):
        parse_project_sources(payload([project]), "FALL", 2026, NOW)


def test_malformed_payload_error_does_not_echo_member_values():
    project = payload()["projects"][0] | {"members": [member(email=None, name="Secret Person")]}
    with pytest.raises(PeoplePortalPayloadError) as error:
        parse_project_sources(payload([project]), "FALL", 2026, NOW)
    assert "Secret Person" not in str(error.value)


def test_wrong_season_duplicate_project_and_duplicate_member_fail():
    with pytest.raises(PeoplePortalPayloadError, match="expected FALL 2026"):
        parse_project_sources(payload(seasonYear=2025), "FALL", 2026, NOW)
    project = payload()["projects"][0]
    with pytest.raises(PeoplePortalPayloadError, match="twice"):
        parse_project_sources(payload([project, project]), "FALL", 2026, NOW)
    with pytest.raises(PeoplePortalPayloadError, match="twice"):
        parse_project_sources(
            payload([project | {"members": [member(), member()]}]), "FALL", 2026, NOW
        )


# --- semester windows ---------------------------------------------------------


def test_window_falls_back_to_semester_defaults_per_side():
    assert semester_window("FALL", 2026) == (date(2026, 8, 31), date(2026, 12, 11))
    project = payload()["projects"][0]
    both_null = project | {"teamStartDate": None, "teamEndDate": None}
    [row] = parse_project_sources(payload([both_null]), "FALL", 2026, NOW).projects
    assert (row.window_start, row.window_end) == (date(2026, 8, 31), date(2026, 12, 11))
    [row] = parse_project_sources(payload(), "FALL", 2026, NOW).projects
    assert (row.window_start, row.window_end) == (date(2026, 9, 8), date(2026, 12, 11))


def test_window_errors():
    with pytest.raises(PeoplePortalPayloadError, match="No default window"):
        semester_window("SPRING", 2031)
    project = payload()["projects"][0] | {"teamStartDate": "2026-12-20", "teamEndDate": "2026-12-01"}
    with pytest.raises(PeoplePortalPayloadError, match="before it starts"):
        parse_project_sources(payload([project]), "FALL", 2026, NOW)
