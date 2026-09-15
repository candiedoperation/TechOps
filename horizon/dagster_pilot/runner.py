"""Local-only runner and JSON view model for the synthetic Dagster pilot."""
from __future__ import annotations

from typing import Any

from .pilot import defs


def run_partition(semester: str) -> dict[str, Any]:
    if semester not in {"2025-fall", "2026-spring"}:
        raise ValueError("semester must be 2025-fall or 2026-spring")
    result = defs.get_job_def("semester_pilot").execute_in_process(partition_key=semester)
    features = result.output_for_node("deterministic_features")
    ranking = result.output_for_node("member_ranking")
    return {
        "success": result.success,
        "semester": semester,
        "materialized_assets": sorted({e.event_specific_data.materialization.asset_key.to_user_string() for e in result.all_events if e.is_step_materialization}),
        "features": features,
        "ranking": ranking,
        "audit": result.output_for_node("project_audit"),
        "matching": result.output_for_node("tl_pl_sow_matching"),
        "source_status": {name: features["metadata"] for name in ("people_portal", "gitea")},
        "synthetic_warning": "Synthetic pilot data only. This UI does not call People Portal or Gitea and must not be used for personnel decisions.",
    }
