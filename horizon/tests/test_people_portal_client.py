"""T1.1: the People Portal client and Gitea login resolution."""

import httpx
import pytest

from pipeline.config import PipelineConfigError
from pipeline.identity import resolve_gitea_login
from pipeline.project_sources import ProjectMemberRow
from pipeline.resources import AuthentikRoster, AuthentikUser, PeoplePortalClient
from project_source_fixtures import NOW, payload, use_transport


# --- login resolution ---------------------------------------------------------


def roster_member(pk, username):
    return ProjectMemberRow("p1", pk, username, "", "", (), {}, 0, "v1")


def test_gitea_login_resolves_case_insensitively_and_never_guesses():
    roster = [roster_member("1", "JDoe"), roster_member("2", "amy"), roster_member("2", "amy")]
    assert resolve_gitea_login("jdoe", roster) == "1"
    assert resolve_gitea_login(" JDOE ", roster) == "1"
    assert resolve_gitea_login("amy", roster) == "2"  # same person on two projects
    assert resolve_gitea_login("nobody", roster) is None
    assert resolve_gitea_login("", roster) is None
    assert resolve_gitea_login(None, roster) is None
    ambiguous = roster + [roster_member("3", "AMY")]
    assert resolve_gitea_login("amy", ambiguous) is None


def test_gitea_login_accepts_an_authentik_roster():
    user = AuthentikUser("9", "Zed", "z@x.edu", "Zed", True, NOW)
    assert resolve_gitea_login("zed", AuthentikRoster([user], NOW)) == "9"


def test_people_portal_client_sends_bearer_token_and_validates(monkeypatch):
    seen = {}

    def handler(request):
        seen["auth"] = request.headers["authorization"]
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json=payload())

    use_transport(monkeypatch, handler)
    client = PeoplePortalClient(base_url="https://pp.example/", service_token="s3cret")
    sources = client.get_projects("FALL", 2026)
    assert seen == {"auth": "Bearer s3cret", "params": {"seasonType": "FALL", "seasonYear": "2026"}}
    assert len(sources.members) == 2
    with pytest.raises(PipelineConfigError, match="SERVICE_TOKEN"):
        PeoplePortalClient(base_url="https://pp.example").get_projects("FALL", 2026)
