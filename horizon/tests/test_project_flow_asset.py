"""T5.5 wiring: the fake-data loader, the Dagster asset and the Postgres writer."""

from contextlib import contextmanager
from datetime import date

import pytest
from dagster import build_asset_context

from pipeline.assets.projects import FlowMetricsConfig, ProjectMetricRow, project_flow_metrics
from pipeline.projects.flow_source import load_flow_source, parse_flow_source
from pipeline.projects.metrics_flow import FLOW_METRIC_KEYS
from pipeline.storage import PostgresResource


def test_sample_fixture_joins_reviews_to_their_pr():
    source = load_flow_source()
    project = source.projects[0]
    prs = {pr.number: pr for pr in project.pull_requests}

    assert project.project_pk == "demo-project"
    assert project.window_start == date(2026, 10, 19)
    assert len(prs[28].reviews) == 2
    assert prs[32].reviews == ()


def test_reviews_join_on_repository_as_well_as_number():
    payload = {
        "projects": [
            {
                "project_pk": "p",
                "window_start": "2026-11-02",
                "pull_requests": [
                    {"organization": "o", "repository": "api", "number": 1, "author_login": "a",
                     "created_at": "2026-11-02T09:00:00-05:00", "merged_at": None, "closed_at": None},
                    {"organization": "o", "repository": "web", "number": 1, "author_login": "a",
                     "created_at": "2026-11-02T09:00:00-05:00", "merged_at": None, "closed_at": None},
                ],
                "reviews": [
                    {"organization": "o", "repository": "web", "pr_number": 1, "reviewer_login": "b",
                     "state": "APPROVED", "submitted_at": "2026-11-02T10:00:00-05:00"},
                    {"organization": "o", "repository": "web", "pr_number": 1, "reviewer_login": "b",
                     "state": "PENDING", "submitted_at": None},
                ],
            }
        ]
    }
    api_pr, web_pr = parse_flow_source(payload).projects[0].pull_requests

    assert api_pr.reviews == ()
    assert len(web_pr.reviews) == 1


def test_timestamps_without_offset_are_rejected():
    payload = {"projects": [{"project_pk": "p", "window_start": "2026-11-02", "pull_requests": [
        {"organization": "o", "repository": "r", "number": 1, "author_login": "a",
         "created_at": "2026-11-02T09:00:00", "merged_at": None, "closed_at": None}]}]}

    with pytest.raises(ValueError, match="no time zone"):
        parse_flow_source(payload)


def test_asset_on_sample_fixture_reproduces_the_spec_example():
    rows = project_flow_metrics(build_asset_context(), FlowMetricsConfig())
    spec_week = {r.metric_key: r for r in rows if r.week_start == date(2026, 11, 2)}

    # 3 weeks (Oct 19, Oct 26, Nov 2) x 6 metrics for the one demo project.
    assert len(rows) == 18
    assert spec_week["prs_opened"].value == 3
    assert spec_week["prs_merged"].value == 2
    assert spec_week["median_time_to_merge_hours"].value == pytest.approx(12.5)
    assert spec_week["median_time_to_first_review_hours"].value == pytest.approx(57.99, abs=0.01)
    assert spec_week["median_open_pr_age_days"].value == pytest.approx(4.58, abs=0.01)


class _FakeCursor:
    def __init__(self, log):
        self.log = log

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params):
        self.log.append(("execute", sql, params))

    def executemany(self, sql, values):
        self.log.append(("executemany", sql, list(values)))


class _FakeConnection:
    def __init__(self, log):
        self.log = log

    def cursor(self):
        return _FakeCursor(self.log)


def _store_with_log(monkeypatch):
    log = []
    store = PostgresResource(database_url="postgresql://unused")

    @contextmanager
    def fake_connect(self):
        yield _FakeConnection(log)

    monkeypatch.setattr(PostgresResource, "connect", fake_connect)
    return store, log


def test_writer_replaces_only_this_runs_flow_metrics(monkeypatch):
    store, log = _store_with_log(monkeypatch)
    rows = [ProjectMetricRow("p", date(2026, 11, 2), "prs_opened", 3.0, None, {"partial_week": True})]

    assert store.write_project_metrics("run-1", rows) == 1
    (_, delete_sql, delete_params), (_, insert_sql, values) = log
    assert "DELETE FROM horizon_projects.project_metrics" in delete_sql
    assert delete_params == ("run-1", list(FLOW_METRIC_KEYS))
    assert values[0][:6] == ("run-1", "p", date(2026, 11, 2), "prs_opened", 3.0, None)


def test_writer_rejects_duplicate_rows(monkeypatch):
    store, _ = _store_with_log(monkeypatch)
    row = ProjectMetricRow("p", date(2026, 11, 2), "prs_opened", 3.0, None, {})

    with pytest.raises(ValueError, match="duplicate"):
        store.write_project_metrics("run-1", [row, row])
