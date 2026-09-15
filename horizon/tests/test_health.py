from fastapi.testclient import TestClient

from backend.config import get_settings
from backend.main import create_app


def test_health_reports_ok_and_the_configured_environment():
    get_settings.cache_clear()
    with TestClient(create_app()) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "environment": "test"}


def test_health_exposes_no_configuration_beyond_the_environment_name():
    """A liveness probe is unauthenticated, so it must not leak settings."""
    get_settings.cache_clear()
    with TestClient(create_app()) as client:
        payload = client.get("/health").json()

    assert set(payload) == {"status", "environment"}
