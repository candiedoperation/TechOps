"""Track 5 project-health assets.

T5.5 for now reads FAKE DATA from a JSON fixture (see
pipeline/projects/flow_source.py), because the T1.1 PR tables do not exist yet.
"""

from dataclasses import dataclass
from datetime import date, datetime, timezone

from dagster import AssetExecutionContext, Config, MetadataValue, asset

from ..projects.flow_source import SAMPLE_FIXTURE, load_flow_source
from ..projects.metrics_flow import FlowMetric, project_flow_metrics as compute_flow_metrics


@dataclass(frozen=True)
class ProjectMetricRow:
    """One horizon_projects.project_metrics row, minus run_id (added on write)."""

    project_pk: str
    week_start: date
    metric_key: str
    value: float | None
    missing_reason: str | None
    evidence: dict


class FlowMetricsConfig(Config):
    """Where the PRs come from until T1.1 lands, and the run's as_of time."""

    source_path: str = str(SAMPLE_FIXTURE)
    as_of: str | None = None  # ISO time; defaults to the fixture's as_of, then now


def _row(project_pk: str, metric: FlowMetric) -> ProjectMetricRow:
    return ProjectMetricRow(
        project_pk=project_pk,
        week_start=metric.week_start,
        metric_key=metric.metric_key,
        value=metric.value,
        missing_reason=metric.missing_reason,
        evidence=metric.evidence,
    )


@asset(
    group_name="08_project_metrics",
    description=(
        "T5.5 weekly engineering-flow metrics per project: PRs opened and merged, "
        "open PRs and their age, time to first review, time to merge. Reads a "
        "JSON fixture until the T1.1 PR tables exist."
    ),
)
def project_flow_metrics(
    context: AssetExecutionContext, config: FlowMetricsConfig
) -> list[ProjectMetricRow]:
    source = load_flow_source(config.source_path)
    if config.as_of:
        as_of = datetime.fromisoformat(config.as_of)
    else:
        as_of = source.as_of or datetime.now(timezone.utc)
    rows = [
        _row(project.project_pk, metric)
        for project in source.projects
        for metric in compute_flow_metrics(project.pull_requests, project.window_start, as_of)
    ]
    context.add_output_metadata(
        {
            "source": MetadataValue.path(config.source_path),
            "as_of": MetadataValue.text(as_of.isoformat()),
            "projects": MetadataValue.int(len(source.projects)),
            "rows": MetadataValue.int(len(rows)),
        }
    )
    return rows
