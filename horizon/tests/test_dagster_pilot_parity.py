import pytest

pytest.importorskip("dagster")
from dagster_pilot.parity_server import _projects, _snapshot
from dagster_pilot.runner import run_partition


def test_compatibility_shapes_preserve_production_snapshot_contract():
    data = run_partition("2026-spring")
    snapshot = _snapshot(data)
    assert {"snapshot_id", "projects", "snapshot_week_start", "rule_set_version"} <= snapshot.keys()
    assert {"project_id", "status", "metrics", "evidence", "data_completeness_pct"} <= _projects(data)[0].keys()
    assert [p["status"] for p in snapshot["projects"]] == ["watch", "watch", "insufficient_data"]


def test_compatibility_projects_retain_provenance_relevant_evidence():
    projects = _projects(run_partition("2026-spring"))
    assert projects[0]["evidence"][0]["source_refs"][0]["source_type"] == "gitea"
    assert projects[1]["data_completeness_pct"] == 40
