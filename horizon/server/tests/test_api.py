from datetime import datetime, timedelta, timezone
from uuid import UUID

import psycopg
import pytest
from pydantic import ValidationError

from app.auth import Principal, current_user
from app.errors import ReadUnavailable
from app.models import metadata
from app.ports import get_audit, get_store

PARAMS = {"seasonType": "FALL", "seasonYear": 2026}


@pytest.mark.parametrize(
    "path",
    [
        "/api/me",
        "/api/semesters",
        "/api/rankings",
        "/api/rankings/members/fiction-user-1",
    ],
)
def test_unauthenticated(api, path):
    response = api[0].get(path, params=PARAMS)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "path", ["/api/rankings", "/api/rankings/members/fiction-user-1"]
)
def test_non_executive(api, path):
    client, application, _, audit = api
    application.dependency_overrides[current_user] = lambda: Principal(
        "fiction-member", "Fictional Member", False
    )
    assert client.get(path, params=PARAMS).status_code == 403
    assert not audit.events


def test_me_and_semesters(executive):
    client = executive[0]
    assert client.get("/api/me").json() == {
        "userPk": "fiction-exec",
        "name": "Fictional Executive",
        "isExec": True,
        "projects": [
            {"projectPk": "fiction-project", "friendlyName": "Fictional Lantern"}
        ],
    }
    assert client.get("/api/semesters").json() == [
        {"seasonType": "FALL", "seasonYear": 2026}
    ]


@pytest.mark.parametrize(
    "selection,expected", [("latest", 3), ("final", 2), (str(UUID(int=1)), 1)]
)
def test_selection(executive, selection, expected):
    response = executive[0].get("/api/rankings", params={**PARAMS, "run": selection})
    assert response.status_code == 200
    assert response.json()["rankingRunId"] == str(UUID(int=expected))
    assert response.json()["stale"] is True
    assert executive[3].events[0][2] == UUID(int=expected)


@pytest.mark.parametrize(
    "selection",
    [str(UUID(int=4)), str(UUID(int=5)), str(UUID(int=6)), str(UUID(int=99))],
)
def test_non_complete_or_wrong_semester_not_returned(executive, selection):
    assert (
        executive[0]
        .get("/api/rankings", params={**PARAMS, "run": selection})
        .status_code
        == 404
    )


def test_final_never_falls_back(executive):
    for run in executive[2].publications:
        run.is_final = False
    assert (
        executive[0].get("/api/rankings", params={**PARAMS, "run": "final"}).status_code
        == 404
    )


def test_stable_pagination_and_filters(executive):
    client = executive[0]
    first = client.get("/api/rankings", params={**PARAMS, "pageSize": 2}).json()
    second = client.get(
        "/api/rankings", params={**PARAMS, "pageSize": 2, "page": 2}
    ).json()
    assert [row["userPk"] for row in first["items"] + second["items"]] == [
        f"fiction-user-{index}" for index in range(1, 5)
    ]
    assert first["total"] == second["total"] == 4
    filtered = client.get(
        "/api/rankings",
        params={**PARAMS, "role": "engineer", "projectPk": "fiction-project"},
    ).json()
    assert len(filtered["items"]) == 2
    assert (
        client.get("/api/rankings", params={**PARAMS, "projectPk": "absent"}).json()[
            "items"
        ]
        == []
    )
    assert (
        client.get("/api/rankings", params={**PARAMS, "page": 3, "pageSize": 2}).json()[
            "items"
        ]
        == []
    )
    spring = client.get(
        "/api/rankings", params={**PARAMS, "seasonType": "SPRING"}
    ).json()
    assert spring["rankingRunId"] == str(UUID(int=6))


def test_missing_scores_metrics_and_history(executive):
    client = executive[0]
    response = client.get("/api/rankings/members/fiction-user-4", params=PARAMS)
    assert response.status_code == 200
    detail = response.json()
    row = detail["items"][0]
    assert row["ranking"]["overallScore"] is None
    assert row["ranking"]["rankInGroup"] is None
    assert row["evidence"] == row["explanations"] == []
    assert row["metrics"][0]["rawValue"] is None
    assert row["metrics"][0]["missingReason"]
    assert len(detail["history"]) == 3
    assert all(item["overallScore"] is None for item in detail["history"])
    detail = client.get("/api/rankings/members/fiction-user-1", params=PARAMS).json()
    assert len({item["overallScore"] for item in detail["history"]}) == 3
    assert detail["items"][0]["explanations"][0]["sourceType"] == "claude_generated"
    assert detail["items"][0]["evidence"][0]["sourceType"] == "fixture"
    assert client.get("/api/rankings/members/absent", params=PARAMS).status_code == 404


@pytest.mark.parametrize(
    "parameters",
    [
        {"seasonType": "SUMMER"},
        {"seasonYear": 1999},
        {"page": 0},
        {"pageSize": 101},
        {"pageSize": -1},
        {"role": "admin"},
        {"run": "invalid-secret-test"},
        {"projectPk": ""},
    ],
)
def test_invalid_parameters(executive, parameters):
    response = executive[0].get("/api/rankings", params={**PARAMS, **parameters})
    assert response.status_code == 422
    assert "invalid-secret-test" not in response.text


def test_db_failure_is_safe(executive):
    def broken():
        raise psycopg.OperationalError(
            "postgresql://private:secret@db/private SELECT private"
        )

    executive[1].dependency_overrides[get_store] = broken
    response = executive[0].get("/api/rankings", params=PARAMS)
    assert response.status_code == 503
    assert "secret" not in response.text and "SELECT" not in response.text


def test_unbound_store_and_audit_fail_closed(executive):
    client, application, _, audit = executive
    del application.dependency_overrides[get_store]
    assert client.get("/api/me").status_code == 503
    assert client.get("/api/semesters").status_code == 503
    assert client.get("/api/rankings", params=PARAMS).status_code == 503
    assert not audit.events
    del application.dependency_overrides[get_audit]
    assert client.get("/api/rankings", params=PARAMS).status_code == 503


def test_audit_failure_blocks_response(executive):
    class BrokenAudit:
        def record_read(self, *args):
            raise ReadUnavailable()

    executive[1].dependency_overrides[get_audit] = BrokenAudit
    assert executive[0].get("/api/rankings", params=PARAMS).status_code == 503


def test_staleness_boundary(executive):
    now = datetime.now(timezone.utc)
    run = executive[2].publications[0]
    run.as_of = now - timedelta(days=8)
    assert metadata(run, now)["stale"] is False
    run.as_of -= timedelta(microseconds=1)
    assert metadata(run, now)["stale"] is True


def test_missing_data_model_rejects_numeric_score(executive):
    row = executive[2].rows(UUID(int=1))[-2].ranking.model_dump()
    row.update(status="insufficient_data", overall_score=0)
    from app.models import RankingRow

    with pytest.raises(ValidationError):
        RankingRow(**row)


def test_docs_and_openapi(api):
    client = api[0]
    assert client.get("/").json() == {"Hello": "World from Horizon Server"}
    assert client.get("/docs").status_code == 200
    schema = client.get("/openapi.json").json()
    for path in (
        "/api/me",
        "/api/semesters",
        "/api/rankings",
        "/api/rankings/members/{userPk}",
    ):
        assert schema["paths"][path]["get"]["security"] == [{"HTTPBearer": []}]
