"""Contract tests for the live People Portal generated-SDK adapter."""

from __future__ import annotations

from backend.ingestion import PeoplePortalDirectoryAdapter
from backend.people_portal import PeoplePortalApiError, PeoplePortalRecruitingClient, PeoplePortalSdkClient
from backend.recruiting import normalize_people_portal_payload
from backend.staging import InMemoryStagingStore


class FakePeoplePortalSdk:
    def __init__(self, *, fail_applications: bool = False):
        self.fail_applications = fail_applications

    async def list_active_members(self):
        return [
            {"pk": 7, "username": "alice", "name": "Alice Example", "email": "alice@example.test", "active": True},
            {"pk": 8, "username": "quiet", "name": "Quiet Example", "email": "quiet@example.test", "active": True},
        ]

    async def list_recruiting_teams(self):
        return [{"teamPk": "team-1"}]

    async def list_team_applications(self, team_id):
        assert team_id == "team-1"
        if self.fail_applications:
            raise PeoplePortalApiError("/api/ats/applications/team-1", 503)
        return [
            {"id": "application-1", "applicantId": "applicant-1", "stars": 4},
        ]

    async def application_details(self, team_id, application_id):
        assert (team_id, application_id) == ("team-1", "application-1")
        return {
            "id": application_id,
            "applicantId": "applicant-1",
            "appDevInternalPk": 7,
            "email": "alice@example.test",
            "profile": {
                "resumeSummary": "Built a reliable service.",
                "priorEmployers": "Example Labs; Small Systems",
            },
            "responses": {"whyAppDev": "I like shipping useful tools."},
            "stars": 4,
            "notes": "Explained testing tradeoffs clearly.",
        }


async def test_people_portal_sdk_source_uses_directory_and_typed_ats_operations():
    adapter = PeoplePortalRecruitingClient(
        base_url="https://people.example.test",
        token="service-token",
        sdk_client=FakePeoplePortalSdk(),
    )
    payload = await adapter.fetch_source()

    assert payload["schema"] == "horizon.people-portal-sdk.v1"
    assert payload["source"]["system"] == "people_portal_sdk"
    by_login = {candidate["member_login"]: candidate for candidate in payload["candidates"]}
    assert by_login["alice"]["people_portal_member_pk"] == 7
    assert by_login["alice"]["interview"]["score"] == 4
    assert "whyAppDev: I like shipping useful tools." in by_login["alice"]["interview"]["evidence"]
    assert by_login["alice"]["resume"]["prior_employers"] == ["Example Labs", "Small Systems"]
    assert by_login["quiet"]["source_status"] == "incomplete"
    assert all(ref["source_type"] == "people_portal_sdk" for ref in by_login["alice"]["source_refs"])

    _, documents = normalize_people_portal_payload(payload)
    normalized = {document.member_login: document for document in documents}
    assert normalized["alice"].people_portal_member_pk == 7
    assert normalized["quiet"].source_status == "incomplete"


async def test_people_portal_sdk_failure_preserves_member_with_warning():
    payload = await PeoplePortalRecruitingClient(
        base_url="https://people.example.test",
        token="service-token",
        sdk_client=FakePeoplePortalSdk(fail_applications=True),
    ).fetch_source()

    assert payload["source"]["warnings"] == [
        "People Portal recruiting applications unavailable for team team-1."
    ]
    assert {candidate["source_status"] for candidate in payload["candidates"]} == {"incomplete"}


def test_people_portal_sdk_passes_explicit_bearer_header():
    class Response:
        status = 200

        def read(self):
            return b'{"users": []}'

    class GeneratedApi:
        def __init__(self):
            self.kwargs = None

        def get_people_without_preload_content(self, **kwargs):
            self.kwargs = kwargs
            return Response()

    client = PeoplePortalSdkClient.__new__(PeoplePortalSdkClient)
    client.token = "service-token"
    client.timeout = 60.0
    generated = GeneratedApi()

    assert client._call_raw(generated, "get_people", "/api/org/people", page=1) == {"users": []}
    assert generated.kwargs["_headers"] == {
        "Authorization": "Bearer service-token",
        "Accept": "application/json",
    }


def test_people_portal_sdk_catalog_preserves_identity_issues_and_bearer_header():
    class Response:
        status = 200

        def read(self):
            return b'{"observedAt":"2026-09-13T00:00:00Z","projects":[],"identityIssues":[]}'

    class GeneratedApi:
        def __init__(self):
            self.kwargs = None

        def get_project_catalog_without_preload_content(self, **kwargs):
            self.kwargs = kwargs
            return Response()

    client = PeoplePortalSdkClient.__new__(PeoplePortalSdkClient)
    client.token = "service-token"
    client.timeout = 60.0
    generated = GeneratedApi()
    client._project_catalog = generated

    assert client.list_project_catalog_sync() == {
        "observedAt": "2026-09-13T00:00:00Z",
        "projects": [],
        "identityIssues": [],
    }
    assert generated.kwargs["_headers"] == {
        "Authorization": "Bearer service-token",
        "Accept": "application/json",
    }


async def test_people_portal_sdk_quarantines_duplicate_and_missing_email_members():
    class CollidingSdk(FakePeoplePortalSdk):
        async def list_active_members(self):
            return [
                {"pk": 7, "username": "alice", "name": "Alice", "email": " Alice@Example.test ", "active": True},
                {"pk": 8, "username": "other", "name": "Other", "email": "alice@example.test", "active": True},
                {"pk": 9, "username": "missing", "name": "Missing", "active": True},
            ]

    payload = await PeoplePortalRecruitingClient(
        base_url="https://people.example.test",
        token="service-token",
        sdk_client=CollidingSdk(),
    ).fetch_source()

    assert payload["candidates"] == []
    assert "People Portal member email collision quarantined." in payload["source"]["warnings"]
    assert "People Portal member is missing an email and was quarantined from cross-source joins." in payload["source"]["warnings"]


def test_people_portal_catalog_adapter_never_uses_a_gitea_fallback():
    class CatalogSdk:
        def list_team_hierarchy_sync(self):
            return [{"pk": "team-1", "name": "shared-resource-1", "friendlyName": "Friendly Team"}]

        def list_project_catalog_sync(self, *, include_archived=False):
            assert include_archived is False
            return {"projects": [], "identityIssues": []}

    staging = InMemoryStagingStore()
    result = PeoplePortalDirectoryAdapter(
        staging,
        base_url="https://people.example.test",
        token="service-token",
        sdk_client=CatalogSdk(),
    ).sync()

    assert result.status == "ok"
    assert staging["people_portal_projects"].find() == []
