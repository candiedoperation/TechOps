from urllib.parse import urlsplit

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="HORIZON_", extra="ignore", env_ignore_empty=True
    )

    cache_max_size: int = Field(default=256, gt=0)
    cache_ttl_seconds: int = Field(default=86400, gt=0)
    cache_pointer_ttl_seconds: int = Field(default=45, ge=30, le=60)

    database_url: SecretStr | None = None
    auth_issuer: str | None = None
    auth_audience: str | None = None
    auth_jwks_url: str | None = None
    # Explicit approved claim mapping; sub is NOT assumed to be Authentik's user PK.
    auth_user_pk_claim: str | None = None
    auth_name_claim: str | None = None
    auth_exec_groups_claim: str | None = None
    auth_exec_group: str | None = None

    def jwt_ready(self) -> bool:
        for value in (self.auth_issuer, self.auth_jwks_url):
            if not value:
                return False
            url = urlsplit(value)
            if (
                url.scheme != "https"
                or not url.hostname
                or url.username
                or url.password
                or url.fragment
            ):
                return False
        return bool(
            self.auth_audience and self.auth_user_pk_claim and self.auth_name_claim
        )
