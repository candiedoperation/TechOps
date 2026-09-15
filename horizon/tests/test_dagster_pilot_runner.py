import pytest

pytest.importorskip("dagster")
from dagster_pilot.runner import run_partition


def test_runner_returns_ui_view_model_for_both_semesters():
    for semester in ("2025-fall", "2026-spring"):
        result = run_partition(semester)
        assert result["success"] is True
        assert result["semester"] == semester
        assert len(result["materialized_assets"]) == 13
        assert result["ranking"]["ranked"]
        assert result["synthetic_warning"]


def test_runner_rejects_unknown_partition():
    with pytest.raises(ValueError, match="semester"):
        run_partition("winter")
