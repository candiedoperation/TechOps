"""T3.1 rules ported for reading the roster from Authentik directly."""
from datetime import datetime, timezone

import httpx
import pytest

from pipeline.authentik_roster import (AuthentikRosterClient, build_roster, normalize_role,
                                       subteam_context)
from pipeline.config import PipelineSettings
from pipeline.resources import PeoplePortalClient, build_resources

PROJECT = {"pk": "p1", "name": "IonQFALL2026",
           "attributes": {"seasonType": "FALL", "seasonYear": 2026, "friendlyName": "IonQ",
                          "teamType": "PROJECT", "peoplePortalCreation": True}}


@pytest.mark.parametrize("context,title,role", [
    ("project", "Project Lead", "project_lead"),
    ("Leadership", "Project Lead", "project_lead"),
    ("Engineering", "Project Lead", "unknown"),
    ("Leadership", "Technical Lead", "tech_lead"),
    ("Engineering", "Tech Lead", "unknown"),
    ("Engineering", "Software Engineer", "engineer"),
    ("Engineering", "Full-stack Developer", "engineer"),
    ("Leadership", "Software Engineer", "unknown"),
    ("Engineering", "Product Manager", "pm"),
    ("Engineering", "UI/UX Designer", "designer"),
    ("Engineering", "  ", "unknown"),
])
def test_normalize_role_matches_people_portal(context, title, role):
    assert normalize_role(context, title) == role


@pytest.mark.parametrize("name,context", [
    ("Leadership", "Leadership"), ("Engineering", "Engineering"),
    ("IonQLeadershipFALL2026", "Leadership"), ("IonQEngineeringFALL2026", "Engineering"),
    ("IonQFALL2026EngineeringFALL2026", "Engineering"), ("Interns", "unknown"),
])
def test_subteam_context_matches_people_portal_names(name, context):
    assert subteam_context(PROJECT, {"name": name}) == context


def _user(pk, username, roles):
    return {"pk": pk, "username": username, "email": f"{username}@x.test", "name": username.title(),
            "attributes": {"roles": roles}}


def test_build_roster_maps_subteam_titles_and_tenure():
    lead = _user(7, "lena", {"lead": "Technical Lead", "p1": "Project Lead"})
    eng = _user(9, "eli", {"eng": "Software Engineer"})
    project = {**PROJECT, "users": [lead], "subteams": [
        {"pk": "lead", "name": "IonQLeadershipFALL2026", "users": [lead]},
        {"pk": "eng", "name": "IonQEngineeringFALL2026", "users": [eng]}]}
    older = {"pk": "p0", "name": "IonQSPRING2026", "attributes": {"seasonType": "SPRING", "seasonYear": 2026},
             "users": [], "subteams": [{"pk": "e0", "name": "Engineering", "users": [eng]}]}
    rows = {r["projectPk"]: r for r in build_roster([project, older])}
    members = {m["userPk"]: m for m in rows["p1"]["members"]}
    assert members["7"]["roles"] == ["project_lead", "tech_lead"]
    assert members["9"]["roles"] == ["engineer"]
    assert members["9"]["tenureSemesters"] == 2 and members["7"]["tenureSemesters"] == 1
    assert rows["p1"]["friendlyName"] == "IonQ" and rows["p1"]["archived"] is False


def test_member_without_title_is_unknown_not_dropped():
    project = {**PROJECT, "users": [], "subteams": [
        {"pk": "eng", "name": "IonQEngineeringFALL2026", "users": [_user(3, "ana", {})]}]}
    assert build_roster([project])[0]["members"][0]["roles"] == ["unknown"]


def test_get_projects_reads_authentik_and_validates_like_people_portal(monkeypatch):
    lead = _user(7, "lena", {"lead": "Technical Lead"})
    groups = {
        "list": {"results": [
            {"pk": "p1", "name": "IonQFALL2026", "parent": None, "attributes": PROJECT["attributes"]},
            {"pk": "p2", "name": "IonQSPRING2026", "parent": None,
             "attributes": {**PROJECT["attributes"], "seasonType": "SPRING"}},
            {"pk": "lead", "name": "IonQLeadershipFALL2026", "parent": "p1", "attributes": {}},
            {"pk": "x", "name": "Admins", "parent": None, "attributes": {}}],
            "pagination": {"next": 0}},
        "p1": {"pk": "p1", "name": "IonQFALL2026", "attributes": PROJECT["attributes"], "users_obj": [],
               "children_obj": [{"pk": "lead", "name": "IonQLeadershipFALL2026", "attributes": {}}]},
        "p2": {"pk": "p2", "name": "IonQSPRING2026", "attributes": {**PROJECT["attributes"], "seasonType": "SPRING"},
               "users_obj": [], "children_obj": []},
        "lead": {"pk": "lead", "name": "IonQLeadershipFALL2026", "users_obj": [lead], "children_obj": []},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer tok"
        path = request.url.path.rstrip("/").split("/")[-1]
        return httpx.Response(200, json=groups["list" if path == "groups" else path])

    transport = httpx.MockTransport(handler)
    real_client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: real_client(transport=transport, **kw))
    sources = AuthentikRosterClient(authentik_url="https://auth.test", authentik_token="tok").get_projects("FALL", 2026)
    assert [p.project_pk for p in sources.projects] == ["p1"]
    assert sources.projects[0].gitea_org == "IonQFALL2026"
    assert [(m.authentik_user_pk, m.roles) for m in sources.members] == [("7", ("tech_lead",))]
    assert sources.role_mapping_version.startswith("authentik-direct")


def test_build_resources_selects_the_roster_source():
    default = build_resources(PipelineSettings(_env_file=None))["peopleportal"]
    assert type(default) is PeoplePortalClient
    chosen = build_resources(PipelineSettings(_env_file=None, HORIZON_ROSTER_SOURCE="authentik",
                                              HORIZON_AUTHENTIK_URL="https://auth.test", HORIZON_AUTHENTIK_API_TOKEN="t"))["peopleportal"]
    assert isinstance(chosen, AuthentikRosterClient) and chosen.authentik_url == "https://auth.test"


def test_include_archived_reports_a_past_seasons_repositories_as_active(monkeypatch):
    payload = [{"name": "old", "owner": {"login": "OrgSPRING2026"}, "default_branch": "main",
                "archived": True, "empty": False}]
    from pipeline.resources import GiteaClient
    weekly = GiteaClient(base_url="https://git.test", api_token="t")
    backfill = GiteaClient(base_url="https://git.test", api_token="t", include_archived=True)
    def listed(client):
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json=payload, headers={"X-Total-Count": "1"}))
        real = httpx.Client
        monkeypatch.setattr(httpx, "Client", lambda **kw: real(transport=transport, **kw))
        try:
            return client.list_org_repositories("OrgSPRING2026")[0].archived
        finally:
            monkeypatch.setattr(httpx, "Client", real)
    assert listed(weekly) is True and listed(backfill) is False
