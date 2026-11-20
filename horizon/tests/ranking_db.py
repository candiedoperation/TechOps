"""A throwaway Postgres database seeded with the T4.5 worked example.

Set TEST_POSTGRES_URL to a server URL the tests may create databases on
(for example postgresql://postgres@127.0.0.1:5432/postgres). Without it the
database tests are skipped.
"""

import json
import os
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

import psycopg
import psycopg.conninfo
import pytest

from pipeline.assets.ranking import RankingRun
from pipeline.ranking import store
from pipeline.ranking.members import RankedMember
from pipeline.ranking.metrics_code import MetricValue
from pipeline.ranking.rubric import load_rubric
from pipeline.storage import PostgresResource

ADMIN_URL = os.environ.get("TEST_POSTGRES_URL")
needs_postgres = pytest.mark.skipif(not ADMIN_URL, reason="TEST_POSTGRES_URL is not set")
SCHEMA = Path(__file__).parents[1] / "pipeline" / "schema.sql"
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "ranking_worked_example.json").read_text())
AS_OF = datetime(2026, 11, 8, 23, 59, tzinfo=timezone.utc)


class FakeContext:
    def __init__(self):
        self.metadata = {}

    def add_output_metadata(self, metadata):
        self.metadata.update(metadata)


@pytest.fixture
def ranking_postgres():
    name = f"hz_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f"CREATE DATABASE {name}")
    url = psycopg.conninfo.make_conninfo(ADMIN_URL, dbname=name)
    try:
        with psycopg.connect(url) as connection:
            connection.execute(SCHEMA.read_text())
        yield PostgresResource(database_url=url)
    finally:
        with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
            admin.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


def _member(user_pk):
    return RankedMember(
        authentik_user_pk=user_pk, project_pk="proj-x", role="engineer", display_name=f"Member {user_pk}",
        role_title="Software Engineer", project_name="Project X",
        comparison_group="project:proj-x:engineer", tenure_semesters=FIXTURE["members"][user_pk]["tenure_semesters"],
        window_start=date(2026, 8, 31), window_end=date(2026, 12, 11),
    )


def seed_worked_example(postgres, *, dagster_run_id="dagster-1", as_of=AS_OF, scale=1.0) -> RankingRun:
    """A running ranking run with every engineer metric row of the worked example.

    ``scale`` multiplies code metrics so a second run scores differently.
    """

    loaded = load_rubric("v1")
    role = loaded.rubric.roles["engineer"]
    bucket_of = {metric.key: bucket.key for bucket in role.buckets for metric in bucket.metrics}
    with postgres.connect() as connection:
        store.upsert_rubric(connection, loaded)
        run_id = store.start_ranking_run(
            connection, dagster_run_id=dagster_run_id, season_type="FALL", season_year=2026,
            as_of=as_of, rubric_version="v1", role_mapping_version="fixture",
            project_run_id=None, source_runs={"org/api": "run-1"},
        )
        store.replace_ranked_members(connection, run_id, [_member(pk) for pk in FIXTURE["members"]])
        values = []
        for user_pk, metrics in FIXTURE["members"].items():
            for key, value in metrics.items():
                raw, reason = (value["raw"], value["reason"]) if isinstance(value, dict) else (value, None)
                if raw is not None and bucket_of[key] == "code_ownership":
                    raw *= scale if user_pk == "D" else 1.0
                values.append(MetricValue(user_pk, "proj-x", bucket_of[key], key, raw, reason,
                                          {"per_repository": {"org/api": 1}, "secret_email": "x@example.test"}))
        store.replace_metric_values(connection, run_id, list(bucket_of), values)
    return RankingRun(run_id, "FALL", 2026, as_of, "v1", loaded.sha256)
