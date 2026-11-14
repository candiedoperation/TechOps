"""Exercise the actual SQL against a disposable, loopback-only PostgreSQL cluster."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import os
import shutil
import subprocess
from uuid import UUID

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from app.config import Settings
from app.main import create_app
from app.projects import publication_meta, Selection


FIRST = UUID(int=1)
CURRENT = UUID(int=2)
SPRING = UUID(int=3)
AS_OF = datetime(2026, 10, 7, tzinfo=timezone.utc)
SEASON = "?season=FALL-2026"
PROJECTS = "/api/v1/projects"
TIMELINE = f"{PROJECTS}/project-a/sow-timeline"
DOCUMENT = {
    "sow": {"title": "Fixture scope"},
    "progress": {"percentComplete": 50, "done": 1, "total": 2, "overdue": 1},
    "tasks": [
        {"taskKey": "A", "title": "First", "override": {"status": "done"}},
        {"taskKey": "B", "title": "Second"},
    ],
}


@pytest.fixture(scope="module")
def postgres(tmp_path_factory):
    initdb = shutil.which("initdb")
    pg_ctl = shutil.which("pg_ctl")
    if not (initdb and pg_ctl) or (hasattr(os, "geteuid") and os.geteuid() == 0):
        pytest.skip(
            "Project publication SQL tests need initdb and pg_ctl on a non-root PATH."
        )
    root = tmp_path_factory.mktemp("horizon-pg")
    # macOS has a short Unix socket path limit. Use a self-contained cluster and
    # psycopg's free-port probe alternative: bind TCP only on a private loopback port.
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    cluster = root / "data"
    subprocess.run(
        [
            initdb,
            "-D",
            cluster,
            "-U",
            "fixture_admin",
            "-A",
            "trust",
            "--no-locale",
            "-E",
            "UTF8",
        ],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            pg_ctl,
            "-D",
            cluster,
            "-l",
            root / "postgres.log",
            "-o",
            f"-h 127.0.0.1 -p {port} -c unix_socket_directories='' -F",
            "-w",
            "start",
        ],
        check=True,
        capture_output=True,
    )
    url = f"postgresql://fixture_admin@127.0.0.1:{port}/postgres"
    try:
        yield url
    finally:
        subprocess.run([pg_ctl, "-D", cluster, "-m", "fast", "-w", "stop"], check=True)


@pytest.fixture(scope="module")
def project_rows(postgres):
    with psycopg.connect(postgres) as connection:
        connection.execute("CREATE ROLE horizon_projects_fixture_reader LOGIN")
        connection.execute(
            (Path(__file__).parent / "fixtures/project_publications.sql").read_text()
        )
        connection.execute(
            """
            INSERT INTO horizon_api.publications VALUES
                ('projects', 'FALL', 2026, %s, %s), ('projects', 'SPRING', 2026, %s, %s),
                ('rankings', 'FALL', 2026, %s, %s)
            """,
            (CURRENT, AS_OF, SPRING, AS_OF, FIRST, AS_OF),
        )
        for run, as_of, season, key, name, progress in (
            (FIRST, AS_OF - timedelta(days=7), "FALL", "project-a", "Albatross", 25),
            (CURRENT, AS_OF, "FALL", "project-z", "Zebra", 0),
            (CURRENT, AS_OF, "FALL", "project-a", "Albatross", 50),
            (SPRING, AS_OF, "SPRING", "project-a", "Albatross", 100),
        ):
            connection.execute(
                """
                INSERT INTO horizon_api.project_summaries VALUES (
                  %s, %s, %s, 2026, %s, %s, '2026-08-01', '2026-12-01', true,
                  2, 2, 1, 0, 1, %s, '{"overdue": 1}', ARRAY['private-member'], ARRAY['private-lead']
                )
                """,
                (run, as_of, season, key, name, progress),
            )
        connection.execute(
            "INSERT INTO horizon_api.project_detail VALUES (%s, 'project-a', %s)",
            (CURRENT, Jsonb({"metrics": [], "findings": []})),
        )
        connection.execute(
            "INSERT INTO horizon_api.project_sow_timeline VALUES (%s, 'project-a', %s)",
            (CURRENT, Jsonb(DOCUMENT)),
        )
        connection.execute(
            "INSERT INTO horizon_api.project_sow_timeline VALUES (%s, 'project-z', %s)",
            (CURRENT, Jsonb({"sow": None, "progress": None, "tasks": []})),
        )
        with connection.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO horizon_projects.sow_task_overrides
                    (project_pk, task_key, status, reason, set_at)
                VALUES (%s, %s, %s, %s, %s)
                """,
                [
                    ("project-a", "A", "done", "At publication", AS_OF),
                    ("project-a", "B", "done", "Earlier", AS_OF + timedelta(hours=1)),
                    (
                        "project-a",
                        "B",
                        "done",
                        "Tied earlier row",
                        AS_OF + timedelta(hours=2),
                    ),
                    (
                        "project-a",
                        "B",
                        "in_progress",
                        "Latest correction",
                        AS_OF + timedelta(hours=2),
                    ),
                    (
                        "project-z",
                        "A",
                        "done",
                        "Different project",
                        AS_OF + timedelta(days=1),
                    ),
                    (
                        "project-a",
                        "deleted-task",
                        "done",
                        "Different task",
                        AS_OF + timedelta(days=1),
                    ),
                ],
            )


@pytest.fixture
def projects_api(postgres, project_rows):
    read_url = postgres.replace("fixture_admin", "horizon_projects_fixture_reader")
    with TestClient(create_app(Settings(database_url=read_url))) as client:
        yield client


def test_public_project_reads_and_run_selection(projects_api):
    response = projects_api.get(PROJECTS + SEASON)
    assert response.status_code == 200
    payload = response.json()
    assert payload["meta"]["runId"] == str(CURRENT)
    assert [item["friendlyName"] for item in payload["data"]] == ["Albatross", "Zebra"]
    assert set(payload["data"][0]) == {
        "projectPk",
        "friendlyName",
        "windowStart",
        "windowEnd",
        "hasSow",
        "tasksTotal",
        "tasksDue",
        "tasksDone",
        "tasksPartial",
        "tasksOverdue",
        "percentComplete",
        "riskCounts",
    }
    historical = projects_api.get(f"{PROJECTS}{SEASON}&run={FIRST}")
    assert historical.json()["data"][0]["percentComplete"] == 25
    assert projects_api.get(f"{PROJECTS}{SEASON}&run={SPRING}").status_code == 404
    assert projects_api.get(f"{PROJECTS}{SEASON}&run=bad").status_code == 422
    detail = projects_api.get(f"{PROJECTS}/project-a{SEASON}").json()["data"]
    assert detail == {
        "summary": payload["data"][0],
        "detail": {"metrics": [], "findings": []},
    }
    history = projects_api.get(f"{PROJECTS}/project-a/history{SEASON}")
    assert [row["percentComplete"] for row in history.json()] == [25, 50]


@pytest.mark.parametrize("suffix", ["", "/sow-timeline", "/history"])
def test_unknown_project(projects_api, suffix):
    assert projects_api.get(f"{PROJECTS}/unknown{suffix}{SEASON}").status_code == 404


def test_timeline_overrides_and_revalidation(projects_api, postgres):
    response = projects_api.get(TIMELINE + SEASON)
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["progress"] == DOCUMENT["progress"]
    assert data["tasks"][0]["override"] == {"status": "done"}
    assert data["tasks"][0]["pendingOverride"] is None
    assert data["tasks"][1]["pendingOverride"] == {
        "status": "in_progress",
        "reason": "Latest correction",
        "setAt": (AS_OF + timedelta(hours=2)).isoformat(),
    }
    etag = response.headers["etag"]
    conditional = projects_api.get(
        TIMELINE + SEASON, headers={"If-None-Match": f'"other", W/{etag}'}
    )
    assert conditional.status_code == 304
    assert conditional.content == b""
    assert conditional.headers["etag"] == etag
    assert conditional.headers["cache-control"] == "public, no-cache"
    with psycopg.connect(postgres) as connection:
        connection.execute(
            """
            INSERT INTO horizon_projects.sow_task_overrides
                (project_pk, task_key, status, reason, set_at)
            VALUES ('project-a', 'B', 'done', 'New correction', %s)
            """,
            (AS_OF + timedelta(days=1),),
        )
    updated = projects_api.get(TIMELINE + SEASON, headers={"If-None-Match": etag})
    assert updated.status_code == 200
    assert updated.headers["etag"] != etag
    assert (
        updated.json()["data"]["tasks"][1]["pendingOverride"]["reason"]
        == "New correction"
    )


def test_empty_timeline(projects_api):
    response = projects_api.get(f"{PROJECTS}/project-z/sow-timeline{SEASON}")
    assert response.json()["data"] == {"sow": None, "progress": None, "tasks": []}


def test_publication_age_boundary(postgres, project_rows):
    from psycopg.rows import dict_row

    with psycopg.connect(postgres, row_factory=dict_row) as connection:
        assert not publication_meta(
            connection, Selection("FALL-2026"), AS_OF + timedelta(days=8)
        ).stale
        assert publication_meta(
            connection, Selection("FALL-2026"), AS_OF + timedelta(days=9)
        ).stale


def test_pointer_refresh_and_document_revalidation(projects_api, postgres, monkeypatch):
    from app import cache as cache_module
    from app.projects import Publication

    clock = [100]
    monkeypatch.setattr(cache_module, "monotonic", lambda: clock[0])
    first = projects_api.get(PROJECTS + SEASON)
    assert (
        first.headers["cache-control"]
        == "public, max-age=30, stale-while-revalidate=300"
    )
    assert first.json()["meta"]["runId"] == str(CURRENT)

    def no_serialization(*args, **kwargs):
        pytest.fail("304 should not serialize the publication")

    with monkeypatch.context() as patch:
        patch.setattr(Publication, "model_dump", no_serialization)
        response = projects_api.get(
            PROJECTS + SEASON, headers={"If-None-Match": first.headers["etag"]}
        )
        assert response.status_code == 304

    with psycopg.connect(postgres) as connection:
        connection.execute(
            "UPDATE horizon_api.publications SET run_id = %s, as_of = %s "
            "WHERE domain = 'projects' AND season_type = 'FALL'",
            (FIRST, AS_OF - timedelta(days=7)),
        )
    try:
        assert projects_api.get(PROJECTS + SEASON).json()["meta"]["runId"] == str(
            CURRENT
        )
        clock[0] += 46
        refreshed = projects_api.get(PROJECTS + SEASON)
        assert refreshed.json()["meta"]["runId"] == str(FIRST)
        assert refreshed.headers["etag"] != first.headers["etag"]
        explicit = projects_api.get(f"{PROJECTS}{SEASON}&run={FIRST}")
        assert (
            explicit.headers["cache-control"] == "public, max-age=31536000, immutable"
        )
    finally:
        with psycopg.connect(postgres) as connection:
            connection.execute(
                "UPDATE horizon_api.publications SET run_id = %s, as_of = %s "
                "WHERE domain = 'projects' AND season_type = 'FALL'",
                (CURRENT, AS_OF),
            )
