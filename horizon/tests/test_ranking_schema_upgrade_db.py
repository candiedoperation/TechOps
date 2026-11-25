import os
from pathlib import Path

import psycopg
import psycopg.conninfo
import pytest

# A Postgres server the test may create a database on, for example
# postgresql://postgres@127.0.0.1:5432/postgres. Skipped when unset.
ADMIN_URL = os.environ.get("TEST_POSTGRES_URL")
SCHEMA = Path(__file__).parents[1] / "pipeline" / "schema.sql"
pytestmark = pytest.mark.skipif(not ADMIN_URL, reason="TEST_POSTGRES_URL is not set")

# horizon_ranking.ranked_members as it was created before project review
# settings existed (and as it is on the deployed database).
OLD_RANKED_MEMBERS = """
CREATE SCHEMA horizon_ranking;
CREATE TABLE horizon_ranking.ranked_members (
    ranking_run_id UUID, authentik_user_pk TEXT, project_pk TEXT,
    role TEXT NOT NULL, display_name TEXT NOT NULL, role_title TEXT, project_name TEXT NOT NULL,
    comparison_group TEXT NOT NULL, tenure_semesters INT NOT NULL,
    window_start DATE NOT NULL, window_end DATE NOT NULL,
    PRIMARY KEY (ranking_run_id, authentik_user_pk, project_pk));
"""


@pytest.fixture
def empty_database():
    name = "hz_upgrade_test"
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
        admin.execute(f"CREATE DATABASE {name}")
    yield psycopg.conninfo.make_conninfo(ADMIN_URL, dbname=name)
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


def test_schema_adds_excluded_buckets_to_an_existing_ranked_members(empty_database):
    with psycopg.connect(empty_database) as connection:
        connection.execute(OLD_RANKED_MEMBERS)
    with psycopg.connect(empty_database) as connection:
        connection.execute(SCHEMA.read_text())
        connection.execute(SCHEMA.read_text())  # and again: still idempotent
        column = connection.execute(
            """SELECT data_type, is_nullable, column_default FROM information_schema.columns
               WHERE table_schema = 'horizon_ranking' AND table_name = 'ranked_members'
                 AND column_name = 'excluded_buckets'"""
        ).fetchone()
    assert column == ("ARRAY", "NO", "'{}'::text[]")
