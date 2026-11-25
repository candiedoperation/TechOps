"""Project roster and Gitea pull request sources (T1.1).

Four assets form one contract: peopleportal_projects -> project_repositories ->
gitea_pull_requests -> persist_project_sources. They are season-wide (every
project of the semester), unlike the per-repository blame assets.
"""

# No `from __future__ import annotations`: Dagster resolves asset annotations
# at decoration time.
from collections.abc import Iterator, Sequence
from dataclasses import replace
from datetime import datetime, timezone
from typing import Optional

from dagster import (
    AssetExecutionContext,
    Config,
    Failure,
    MetadataValue,
    RunRequest,
    asset,
)

from ..config import get_pipeline_settings
from ..identity import resolve_gitea_login
from ..project_sources import (
    ProjectRepositoryRow,
    ProjectSources,
    PullRequestSources,
)
from ..resources import GiteaClient, PeoplePortalClient
from ..storage import PostgresResource


class ProjectSourcesConfig(Config):
    """Semester to ingest; defaults to HORIZON_SEASON_TYPE / HORIZON_SEASON_YEAR."""

    season_type: Optional[str] = None
    season_year: Optional[int] = None


def _season(config: ProjectSourcesConfig) -> tuple[str, int]:
    settings = get_pipeline_settings()
    season_type = (config.season_type or settings.season_type or "").strip().upper()
    season_year = config.season_year or settings.season_year
    if season_type not in ("FALL", "SPRING") or not season_year:
        raise Failure(
            description=(
                "Set the semester: season_type FALL or SPRING and season_year, in the "
                "run config or as HORIZON_SEASON_TYPE / HORIZON_SEASON_YEAR."
            )
        )
    return season_type, int(season_year)


@asset(
    group_name="01_sources",
    kinds={"peopleportal", "python"},
    owners=["yash.ponnaganti@gmail.com"],
    tags={"spec": "T1.1"},
    description=(
        "T1.1: every semester project and its members with roles from People "
        "Portal's T3.1 API; malformed projects or members fail the source run."
    ),
    metadata={"endpoint": "GET /api/horizon/projects", "tables": "projects, project_members"},
)
def peopleportal_projects(
    context: AssetExecutionContext,
    config: ProjectSourcesConfig,
    peopleportal: PeoplePortalClient,
) -> ProjectSources:
    season_type, season_year = _season(config)
    sources = peopleportal.get_projects(season_type, season_year)
    context.add_output_metadata(
        {
            "season": MetadataValue.text(f"{season_type} {season_year}"),
            "dagster_run_id": MetadataValue.text(context.run_id),
            "projects": MetadataValue.int(len(sources.projects)),
            "archived_projects": MetadataValue.int(sum(p.archived for p in sources.projects)),
            "members": MetadataValue.int(len(sources.members)),
            "role_mapping_version": MetadataValue.text(sources.role_mapping_version),
        }
    )
    return sources


@asset(
    group_name="01_sources",
    kinds={"gitea", "python"},
    owners=["yash.ponnaganti@gmail.com"],
    tags={"spec": "T1.1"},
    description=(
        "T1.1: repositories of each non-archived project's Gitea organization; "
        "archived and empty repositories are skipped."
    ),
    metadata={"endpoint": "GET /api/v1/orgs/{org}/repos", "table": "project_repositories"},
)
def project_repositories(
    context: AssetExecutionContext,
    peopleportal_projects: ProjectSources,
    gitea: GiteaClient,
) -> list[ProjectRepositoryRow]:
    rows: list[ProjectRepositoryRow] = []
    listed: dict[str, int] = {}
    for project in peopleportal_projects.projects:
        if project.archived:
            continue
        repositories = gitea.list_org_repositories(project.gitea_org)
        listed[project.gitea_org] = len(repositories)
        for repo in repositories:
            if repo.archived or repo.empty or not repo.default_branch:
                continue
            rows.append(
                ProjectRepositoryRow(
                    project_pk=project.project_pk,
                    organization=repo.org,
                    repository=repo.name,
                    default_branch=repo.default_branch,
                )
            )
    context.add_output_metadata(
        {
            "repositories": MetadataValue.int(len(rows)),
            "dagster_run_id": MetadataValue.text(context.run_id),
            "listed_per_org": MetadataValue.json(listed),
        }
    )
    return rows


@asset(
    group_name="01_sources",
    kinds={"gitea", "python"},
    owners=["yash.ponnaganti@gmail.com"],
    tags={"spec": "T1.1"},
    description=(
        "T1.1: every pull request, review and review request in the project "
        "repositories. Logins resolve to Authentik pks only through "
        "identity.resolve_gitea_login; unresolved logins stay NULL."
    ),
    metadata={
        "endpoints": "pulls?state=all, pulls/{n}/reviews, issues/{n}/timeline",
        "tables": "gitea_pull_requests, gitea_pr_reviews, gitea_pr_review_requests",
    },
)
def gitea_pull_requests(
    context: AssetExecutionContext,
    peopleportal_projects: ProjectSources,
    project_repositories: list[ProjectRepositoryRow],
    gitea: GiteaClient,
) -> PullRequestSources:
    roster = peopleportal_projects.members
    pulls, reviews, requests, totals = [], [], [], {}
    for repo in project_repositories:
        fetched = gitea.get_repository_pull_requests(repo.organization, repo.repository)
        totals[f"{repo.organization}/{repo.repository}"] = (
            fetched.pull_request_total,
            len(fetched.pull_requests),
        )
        pulls += [
            replace(row, author_pk=resolve_gitea_login(row.author_login, roster))
            for row in fetched.pull_requests
        ]
        reviews += [
            replace(row, reviewer_pk=resolve_gitea_login(row.reviewer_login, roster))
            for row in fetched.reviews
        ]
        requests += [
            replace(row, requested_pk=resolve_gitea_login(row.requested_login, roster))
            for row in fetched.review_requests
        ]
    unresolved = sorted(
        {p.author_login for p in pulls if p.author_pk is None}
        | {r.reviewer_login for r in reviews if r.reviewer_pk is None}
        | {r.requested_login for r in requests if r.requested_pk is None}
    )
    context.add_output_metadata(
        {
            "pull_requests": MetadataValue.int(len(pulls)),
            "reviews": MetadataValue.int(len(reviews)),
            "review_requests": MetadataValue.int(len(requests)),
            "unresolved_logins": MetadataValue.int(len(unresolved)),
            "dagster_run_id": MetadataValue.text(context.run_id),
        }
    )
    return PullRequestSources(
        pull_requests=pulls,
        reviews=reviews,
        review_requests=requests,
        pull_request_totals=totals,
        retrieved_at=datetime.now(timezone.utc),
    )


@asset(
    group_name="07_database",
    kinds={"postgres", "python"},
    owners=["yash.ponnaganti@gmail.com"],
    tags={"spec": "T1.1"},
    description=(
        "T1.1: upserts all six latest-state project and PR source tables atomically."
    ),
    metadata={"schema": "horizon_gt_features"},
)
def persist_project_sources(
    context: AssetExecutionContext,
    feature_store_schema: str,
    peopleportal_projects: ProjectSources,
    project_repositories: list[ProjectRepositoryRow],
    gitea_pull_requests: PullRequestSources,
    postgres: PostgresResource,
) -> dict[str, int]:
    counts = postgres.write_project_sources(
        peopleportal_projects, project_repositories, gitea_pull_requests,
        dagster_run_id=context.run_id,
    )
    context.add_output_metadata({
        **{name: MetadataValue.int(n) for name, n in counts.items()},
        "dagster_run_id": MetadataValue.text(context.run_id),
        "run_status": MetadataValue.text("complete"),
    })
    return counts


def blame_run_requests(
    repositories: Sequence[tuple[str, str]],
    job_name: str = "blame_ownership",
) -> Iterator[RunRequest]:
    """One RunRequest per project repository for the blame/ownership job, keyed org/repo.

    T7.3 feeds this from PostgresResource.read_project_repositories(season) to
    schedule a full-club run.
    """

    for organization, repository in repositories:
        slug = f"{organization}/{repository}"
        yield RunRequest(
            run_key=slug,
            job_name=job_name,
            run_config={
                "ops": {"gitea_repository": {"config": {"org": organization, "repo": repository}}}
            },
            tags={"horizon/repository": slug},
        )
