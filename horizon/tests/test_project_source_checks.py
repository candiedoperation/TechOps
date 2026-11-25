"""T1.1: the source checks (zero projects, an org without repositories, PR page counts)."""

from datetime import date

from dagster import AssetCheckSeverity

from pipeline.checks import (
    project_orgs_have_repositories,
    projects_are_non_empty,
    pull_request_pages_are_complete,
)
from pipeline.project_sources import ProjectRow, ProjectSources
from project_source_fixtures import NOW


def test_pr_count_check_detects_reported_vs_fetched_mismatch():
    from pipeline.project_sources import PullRequestSources

    result = PullRequestSources([], [], [], {"Atlas/app": (2, 1)}, NOW)
    check = pull_request_pages_are_complete(result)
    assert not check.passed
    assert "Atlas/app" in str(check.metadata["mismatched"])


def test_active_org_without_members_still_fails_when_it_has_no_repositories():
    project = ProjectRow(
        "empty-roster", "FALL", 2026, "Empty", "EmptyOrg", "Empty Org",
        date(2026, 8, 31), date(2026, 12, 11), False,
    )
    sources = ProjectSources("FALL", 2026, "fixture-v1", [project], [], NOW)
    check = project_orgs_have_repositories([], sources)
    assert not check.passed
    assert check.metadata["orgs_without_repositories"].value == ["EmptyOrg"]
    # Reported, but it must not stop the week for every other project.
    assert check.severity == AssetCheckSeverity.WARN


def test_zero_projects_fail_the_blocking_source_check():
    sources = ProjectSources("FALL", 2026, "fixture-v1", [], [], NOW)
    assert not projects_are_non_empty(sources).passed
