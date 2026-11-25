"""Shared fixtures for the T1.1 source tests: a People Portal payload and a Gitea transport."""

from datetime import datetime, timezone

NOW = datetime(2026, 11, 14, tzinfo=timezone.utc)


def member(**overrides):
    value = {
        "userPk": "123",
        "username": "jdoe",
        "email": "j@x.edu",
        "name": "Jane Doe",
        "roles": ["tech_lead"],
        "roleTitles": {"g1": "Tech Lead"},
        "tenureSemesters": 3,
    }
    value.update(overrides)
    return value


def payload(projects=None, **overrides):
    value = {
        "seasonType": "FALL",
        "seasonYear": 2026,
        "generatedAt": "2026-11-14T05:00:00Z",
        "roleMappingVersion": "2026-11-v1",
        "projects": projects
        if projects is not None
        else [
            {
                "projectPk": "p1",
                "name": "Atlas",
                "friendlyName": "Atlas App",
                "teamStartDate": "2026-09-08",
                "teamEndDate": None,
                "archived": False,
                "members": [member(), member(userPk="7", username="Eng1", roles=["engineer"])],
            }
        ],
    }
    value.update(overrides)
    return value
