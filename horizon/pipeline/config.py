"""Settings for the pipeline.

Scoped to exactly the three values a blame run reads, rather than a shared
settings object that accumulates every service's configuration.

The dotenv path is resolved once at import from ``HORIZON_ENV_FILE``, so
``tests/conftest.py`` clearing it keeps a developer's real Gitea URL and tokens
out of every test run.
"""

from __future__ import annotations

import os
from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = os.environ.get("HORIZON_ENV_FILE", ".env") or None


class PipelineConfigError(RuntimeError):
    """A required setting is missing or blank.

    Raised at the point of use rather than at import, so ``dagster dev`` still
    boots and shows the asset graph on a machine that has no database URL.
    """


class PipelineSettings(BaseSettings):
    """Environment-backed pipeline settings.

    Every field is optional so that loading ``Definitions`` never fails on a
    half-configured machine. Reach for the ``require_*`` accessors when a value
    is genuinely needed; they fail loudly and name the variable to set.
    """

    model_config = SettingsConfigDict(
        env_prefix="",
        case_sensitive=False,
        populate_by_name=True,
        extra="ignore",
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
    )

    # Two names each, not three: the HORIZON_ name is canonical, and the PHI_ name
    # is what existing horizon/.env files already set. A bare GITEA_URL was dropped
    # in review -- a name that generic invites a collision with any other tool.
    gitea_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("HORIZON_GITEA_URL", "PHI_GITEA_URL"),
        description="Base URL of the Gitea instance, e.g. https://git.example.com.",
    )
    gitea_api_token: str | None = Field(
        default=None,
        repr=False,
        validation_alias=AliasChoices("HORIZON_GITEA_API_TOKEN", "PHI_GITEA_API_TOKEN"),
        description="Read-only Gitea API token.",
    )
    database_url: str | None = Field(
        default=None,
        repr=False,
        validation_alias=AliasChoices("HORIZON_DATABASE_URL", "DATABASE_URL"),
        description="libpq URL for the Postgres holding the horizon schema.",
    )
    sqlite_path: str = Field(
        default="data/horizon.sqlite3",
        validation_alias=AliasChoices("HORIZON_SQLITE_PATH"),
        description="Interim SQLite path for ownership analytics.",
    )

    def require_gitea_url(self) -> str:
        return _required(self.gitea_url, "HORIZON_GITEA_URL")

    def require_gitea_api_token(self) -> str:
        return _required(self.gitea_api_token, "HORIZON_GITEA_API_TOKEN")

    def require_database_url(self) -> str:
        return _required(self.database_url, "HORIZON_DATABASE_URL")


def _required(value: str | None, variable: str) -> str:
    resolved = (value or "").strip()
    if not resolved:
        raise PipelineConfigError(
            f"{variable} is not set. Export it, or add it to horizon/.env, "
            "before running the pipeline."
        )
    return resolved


@lru_cache(maxsize=1)
def get_pipeline_settings() -> PipelineSettings:
    """Return the process pipeline-settings singleton."""

    return PipelineSettings()
