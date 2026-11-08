from dataclasses import dataclass
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings


@dataclass(frozen=True)
class Principal:
    user_pk: str
    name: str
    is_exec: bool


def unauthorized() -> HTTPException:
    return HTTPException(
        401,
        "A valid Horizon access token is required.",
        headers={"WWW-Authenticate": "Bearer"},
    )


class JwtVerifier:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.jwks = (
            jwt.PyJWKClient(settings.auth_jwks_url, timeout=5, lifespan=300)
            if settings.jwt_ready()
            else None
        )

    def verify(self, token: str) -> Principal:
        if not self.jwks:
            raise unauthorized()
        try:
            # Never trust jku/x5u or choose an algorithm from the token header.
            header = jwt.get_unverified_header(token)
            if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
                raise unauthorized()
            key = self.jwks.get_signing_key_from_jwt(token).key
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                issuer=self.settings.auth_issuer,
                audience=self.settings.auth_audience,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            )
            pk = claims.get(self.settings.auth_user_pk_claim)
            name = claims.get(self.settings.auth_name_claim)
            if (
                not isinstance(pk, str)
                or not pk.strip()
                or not isinstance(name, str)
                or not name.strip()
            ):
                raise unauthorized()
            groups = claims.get(self.settings.auth_exec_groups_claim, [])
            is_exec = bool(
                self.settings.auth_exec_group
                and isinstance(groups, list)
                and all(isinstance(group, str) for group in groups)
                and self.settings.auth_exec_group in groups
            )
            return Principal(pk, name, is_exec)
        except (jwt.PyJWTError, ValueError, TypeError, OSError):
            # Never echo token contents, claims, key URLs, or library exception text.
            raise unauthorized() from None


bearer = HTTPBearer(auto_error=False)


def current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> Principal:
    if not credentials or credentials.scheme.lower() != "bearer":
        raise unauthorized()
    return request.app.state.verifier.verify(credentials.credentials)


def require_exec(user: Annotated[Principal, Depends(current_user)]) -> Principal:
    if not user.is_exec:
        raise HTTPException(403, "Executive access is required.")
    return user
