import pytest

from pipeline.config import PipelineConfigError, PipelineSettings


def test_settings_load_with_nothing_configured():
    """The graph must load on a bare machine, so every field is optional."""
    settings = PipelineSettings()

    assert settings.gitea_url is None
    assert settings.database_url is None


def test_settings_read_horizon_and_legacy_phi_variable_names(monkeypatch):
    monkeypatch.setenv("GITEA_ANALYTICS_DATABASE_URL", "postgresql://u@127.0.0.1:5433/db")
    monkeypatch.setenv("PHI_GITEA_URL", "https://git.example.com")
    monkeypatch.setenv("PHI_GITEA_API_TOKEN", "token-value")

    settings = PipelineSettings()

    assert settings.database_url == "postgresql://u@127.0.0.1:5433/db"
    assert settings.gitea_url == "https://git.example.com"
    assert settings.gitea_api_token == "token-value"


def test_generic_database_url_is_not_used_for_horizon(monkeypatch):
    """The monorepo's generic DATABASE_URL may belong to People Portal."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://portal@127.0.0.1:5432/peopleportal")

    assert PipelineSettings().database_url is None


def test_horizon_prefixed_names_win_over_the_legacy_ones(monkeypatch):
    monkeypatch.setenv("PHI_GITEA_URL", "https://legacy.example.com")
    monkeypatch.setenv("HORIZON_GITEA_URL", "https://horizon.example.com")

    assert PipelineSettings().gitea_url == "https://horizon.example.com"


def test_requiring_a_present_value_returns_it_stripped():
    settings = PipelineSettings(HORIZON_GITEA_URL="  https://git.example.com  ")

    assert settings.require_gitea_url() == "https://git.example.com"


def test_requiring_a_missing_database_value_names_the_variable():
    with pytest.raises(PipelineConfigError, match="HORIZON_DATABASE_URL"):
        PipelineSettings().require_database_url()


def test_secrets_stay_out_of_the_repr():
    """Settings are logged by Dagster on load; tokens must not ride along."""
    rendered = repr(PipelineSettings(HORIZON_GITEA_API_TOKEN="s3cret"))

    assert "s3cret" not in rendered
