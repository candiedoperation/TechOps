"""Opt-in real PostgreSQL integration; requires an isolated test database."""
import json
import os
from pathlib import Path

import pytest

from load_postgres import load_run


@pytest.mark.skipif(not os.getenv('PHI_TEST_DATABASE_URL'), reason='isolated PostgreSQL URL not configured')
def test_real_postgres_schema_nulls_idempotency_and_conflicts(tmp_path):
    import psycopg
    url = os.environ['PHI_TEST_DATABASE_URL']
    payload = {'run_id': 'audit-regression-source', 'generated_at': '2026-09-01T00:00:00Z',
               'members': [{'login': 'synthetic-member', 'commits': None, 'pulls_merged_contributed_to': 4,
                            'additions': 150, 'commit_stats_status': 'partial'}]}
    path = tmp_path / 'analytics.json'; path.write_text(json.dumps(payload))
    schema = Path(__file__).resolve().parents[1] / 'schema.sql'
    first = load_run(tmp_path, url, schema)
    second = load_run(tmp_path, url, schema)
    assert first == second
    with psycopg.connect(url) as connection:
        row = connection.execute('SELECT commits, additions, pulls_merged_contributed_to, observed_values FROM gitea_analytics.member_metrics WHERE run_id = %s', (payload['run_id'],)).fetchone()
    assert row[:3] == (None, None, 4)
    assert row[3]['additions'] == 150
    payload['members'][0]['commits'] = 123
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match='different content'):
        load_run(tmp_path, url, schema)
