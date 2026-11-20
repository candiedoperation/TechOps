"""Load T5.5 input PRs from a JSON file shaped like the T1.1 tables.

This is the temporary stand-in for reading horizon_gt_features.gitea_pull_requests
and gitea_pr_reviews, which T1.1 has not built yet. Each JSON row uses the T1.1
column names, so swapping this for a database query later does not change the
metric code.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

from .metrics_flow import PullRequest, Review

SAMPLE_FIXTURE = Path(__file__).parent / "fixtures" / "flow_metrics_sample.json"


@dataclass(frozen=True)
class ProjectPullRequests:
    """One project's PRs plus the first day of its semester window."""

    project_pk: str
    window_start: date
    pull_requests: list[PullRequest]


@dataclass(frozen=True)
class FlowSource:
    as_of: datetime | None
    projects: list[ProjectPullRequests]


def _aware(text: str | None) -> datetime | None:
    if text is None:
        return None
    moment = datetime.fromisoformat(text)
    if moment.tzinfo is None:
        raise ValueError(f"timestamp {text!r} has no time zone offset")
    return moment


def parse_flow_source(payload: dict) -> FlowSource:
    """Join review rows onto their PR by (organization, repository, number)."""
    projects = []
    for project in payload["projects"]:
        reviews_by_pr: dict[tuple[str, str, int], list[Review]] = {}
        for row in project.get("reviews", []):
            submitted_at = _aware(row["submitted_at"])
            if submitted_at is None:  # pending reviews have no submission time
                continue
            key = (row["organization"], row["repository"], int(row["pr_number"]))
            reviews_by_pr.setdefault(key, []).append(
                Review(row["reviewer_login"], row["state"], submitted_at)
            )
        pull_requests = []
        for row in project.get("pull_requests", []):
            key = (row["organization"], row["repository"], int(row["number"]))
            pull_requests.append(
                PullRequest(
                    number=int(row["number"]),
                    author_login=row["author_login"],
                    created_at=_aware(row["created_at"]),
                    merged_at=_aware(row.get("merged_at")),
                    closed_at=_aware(row.get("closed_at")),
                    reviews=tuple(reviews_by_pr.get(key, ())),
                )
            )
        projects.append(
            ProjectPullRequests(
                project_pk=project["project_pk"],
                window_start=date.fromisoformat(project["window_start"]),
                pull_requests=pull_requests,
            )
        )
    return FlowSource(as_of=_aware(payload.get("as_of")), projects=projects)


def load_flow_source(path: Path | str = SAMPLE_FIXTURE) -> FlowSource:
    return parse_flow_source(json.loads(Path(path).read_text(encoding="utf-8")))
