"""Application settings for the App Dev Horizon backend."""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Which dotenv file to read, resolved once at import. Defaults to ``.env`` so
# starting the server without a pre-loaded environment can no longer silently
# come up with llm_active False and 503 every compute. Set PHI_ENV_FILE to a
# different path to point elsewhere, or to "" to disable file loading entirely
# -- tests do the latter (see tests/conftest.py) so a developer's real Gitea
# URL and API keys can never leak into a test run.
_ENV_FILE = os.environ.get("PHI_ENV_FILE", ".env") or None


class Settings(BaseSettings):
    """Environment-backed settings.

    ``sqlite_path`` may be a filesystem path or ``:memory:`` for ephemeral
    in-process storage (used in tests and local dev).

    Precedence is pydantic-settings' usual order: explicit constructor
    arguments beat real environment variables, which beat ``_ENV_FILE``,
    which beats the defaults below.
    """

    model_config = SettingsConfigDict(
        env_prefix="",
        case_sensitive=False,
        populate_by_name=True,
        extra="ignore",
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
    )

    app_name: str = "App Dev Horizon"
    environment: str = Field(
        default="local",
        validation_alias=AliasChoices("PHI_ENVIRONMENT", "ENVIRONMENT"),
    )

    sqlite_path: str = Field(
        default="./data/project_health_intelligence.db",
        min_length=1,
        validation_alias=AliasChoices("PHI_SQLITE_PATH", "SQLITE_PATH"),
        description="Filesystem path to the SQLite database, or ':memory:' for ephemeral runs.",
    )
    sqlite_busy_timeout_ms: int = Field(default=5_000, ge=250, le=120_000)

    aggregation_floor: int = Field(
        default=5,
        ge=1,
        validation_alias=AliasChoices(
            "PHI_AGGREGATION_FLOOR",
            "AGGREGATION_FLOOR",
        ),
    )
    rule_set_version: str = Field(
        default="rules-v1",
        min_length=1,
        max_length=80,
        validation_alias=AliasChoices("PHI_RULE_SET_VERSION", "RULE_SET_VERSION"),
    )

    authentik_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("PHI_AUTHENTIK_URL", "AUTHENTIK_URL"),
    )
    authentik_api_token: str | None = Field(
        default=None,
        repr=False,
        validation_alias=AliasChoices(
            "PHI_AUTHENTIK_API_TOKEN",
            "AUTHENTIK_API_TOKEN",
        ),
    )
    people_portal_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("PHI_PEOPLE_PORTAL_URL", "PEOPLE_PORTAL_URL"),
    )
    people_portal_api_token: str | None = Field(
        default=None,
        repr=False,
        validation_alias=AliasChoices(
            "PHI_PEOPLE_PORTAL_API_TOKEN",
            "PEOPLE_PORTAL_API_TOKEN",
        ),
    )
    # LLM enrichment settings (optional; requires pip install '.[llm]')
    llm_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices("PHI_LLM_ENABLED", "LLM_ENABLED"),
    )
    gemini_api_key: str | None = Field(
        default=None,
        repr=False,
        validation_alias=AliasChoices("PHI_GEMINI_API_KEY", "GEMINI_API_KEY"),
    )
    gemini_model: str = Field(
        default="gemini-2.5-flash",
        min_length=1,
        max_length=120,
        validation_alias=AliasChoices("PHI_GEMINI_MODEL", "GEMINI_MODEL"),
    )
    llm_assessment_model: str | None = Field(
        default=None,
        max_length=120,
        validation_alias=AliasChoices("PHI_LLM_ASSESSMENT_MODEL", "LLM_ASSESSMENT_MODEL"),
    )
    llm_decomposition_model: str | None = Field(
        default=None,
        max_length=120,
        validation_alias=AliasChoices("PHI_LLM_DECOMPOSITION_MODEL", "LLM_DECOMPOSITION_MODEL"),
    )
    llm_timeout_seconds: float = Field(
        default=20.0,
        ge=1.0,
        le=120.0,
        validation_alias=AliasChoices("PHI_LLM_TIMEOUT_SECONDS", "LLM_TIMEOUT_SECONDS"),
    )
    # LLM-judged weekly signal (backend.signal_llm) -- separate from the
    # CI-assessment model/timeout above since diff-sized prompts run longer.
    llm_signal_model: str | None = Field(
        default=None,
        max_length=120,
        validation_alias=AliasChoices("PHI_LLM_SIGNAL_MODEL", "LLM_SIGNAL_MODEL"),
    )
    llm_signal_timeout_seconds: float = Field(
        default=60.0,
        ge=1.0,
        le=180.0,
        validation_alias=AliasChoices("PHI_LLM_SIGNAL_TIMEOUT_SECONDS", "LLM_SIGNAL_TIMEOUT_SECONDS"),
    )
    # Recruiting evidence synthesis. The output is always a provisional,
    # reviewer-gated signal; the final rank is never delegated to the model.
    llm_recruiting_model: str | None = Field(
        default=None,
        max_length=120,
        validation_alias=AliasChoices("PHI_LLM_RECRUITING_MODEL", "LLM_RECRUITING_MODEL"),
    )
    llm_recruiting_timeout_seconds: float = Field(
        default=60.0,
        ge=1.0,
        le=180.0,
        validation_alias=AliasChoices("PHI_LLM_RECRUITING_TIMEOUT_SECONDS", "LLM_RECRUITING_TIMEOUT_SECONDS"),
    )
    lazy_compute_timeout_seconds: float = Field(
        default=90.0,
        ge=1.0,
        le=300.0,
        validation_alias=AliasChoices("PHI_LAZY_COMPUTE_TIMEOUT_SECONDS", "LAZY_COMPUTE_TIMEOUT_SECONDS"),
    )
    # Cumulative progress-as-of-date (backend.cumulative_llm / generate_cumulative_checkpoint)
    llm_cumulative_model: str | None = Field(
        default=None,
        max_length=120,
        validation_alias=AliasChoices("PHI_LLM_CUMULATIVE_MODEL", "LLM_CUMULATIVE_MODEL"),
    )
    cumulative_deep_tail_weeks: int = Field(
        default=4,
        ge=1,
        le=12,
        validation_alias=AliasChoices("PHI_CUMULATIVE_DEEP_TAIL_WEEKS", "CUMULATIVE_DEEP_TAIL_WEEKS"),
    )
    cumulative_compute_timeout_seconds: float = Field(
        default=90.0,
        ge=1.0,
        le=300.0,
        validation_alias=AliasChoices("PHI_CUMULATIVE_COMPUTE_TIMEOUT_SECONDS", "CUMULATIVE_COMPUTE_TIMEOUT_SECONDS"),
    )
    cumulative_provisional_ttl_minutes: int = Field(
        default=360,
        ge=1,
        le=10_080,
        validation_alias=AliasChoices("PHI_CUMULATIVE_PROVISIONAL_TTL_MINUTES", "CUMULATIVE_PROVISIONAL_TTL_MINUTES"),
    )
    cumulative_chain_rebuild_depth: int = Field(
        default=8,
        ge=1,
        le=100,
        validation_alias=AliasChoices("PHI_CUMULATIVE_CHAIN_REBUILD_DEPTH", "CUMULATIVE_CHAIN_REBUILD_DEPTH"),
    )

    gitea_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("PHI_GITEA_URL", "GITEA_URL"),
    )
    gitea_api_token: str | None = Field(
        default=None,
        repr=False,
        validation_alias=AliasChoices("PHI_GITEA_API_TOKEN", "GITEA_API_TOKEN"),
    )
    gitea_org: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "PHI_GITEA_ORG",
            "GITEA_ORG",
            "GITEA_ORGANIZATION",
        ),
    )

    admin_sync_token: str | None = Field(
        default=None,
        repr=False,
        validation_alias=AliasChoices("PHI_ADMIN_SYNC_TOKEN", "ADMIN_SYNC_TOKEN"),
        description="Shared secret required in the X-Admin-Sync-Token header to trigger /admin/sync/* jobs.",
    )
    recruiting_review_token: str | None = Field(
        default=None,
        repr=False,
        validation_alias=AliasChoices("PHI_RECRUITING_REVIEW_TOKEN", "RECRUITING_REVIEW_TOKEN"),
        description="Bearer token required for recruiting reviews when strict reviewer auth is enabled.",
    )
    require_recruiting_review_auth: bool = Field(
        default=False,
        validation_alias=AliasChoices(
            "PHI_REQUIRE_RECRUITING_REVIEW_AUTH",
            "REQUIRE_RECRUITING_REVIEW_AUTH",
        ),
        description="Fail closed on recruiting review writes unless a reviewer token and identity are supplied.",
    )

    # Named operator tokens are a minimal private-deployment gate. Each secret
    # maps to one audit subject; headers cannot impersonate another reviewer.
    api_tokens: dict[str, str] = Field(default_factory=dict, repr=False,
        validation_alias=AliasChoices("PHI_API_TOKENS", "API_TOKENS"))
    agent_ingest_token: str | None = Field(default=None, repr=False,
        validation_alias=AliasChoices("PHI_AGENT_INGEST_TOKEN", "AGENT_INGEST_TOKEN"))
    artifact_root: str = Field(default="./data/horizon", validation_alias="PHI_ARTIFACT_ROOT")
    cors_origins: list[str] = Field(default_factory=lambda: [
        "http://127.0.0.1:4173", "http://localhost:4173",
        "http://127.0.0.1:4175", "http://localhost:4175",
    ], validation_alias="PHI_CORS_ORIGINS")

    @property
    def local_auth(self) -> bool:
        return self.environment in {"local", "test", "demo"} and not self.api_tokens

    @field_validator("api_tokens")
    @classmethod
    def validate_api_tokens(cls, value: dict[str, str]) -> dict[str, str]:
        if any(not subject.strip() or len(subject) > 200 or len(token) < 24
               for subject, token in value.items()):
            raise ValueError("API tokens require a named subject and at least 24 characters")
        if len(set(value.values())) != len(value):
            raise ValueError("API tokens must be unique per subject")
        return value

    @field_validator("environment", mode="before")
    @classmethod
    def normalize_environment(cls, value: Any) -> str:
        return str(value or "local").strip().lower()

    @property
    def assessment_model(self) -> str:
        return (self.llm_assessment_model or "").strip() or self.gemini_model

    @property
    def decomposition_model(self) -> str:
        return (self.llm_decomposition_model or "").strip() or self.gemini_model

    @property
    def signal_model(self) -> str:
        return (self.llm_signal_model or "").strip() or self.gemini_model

    @property
    def recruiting_model(self) -> str:
        return (self.llm_recruiting_model or "").strip() or self.gemini_model

    @property
    def cumulative_model(self) -> str:
        return (self.llm_cumulative_model or "").strip() or self.gemini_model

    @property
    def llm_active(self) -> bool:
        """True when LLM enrichment is enabled and an API key is present."""
        return self.llm_enabled and bool(self.gemini_api_key and self.gemini_api_key.strip())



@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process settings singleton."""

    return Settings()
