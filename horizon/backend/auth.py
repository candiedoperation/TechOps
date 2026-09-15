"""Local demo access and fail-closed, attributable operator authentication."""
from __future__ import annotations

import secrets
from typing import Annotated, Awaitable, Callable

from fastapi import Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .models import Role
from .config import Settings, get_settings


class AuthUser(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    subject: str = Field(min_length=1, max_length=200)
    roles: frozenset[Role] = frozenset()

    @property
    def is_admin(self) -> bool:
        return Role.ADMIN in self.roles

    @property
    def can_view_portfolio(self) -> bool:
        return self.is_admin or Role.PORTFOLIO_LEADER in self.roles


_PUBLIC_ADMIN = AuthUser(subject="public", roles=frozenset({Role.ADMIN}))


def _unauthorized() -> HTTPException:
    return HTTPException(status_code=401, detail="authenticated operator token required",
                         headers={"WWW-Authenticate": "Bearer"})


def _bearer(authorization: str | None) -> str:
    scheme, _, token = (authorization or "").partition(" ")
    return token if scheme.casefold() == "bearer" else ""


def _operator(authorization: str | None, settings: Settings) -> AuthUser:
    supplied = _bearer(authorization)
    for subject, expected in settings.api_tokens.items():
        if secrets.compare_digest(supplied.encode(), expected.encode()):
            return AuthUser(subject=subject, roles=frozenset({Role.ADMIN}))
    raise _unauthorized()


async def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
) -> AuthUser:
    settings = get_settings()
    return _PUBLIC_ADMIN if settings.local_auth else _operator(authorization, settings)


async def get_ci_ingest_user(
    token: Annotated[str | None, Header(alias="X-Agent-Ingest-Token")] = None,
    authorization: Annotated[str | None, Header()] = None,
    settings: Settings = Depends(get_settings),
) -> AuthUser:
    if not isinstance(settings, Settings):
        settings = get_settings()
    if settings.local_auth:
        return _PUBLIC_ADMIN
    supplied = token or _bearer(authorization)
    if settings.agent_ingest_token and secrets.compare_digest(supplied.encode(), settings.agent_ingest_token.encode()):
        return AuthUser(subject="ci-agent", roles=frozenset({Role.PORTFOLIO_LEADER}))
    raise _unauthorized()


async def require_recruiting_reviewer(
    authorization: Annotated[str | None, Header()] = None,
    x_reviewer_id: Annotated[str | None, Header()] = None,
) -> AuthUser:
    settings = get_settings()
    if not settings.local_auth:
        return _operator(authorization, settings)
    if not settings.require_recruiting_review_auth:
        return _PUBLIC_ADMIN
    expected = settings.recruiting_review_token
    reviewer = (x_reviewer_id or "").strip()
    if (not expected or not secrets.compare_digest(_bearer(authorization).encode(), expected.encode())
            or not reviewer or len(reviewer) > 200):
        raise _unauthorized()
    return AuthUser(subject=reviewer, roles=frozenset({Role.ADMIN}))


def require_roles(*required_roles: Role) -> Callable[..., Awaitable[AuthUser]]:
    async def dependency(user: AuthUser = Depends(get_current_user)) -> AuthUser:
        if not user.is_admin and required_roles and not user.roles.intersection(required_roles):
            raise HTTPException(status_code=403, detail="insufficient role")
        return user
    return dependency


async def require_project_access(project_id: str, user: AuthUser = Depends(get_current_user)) -> AuthUser:
    if not user.can_view_portfolio:
        raise HTTPException(status_code=403, detail="project access requires a portfolio role")
    return user


def visible_project_ids(user: AuthUser, all_project_ids: list[str]) -> list[str]:
    return list(all_project_ids) if user.can_view_portfolio else []
