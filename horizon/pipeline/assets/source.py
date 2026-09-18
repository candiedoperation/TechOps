"""L1 source: what the pipeline is about to blame.

One API call. No git, no disk, no Postgres -- so when a run fails here, the
cause is Gitea or the token, and nothing else.

The repository is chosen by config for now. PR 15 replaces that with a dynamic
partition per repository, at which point this asset reads its target from the
partition key instead; nothing else about it changes.
"""

# No `from __future__ import annotations` in this module: Dagster resolves the
# context and asset-input annotations at decoration time, and PEP 563 turns them
# into strings it then refuses.
from dagster import AssetExecutionContext, Config, MetadataValue, asset

from ..metadata import table_schema_from
from ..resources import GiteaClient, Repository

REPOSITORY_SCHEMA = table_schema_from(
    Repository,
    {
        "org": ("string", "Gitea organization, as Gitea spells it."),
        "name": ("string", "Repository name, as Gitea spells it."),
        "ssh_url": ("string", "Clone URL blame runs against; git-over-HTTP is disabled here."),
        "default_branch": ("string", "Branch blamed -- the only branch blame can see."),
        "empty": ("bool", "Gitea reports no commits, so there is nothing to blame."),
    },
)


class RepositoryConfig(Config):
    """Which repository this run is about.

    Neither field has a default: a blame run against a repository nobody named
    is a mistake, and an accidental default would hide it.
    """

    org: str
    repo: str


@asset(
    group_name="l1_source",
    kinds={"gitea"},
    description=(
        "Clone URL and default branch for one repository. Exactly one Gitea API "
        "call -- no commit list, no branch list, which is what makes blame O(1) "
        "calls per repository."
    ),
    metadata={
        "dagster/column_schema": REPOSITORY_SCHEMA,
        "endpoint": "GET /api/v1/repos/{org}/{repo}",
        "api_calls": 1,
    },
)
def gitea_repository(
    context: AssetExecutionContext,
    config: RepositoryConfig,
    gitea: GiteaClient,
) -> Repository:
    repository = gitea.get_repository(config.org, config.repo)

    context.add_output_metadata(
        {
            "repository": MetadataValue.text(repository.slug),
            "default_branch": MetadataValue.text(repository.default_branch),
            "ssh_url": MetadataValue.text(repository.ssh_url),
            "empty": MetadataValue.bool(repository.empty),
        }
    )
    return repository
