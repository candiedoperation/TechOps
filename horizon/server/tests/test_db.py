import os
from contextlib import contextmanager
from unittest.mock import Mock
from urllib.parse import urlsplit

import psycopg
import pytest

from app.db import ReadDatabase
from app.errors import ReadUnavailable


def test_read_only_parameterized_pool_boundary():
    connection = Mock()

    @contextmanager
    def scope():
        yield connection

    database = ReadDatabase("postgresql://fictional.invalid/unused")
    database.pool = Mock()
    database.pool.connection.side_effect = scope
    connection.transaction.side_effect = scope
    database.inspect_schemas()
    calls = connection.execute.call_args_list
    assert calls[0].args == (
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    )
    assert calls[1].args[1] == ("5000",)
    assert calls[2].args[1] == (["horizon_gt_features", "horizon_ranking"],)
    database.close()
    database.pool.close.assert_called_once()


def test_database_failure_hides_details():
    database = ReadDatabase("postgresql://fictional.invalid/unused")
    database.pool = Mock()
    database.pool.connection.side_effect = psycopg.OperationalError("secret-password")
    with pytest.raises(ReadUnavailable) as error:
        with database.snapshot():
            pass
    assert "secret" not in str(error.value)


def test_optional_local_postgres():
    dsn = os.getenv("HORIZON_TEST_DATABASE_URL")
    if not dsn:
        pytest.skip(
            "No explicit local test Postgres DSN; no production database fallback."
        )
    url = urlsplit(dsn)
    assert (
        url.hostname in ("127.0.0.1", "localhost")
        and url.path == "/horizon_debug"
        and url.port == 55432
    )
    database = ReadDatabase(dsn)
    database.open()
    try:
        with database.snapshot() as connection:
            assert (
                connection.execute("SHOW transaction_read_only").fetchone()[
                    "transaction_read_only"
                ]
                == "on"
            )
            assert (
                connection.execute(
                    "SELECT %s::text AS value", ("fictional-only",)
                ).fetchone()["value"]
                == "fictional-only"
            )
    finally:
        database.close()
