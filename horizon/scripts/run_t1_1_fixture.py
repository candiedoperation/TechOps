"""Materialize T1.1 against fake PP/Gitea data and a loopback-only Postgres."""

from __future__ import annotations

import ipaddress
import os
from datetime import datetime, timezone
from urllib.parse import urlparse

from dagster import DagsterInstance
from psycopg import connect

from pipeline.definitions import defs
from pipeline.project_sources import (
    GiteaPRReviewRequestRow,
    GiteaPRReviewRow,
    GiteaPullRequestRow,
    ProjectSources,
    PullRequestSources,
    parse_project_sources,
)
from pipeline.resources import PostgresResource


NOW = datetime.now(timezone.utc)
EVENT_AT = datetime(2026, 10, 15, 12, tzinfo=timezone.utc)


class FakePeoplePortal:
    def get_projects(self, season_type: str, season_year: int) -> ProjectSources:
        if (season_type, season_year) != ("FALL", 2026):
            raise ValueError("Fixture only supports FALL 2026")
        payload = {
            "seasonType": "FALL", "seasonYear": 2026,
            "generatedAt": NOW.isoformat(), "roleMappingVersion": "fixture-v1",
            "projects": [{
                "projectPk": "fixture-atlas", "name": "fixture-atlas",
                "friendlyName": "Atlas fixture", "teamStartDate": None,
                "teamEndDate": None, "archived": False,
                "members": [{
                    "userPk": "user-1", "username": "alice",
                    "email": "alice@example.test", "name": "Fixture Alice",
                    "roles": ["engineer"],
                    "roleTitles": {"fixture-atlas": "Engineer"}, "tenureSemesters": 2,
                }],
            }],
        }
        return parse_project_sources(payload, "FALL", 2026, NOW)


class FakeGitea:
    def list_org_repositories(self, org: str) -> list:
        from pipeline.resources import OrgRepository

        return [OrgRepository(org, "demo", "main", False, False)]

    def get_repository_pull_requests(self, org: str, name: str):
        from pipeline.resources import RepositoryPullRequests

        return RepositoryPullRequests(
            [GiteaPullRequestRow(org, name, 1, "Fixture PR", "Synthetic source row", "alice",
                                 None, "closed", True, EVENT_AT, EVENT_AT, EVENT_AT, "main",
                                 "feature/demo", "https://example.test/fixture/pr/1")],
            [GiteaPRReviewRow(org, name, 1, 10, "alice", None, "APPROVED", EVENT_AT)],
            [GiteaPRReviewRequestRow(org, name, 1, 11, "alice", None, EVENT_AT)],
            1,
        )


def main() -> int:
    database_url = os.environ.get("HORIZON_TEST_DATABASE_URL", "")
    parsed = urlparse(database_url)
    try:
        loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        loopback = parsed.hostname == "localhost"
    if not database_url or not loopback:
        raise SystemExit("Set HORIZON_TEST_DATABASE_URL to a local Postgres; remote writes are refused.")

    job = defs.resolve_job_def("ingest_project_sources")
    result = job.execute_in_process(
        run_config={
            "ops": {
                "peopleportal_projects": {
                    "config": {"season_type": "FALL", "season_year": 2026}
                }
            }
        },
        resources={
            "peopleportal": FakePeoplePortal(),
            "gitea": FakeGitea(),
            "postgres": PostgresResource(database_url=database_url),
        },
        instance=DagsterInstance.get(),
        raise_on_error=True,
    )
    run_id = result.run_id
    print(f"dagster_run_id={run_id}")
    actual_counts = {}
    with connect(database_url) as connection:
        for table, where in (
            ("projects", "project_pk = 'fixture-atlas'"),
            ("project_members", "project_pk = 'fixture-atlas'"),
            ("project_repositories", "project_pk = 'fixture-atlas'"),
            ("gitea_pull_requests", "organization = 'fixture-atlas'"),
            ("gitea_pr_reviews", "organization = 'fixture-atlas'"),
            ("gitea_pr_review_requests", "organization = 'fixture-atlas'"),
        ):
            count = connection.execute(
                f"SELECT count(*) FROM horizon_gt_features.{table} WHERE {where}"
            ).fetchone()[0]
            actual_counts[table] = count
            print(f"table={table} rows={count}")
        row = connection.execute(
            "SELECT status, persisted_counts FROM horizon_gt_features.project_source_runs "
            "WHERE dagster_run_id = %s", (run_id,),
        ).fetchone()
    if row is None or row[0] != "complete":
        raise SystemExit("T1.1 run manifest was not complete")
    expected = {
        "projects": 1, "project_members": 1, "project_repositories": 1,
        "gitea_pull_requests": 1, "gitea_pr_reviews": 1, "gitea_pr_review_requests": 1,
    }
    if actual_counts != expected or row[1] != expected:
        raise SystemExit(f"T1.1 rows disagree with the fixture: {actual_counts}; manifest={row[1]}")
    checks = {
        event.asset_check_evaluation_data.check_name:
        event.asset_check_evaluation_data.passed
        for event in result.all_events
        if event.event_type_value == "ASSET_CHECK_EVALUATION"
    }
    expected_checks = {
        "projects_are_non_empty", "project_orgs_have_repositories",
        "pull_request_pages_are_complete",
    }
    if checks != {name: True for name in expected_checks}:
        raise SystemExit(f"T1.1 asset checks did not all pass: {checks}")
    print(f"run_status={row[0]}")
    print(f"persisted_counts={row[1]}")
    print(f"asset_checks={checks}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
