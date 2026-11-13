import pytest

from pipeline.config import PipelineConfigError
from pipeline.storage import PostgresResource


def test_postgres_store_requires_runtime_credentials():
    store = PostgresResource()

    with pytest.raises(PipelineConfigError, match="HORIZON_DATABASE_URL"):
        with store.connect():
            pass
