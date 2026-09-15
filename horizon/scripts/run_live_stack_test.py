#!/usr/bin/env python3
"""Exercise the full dashboard pipeline against the Docker live-test stack."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parent.parent
TOKEN_FILE = ROOT / ".live-test-token"


def configure() -> None:
    if not TOKEN_FILE.exists():
        raise SystemExit(".live-test-token is missing; run scripts/seed_live_gitea.py first")
    values = {
        "PHI_ENVIRONMENT": "local",
        "PHI_ENV_FILE": "",
        "PHI_SQLITE_PATH": str(ROOT / "data/live-test.db"),
        "PHI_GITEA_URL": "http://127.0.0.1:10000",
        "PHI_GITEA_API_TOKEN": TOKEN_FILE.read_text().strip(),
        "PHI_GITEA_ORG": "appdev",
        "PHI_PEOPLE_PORTAL_URL": "http://127.0.0.1:3100",
        "PHI_PEOPLE_PORTAL_API_TOKEN": "project-health-local-service-token",
        "PHI_AGENT_INGEST_TOKEN": "project-health-local-agent-token",
        "PHI_AGGREGATION_FLOOR": "5",
    }
    os.environ.update(values)


async def run() -> dict[str, Any]:
    configure()
    from httpx import ASGITransport, AsyncClient

    from backend.config import get_settings
    from backend.db import close_db, get_active_repository, init_db
    from backend.jobs import run_nightly_sync, run_weekly_backfill
    from backend.main import create_app
    from backend.seed import seed_demo_data
    from backend.staging import open_staging_store

    get_settings.cache_clear()
    settings = get_settings()
    await init_db(settings)
    database = get_active_repository()
    try:
        seed = await seed_demo_data()
        nightly = await run_nightly_sync(settings=settings, database=database, lookback_days=14)
        backfill = await run_weekly_backfill(settings=settings, database=database, weeks=13)

        staging = open_staging_store(settings)
        try:
            teams = await staging.list_staging("people_portal_teams")
            people_portal_projects = await staging.list_staging("people_portal_projects")
            gitea_repos = await staging.list_staging("gitea_repos")
            raw_activity = await staging.list_staging("repo_activity_staging")
        finally:
            staging.close()

        projects = await database.list("projects")
        activity = await database.list("repo_activity")
        snapshots = await database.list("snapshots")
        warnings = await database.list("warnings")

        transport = ASGITransport(app=create_app())
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            health_response = await client.get("/health")
            latest_response = await client.get("/snapshots/latest")
            spec = yaml.safe_load((ROOT / "fixtures/project-health-spec.yaml").read_text(encoding="utf-8"))
            evidence = json.loads((ROOT / "fixtures/ci-evidence-week-3.json").read_text(encoding="utf-8"))
            # Submit against a project sourced from the seeded People Portal catalog.
            spec["project_id"] = "member-portal"
            evidence["project_id"] = "member-portal"
            ci_payload = {
                "project_id": "member-portal",
                "spec": spec,
                "evidence": evidence,
            }
            ci_headers = {"Authorization": "Bearer project-health-local-agent-token"}
            first_ci_response = await client.post("/ci/assessments", json=ci_payload, headers=ci_headers)
            second_ci_response = await client.post("/ci/assessments", json=ci_payload, headers=ci_headers)
            assessment_response = await client.get("/projects/member-portal/health-assessment")
        health_response.raise_for_status()
        latest_response.raise_for_status()
        first_ci_response.raise_for_status()
        second_ci_response.raise_for_status()
        assessment_response.raise_for_status()
        latest = latest_response.json()
        first_ci_result = first_ci_response.json()
        second_ci_result = second_ci_response.json()
        assessment_result = assessment_response.json()

        warning_rules = sorted({str(item.rule_id) for item in warnings})
        result = {
            "status": "ok",
            "seed": seed,
            "nightly": nightly,
            "backfill": backfill,
            "counts": {
                "projects": len(projects),
                "people_portal_team_rows": len(teams),
                "people_portal_project_rows": len(people_portal_projects),
                "gitea_repo_rows": len(gitea_repos),
                "raw_activity_rows": len(raw_activity),
                "modeled_activity_rows": len(activity),
                "snapshots": len(snapshots),
                "warnings": len(warnings),
            },
            "warning_rules": warning_rules,
            "api": {
                "health": health_response.json(),
                "latest_projects": len(latest.get("projects", [])),
                "snapshot_week_start": latest.get("snapshot_week_start"),
                "ci_status": second_ci_result["assessment"]["status"],
                "dashboard_assessment_status": assessment_result["assessment"]["status"],
            },
        }

        assert nightly["directory_source"] == "people_portal", result
        assert nightly["people_portal"]["status"] == "ok", result
        assert nightly["project_catalog"]["status"] == "ok", result
        assert nightly["gitea"]["status"] == "ok", result
        # mobile-lab intentionally has a boundary effective from 2026-08-03,
        # so older replay windows are partial/unmapped by design.
        assert backfill["status"] in {"ok", "partial"}, result
        backfill_flags = {
            flag
            for week in backfill["weeks"]
            for flag in week.get("data_quality_flags", [])
        }
        assert backfill_flags <= {"unmapped_repo"}, result
        assert len(projects) == 7, result
        assert len(teams) >= 13, result
        assert len(gitea_repos) >= 9, result
        assert len(activity) >= 50, result
        assert len(latest.get("projects", [])) == 7, result
        assert "activity_decline" in warning_rules, result
        assert first_ci_result["idempotent"] in {False, True}, result
        assert second_ci_result["idempotent"] is True, result
        assert first_ci_result["assessment"]["project_id"] == "member-portal", result
        assert second_ci_result["assessment"] == first_ci_result["assessment"], result
        submitted_assessment = second_ci_result["assessment"]
        dashboard_assessment = assessment_result["assessment"]
        assert dashboard_assessment is not None, result
        assert {
            "status": dashboard_assessment["status"],
            "score": dashboard_assessment["score"],
            "confidence": dashboard_assessment["confidence"],
            "expected_week": dashboard_assessment["expectedWeek"],
            "explanation": dashboard_assessment["explanation"],
            "blockers": dashboard_assessment["blockers"],
            "weekly_tasks": dashboard_assessment["recommendedWeeklyTasks"],
            "assessment_id": dashboard_assessment["assessment_id"],
            "spec_version": dashboard_assessment["spec_version"],
            "commit_sha": dashboard_assessment["commit_sha"],
        } == {
            "status": submitted_assessment["status"],
            "score": submitted_assessment["score"],
            "confidence": submitted_assessment["confidence"],
            "expected_week": submitted_assessment["expected_week"],
            "explanation": submitted_assessment["summary"],
            "blockers": submitted_assessment["blockers"],
            "weekly_tasks": submitted_assessment["weekly_tasks"],
            "assessment_id": submitted_assessment["assessment_id"],
            "spec_version": submitted_assessment["spec_version"],
            "commit_sha": submitted_assessment["commit_sha"],
        }, result
        assert dashboard_assessment["citations"], result
        return result
    finally:
        await close_db()


if __name__ == "__main__":
    print(json.dumps(asyncio.run(run()), indent=2, default=str))
