"""Read-only pool infrastructure; no guessed ranking tables or automatic migrations."""

from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout

from .errors import ReadUnavailable


class ReadDatabase:
    def __init__(self, database_url: str):
        self.pool = ConnectionPool(
            database_url,
            open=False,
            min_size=0,
            max_size=5,
            max_waiting=20,
            timeout=5,
            reconnect_timeout=10,
            kwargs={
                "connect_timeout": 5,
                "application_name": "horizon-read-api",
                "row_factory": dict_row,
            },
        )

    def open(self):
        self.pool.open(wait=False)

    def close(self):
        self.pool.close()

    @contextmanager
    def snapshot(self):
        try:
            with self.pool.connection() as connection:
                with connection.transaction():
                    connection.execute(
                        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                    )
                    connection.execute(
                        "SELECT set_config('statement_timeout', %s, true)", ("5000",)
                    )
                    yield connection
        except (psycopg.Error, PoolTimeout):
            raise ReadUnavailable() from None

    def inspect_schemas(self):
        """Explicit diagnostic only, not a ranking adapter or an HTTP data endpoint."""
        with self.snapshot() as connection:
            return connection.execute(
                "SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY(%s) ORDER BY schema_name",
                (["horizon_gt_features", "horizon_ranking"],),
            ).fetchall()
