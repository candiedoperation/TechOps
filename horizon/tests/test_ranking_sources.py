from datetime import datetime, timedelta, timezone

import pytest

from pipeline.ranking.sources import CompleteRun, check_source_freshness

AS_OF = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)
REPO = ("SpaceApp", "backend")


def _check(run):
    runs = {} if run is None else {REPO: run}
    return check_source_freshness([REPO], runs, AS_OF)


def test_a_run_just_inside_eight_days_is_fresh():
    result = _check(CompleteRun("run-a", AS_OF - timedelta(days=7, hours=23)))

    assert result.is_fresh
    assert result.source_runs == {"SpaceApp/backend": "run-a"}


def test_a_run_older_than_eight_days_is_stale_but_still_recorded():
    result = _check(CompleteRun("run-old", AS_OF - timedelta(days=8, hours=1)))

    assert result.stale == ("SpaceApp/backend",)
    assert result.source_runs == {"SpaceApp/backend": "run-old"}


def test_a_repository_with_no_complete_run_is_stale():
    result = _check(None)

    assert result.stale == ("SpaceApp/backend",)
    assert result.source_runs == {}


def test_a_run_completed_after_as_of_is_ignored():
    result = _check(CompleteRun("run-future", AS_OF + timedelta(minutes=1)))

    assert result.stale == ("SpaceApp/backend",)
    assert result.source_runs == {}


def test_every_repository_is_keyed_by_org_slash_repo():
    repos = [("SpaceApp", "backend"), ("SpaceApp", "web"), ("Tutor", "api")]
    runs = {repo: CompleteRun(f"run-{repo[1]}", AS_OF - timedelta(days=1)) for repo in repos}

    result = check_source_freshness(repos + [repos[0]], runs, AS_OF)

    assert result.is_fresh
    assert result.source_runs == {
        "SpaceApp/backend": "run-backend",
        "SpaceApp/web": "run-web",
        "Tutor/api": "run-api",
    }


def test_no_repositories_is_trivially_fresh():
    result = check_source_freshness([], {}, AS_OF)

    assert result.is_fresh and result.source_runs == {}


def test_naive_as_of_is_rejected():
    with pytest.raises(ValueError, match="timezone-aware"):
        check_source_freshness([REPO], {}, datetime(2026, 11, 9))
