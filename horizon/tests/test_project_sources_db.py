"""Local-Postgres acceptance coverage for the T1.1 six-table latest-state write."""

from __future__ import annotations

import ipaddress
import os
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from psycopg import connect

from pipeline.project_sources import (
    GiteaPRReviewRequestRow,
    GiteaPRReviewRow,
    GiteaPullRequestRow,
    ProjectMemberRow,
    ProjectRepositoryRow,
    ProjectRow,
    ProjectSources,
    PullRequestSources,
)
from pipeline.storage import PostgresResource


def _test_database_url() -> str:
    value = os.environ.get("HORIZON_TEST_DATABASE_URL")
    if not value:
        pytest.skip("HORIZON_TEST_DATABASE_URL is not set")
    parsed = urlparse(value)
    try:
        loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        loopback = parsed.hostname == "localhost"
    if not loopback:
        pytest.fail("T1.1 DB acceptance test requires a loopback Postgres database")
    return value


def _snapshot(database_url: str, project_pk: str) -> dict[str, list[dict]]:
    queries = {
        "projects": ("projects", "project_pk = %s"),
        "project_members": ("project_members", "project_pk = %s"),
        "project_repositories": ("project_repositories", "project_pk = %s"),
        "gitea_pull_requests": ("gitea_pull_requests", "organization = %s"),
        "gitea_pr_reviews": ("gitea_pr_reviews", "organization = %s"),
        "gitea_pr_review_requests": ("gitea_pr_review_requests", "organization = %s"),
    }
    args = (project_pk, project_pk, project_pk, project_pk, project_pk, project_pk)
    with connect(database_url) as connection:
        return {
            key: [row[0] for row in connection.execute(
                f"SELECT to_jsonb(t) - 'retrieved_at' FROM horizon_gt_features.{table} t WHERE {where}",
                (arg,),
            ).fetchall()]
            for (key, (table, where)), arg in zip(queries.items(), args, strict=True)
        }


def _retrieval_times(database_url: str, project_pk: str) -> dict[str, datetime]:
    queries = {
        "projects": ("projects", "project_pk = %s"),
        "project_members": ("project_members", "project_pk = %s"),
        "project_repositories": ("project_repositories", "project_pk = %s"),
        "gitea_pull_requests": ("gitea_pull_requests", "organization = %s"),
        "gitea_pr_reviews": ("gitea_pr_reviews", "organization = %s"),
        "gitea_pr_review_requests": ("gitea_pr_review_requests", "organization = %s"),
    }
    with connect(database_url) as connection:
        return {
            key: connection.execute(
                f"SELECT max(retrieved_at) FROM horizon_gt_features.{table} WHERE {where}",
                (project_pk,),
            ).fetchone()[0]
            for key, (table, where) in queries.items()
        }


def _fixture(project_pk: str, organization: str, at: datetime, *, changed: bool = False):
    event_at = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
    project = ProjectRow(
        project_pk, "FALL", 2026, "Atlas", organization,
        "Atlas changed" if changed else "Atlas", date(2026, 8, 31), date(2026, 12, 11), False,
    )
    member = ProjectMemberRow(project_pk, f"user-{project_pk}", "alice", "a@example.test",
                              "Alice", ("engineer",), {project_pk: "Engineer"}, 2, "fixture-v1")
    sources = ProjectSources("FALL", 2026, "fixture-v1", [project], [member], at)
    repository = ProjectRepositoryRow(project_pk, organization, "app", "main")
    pull = GiteaPullRequestRow(
        organization, "app", 1, "Changed PR" if changed else "Fixture PR", "body", "alice",
        f"user-{project_pk}", "closed", True, event_at, event_at, event_at, "main", "feature", "https://example.test/pr/1",
    )
    review = GiteaPRReviewRow(organization, "app", 1, 10, "alice", f"user-{project_pk}", "APPROVED", event_at)
    request = GiteaPRReviewRequestRow(organization, "app", 1, 11, "alice", f"user-{project_pk}", event_at)
    pulls = PullRequestSources([pull], [review], [request], {f"{organization}/app": (1, 1)}, at)
    return sources, [repository], pulls


def test_source_snapshot_upserts_six_tables_and_commits_complete_manifest():
    database_url = _test_database_url()
    store = PostgresResource(database_url=database_url)
    store.ensure_schema()
    suffix = uuid4().hex[:12]
    project_pk, organization = f"t11-{suffix}", f"t11-{suffix}"
    run_id = f"t11-{suffix}"
    first_at = datetime.now(timezone.utc)
    first = _fixture(project_pk, organization, first_at)
    first_counts = store.write_project_sources(*first, dagster_run_id=run_id)
    before = _snapshot(database_url, project_pk)
    first_retrieved = _retrieval_times(database_url, project_pk)

    second_at = first_at + timedelta(seconds=2)
    second = _fixture(project_pk, organization, second_at)
    second_counts = store.write_project_sources(*second, dagster_run_id=run_id)
    after = _snapshot(database_url, project_pk)
    second_retrieved = _retrieval_times(database_url, project_pk)
    assert before == after
    assert all(second_retrieved[name] > first_retrieved[name] for name in first_retrieved)
    assert first_counts == second_counts == {
        "projects": 1,
        "project_members": 1,
        "project_repositories": 1,
        "gitea_pull_requests": 1,
        "gitea_pr_reviews": 1,
        "gitea_pr_review_requests": 1,
    }

    changed = _fixture(project_pk, organization, second_at + timedelta(seconds=2), changed=True)
    store.write_project_sources(*changed, dagster_run_id=f"{run_id}-changed")
    changed_rows = _snapshot(database_url, project_pk)
    assert changed_rows["projects"] != after["projects"]
    assert changed_rows["gitea_pull_requests"] != after["gitea_pull_requests"]
    assert changed_rows["project_members"] == after["project_members"]
    assert changed_rows["project_repositories"] == after["project_repositories"]
    assert changed_rows["gitea_pr_reviews"] == after["gitea_pr_reviews"]
    assert changed_rows["gitea_pr_review_requests"] == after["gitea_pr_review_requests"]

    with connect(database_url) as connection:
        run = connection.execute(
            "SELECT status, persisted_counts FROM horizon_gt_features.project_source_runs "
            "WHERE dagster_run_id = %s", (run_id,),
        ).fetchone()
        assert run == ("complete", first_counts)
        actual = {
            table: connection.execute(
                f"SELECT count(*) FROM horizon_gt_features.{table} WHERE {predicate}",
                (value,),
            ).fetchone()[0]
            for table, predicate, value in (
                ("projects", "project_pk = %s", project_pk),
                ("project_members", "project_pk = %s", project_pk),
                ("project_repositories", "project_pk = %s", project_pk),
                ("gitea_pull_requests", "organization = %s", organization),
                ("gitea_pr_reviews", "organization = %s", organization),
                ("gitea_pr_review_requests", "organization = %s", organization),
            )
        }
    assert actual == first_counts

    duplicate_id = f"t11-{uuid4().hex[:12]}"
    duplicate_pk = f"t11-{uuid4().hex[:12]}"
    duplicate_org = duplicate_pk
    duplicate_sources = _fixture(duplicate_pk, duplicate_org, datetime.now(timezone.utc))
    source, repos, pulls = duplicate_sources
    duplicate_pulls = replace(pulls, pull_requests=pulls.pull_requests * 2)
    with pytest.raises(ValueError, match="duplicate pull request keys"):
        store.write_project_sources(
            source, repos, duplicate_pulls, dagster_run_id=duplicate_id
        )
    with connect(database_url) as connection:
        assert connection.execute(
            "SELECT count(*) FROM horizon_gt_features.project_source_runs "
            "WHERE dagster_run_id = %s", (duplicate_id,),
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT count(*) FROM horizon_gt_features.projects WHERE project_pk = %s",
            (duplicate_pk,),
        ).fetchone()[0] == 0
