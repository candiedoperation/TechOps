from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

from app.auth import JwtVerifier
from app.config import Settings


@pytest.fixture
def signing():
    # Ephemeral test-only key. No test token or private key is stored on disk.
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    settings = Settings(
        auth_issuer="https://issuer.example.test/",
        auth_audience="fiction-api",
        auth_jwks_url="https://issuer.example.test/jwks",
        auth_user_pk_claim="fixture_pk",
        auth_name_claim="fixture_name",
        auth_exec_groups_claim="fixture_groups",
        auth_exec_group="fiction-execs",
    )
    verifier = JwtVerifier(settings)
    verifier.jwks.get_signing_key_from_jwt = Mock(
        return_value=SimpleNamespace(key=key.public_key())
    )
    now = datetime.now(timezone.utc)
    claims = {
        "sub": "fiction-oidc-subject",
        "fixture_pk": "fiction-user",
        "fixture_name": "Fictional Name",
        "fixture_groups": ["fiction-execs"],
        "iss": settings.auth_issuer,
        "aud": settings.auth_audience,
        "iat": now,
        "exp": now + timedelta(minutes=5),
    }
    return key, verifier, claims


def token(key, claims):
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "fiction-key"})


def test_valid_signature_and_explicit_claim_mapping(signing):
    key, verifier, claims = signing
    user = verifier.verify(token(key, claims))
    assert user.user_pk == "fiction-user" and user.is_exec
    verifier.settings.auth_exec_group = None
    assert not verifier.verify(token(key, claims)).is_exec
    claims["fixture_groups"] = "fiction-execs"
    assert not verifier.verify(token(key, claims)).is_exec


@pytest.mark.parametrize(
    "change",
    [
        {"iss": "https://other.example/"},
        {"aud": "wrong"},
        {"exp": 1},
        {"iat": 9999999999},
        {"nbf": 9999999999},
        {"fixture_pk": None},
        {"fixture_pk": 123},
        {"fixture_name": ""},
        {"sub": None},
    ],
)
def test_reject_invalid_claims(signing, change):
    key, verifier, claims = signing
    with pytest.raises(HTTPException) as error:
        verifier.verify(token(key, {**claims, **change}))
    assert error.value.status_code == 401


@pytest.mark.parametrize("missing", ["exp", "iat", "iss", "aud", "sub", "fixture_pk"])
def test_missing_required_claim(signing, missing):
    key, verifier, claims = signing
    del claims[missing]
    with pytest.raises(HTTPException):
        verifier.verify(token(key, claims))


def test_wrong_key_algorithm_and_unavailable_jwks(signing):
    key, verifier, claims = signing
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    for encoded in (
        token(other, claims),
        jwt.encode(
            claims,
            "fictional-only-signing-string-32-bytes",
            algorithm="HS256",
            headers={"kid": "fiction-key"},
        ),
        "malformed",
    ):
        with pytest.raises(HTTPException):
            verifier.verify(encoded)
    verifier.jwks.get_signing_key_from_jwt.side_effect = jwt.PyJWKClientError(
        "private detail"
    )
    with pytest.raises(HTTPException) as error:
        verifier.verify(token(key, claims))
    assert "private" not in error.value.detail


def test_missing_config_never_calls_jwks(api):
    assert JwtVerifier(Settings()).jwks is None
    assert not Settings(
        auth_issuer="http://issuer.example", auth_jwks_url="http://issuer.example/jwks"
    ).jwt_ready()
    assert (
        api[0]
        .get("/api/me", headers={"Authorization": "Bearer fake-secret"})
        .status_code
        == 401
    )
