"""Which feature-pipeline run a ranking run reads for each project repository."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

# A weekly ranking run expects every repository to have been captured within
# the last week, with a day of slack for a late or retried capture.
FRESHNESS_WINDOW = timedelta(days=8)


@dataclass(frozen=True)
class CompleteRun:
    """The latest complete ``pipeline_runs`` row for one repository."""

    run_id: str
    completed_at: datetime


@dataclass(frozen=True)
class SourceFreshness:
    source_runs: dict[str, str]
    stale: tuple[str, ...]

    @property
    def is_fresh(self) -> bool:
        return not self.stale


def repository_slug(organization: str, repository: str) -> str:
    return f"{organization}/{repository}"


def check_source_freshness(
    project_repositories: Sequence[tuple[str, str]],
    latest_complete_runs: Mapping[tuple[str, str], CompleteRun],
    as_of: datetime,
) -> SourceFreshness:
    """Pick each repository's run and list the ones with nothing recent enough.

    ``source_runs`` records the latest complete run at or before ``as_of`` even
    when it is stale, so a failed ranking run still shows what it found. A run
    completed after ``as_of`` is never used.
    """

    if as_of.tzinfo is None:
        raise ValueError("as_of must be timezone-aware")
    oldest_allowed = as_of - FRESHNESS_WINDOW
    source_runs: dict[str, str] = {}
    stale: list[str] = []
    for organization, repository in sorted(set(project_repositories)):
        slug = repository_slug(organization, repository)
        run = latest_complete_runs.get((organization, repository))
        if run is None or run.completed_at > as_of:
            stale.append(slug)
            continue
        source_runs[slug] = run.run_id
        if run.completed_at < oldest_allowed:
            stale.append(slug)
    return SourceFreshness(source_runs=source_runs, stale=tuple(stale))
