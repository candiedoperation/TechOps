"""HTTP integration tests for the routes in ``backend.api``.

The routes exercised here are the ones the router actually registers.  The
app under test is assembled without ``main.lifespan`` because
``httpx.ASGITransport`` does not run lifespan events; ``conftest`` initialises
and seeds the in-memory database instead.
"""

from __future__ import annotations

import uuid

import pytest

from backend.rules import RULES

# Deterministic ids written by ``backend.seed`` (``_oid(n)``).
MEMBER_PORTAL_SNAPSHOT_ID = str(uuid.UUID(int=1))
MEMBER_PORTAL_WARNING_ID = str(uuid.UUID(int=101))
CAMPUS_EVENTS_SNAPSHOT_ID = str(uuid.UUID(int=2))

SEEDED_PROJECT_IDS = {
    "member-portal",
    "campus-events",
    "design-system",
    "alumni-network",
    "onboarding",
    "mobile-lab",
    "winter-campaign",
}


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------


async def test_health_returns_ok(app_client):
    response = await app_client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["database"] == "sqlite"
    assert body["outbound_notifications"] is False
    assert "sqlite_path" in body


async def test_health_works_without_any_data(empty_app_client):
    assert (await empty_app_client.get("/health")).status_code == 200


# ---------------------------------------------------------------------------
# GET /snapshots/latest  (the portfolio project list)
# ---------------------------------------------------------------------------


async def test_latest_snapshot_returns_the_project_list(app_client):
    response = await app_client.get("/snapshots/latest")

    assert response.status_code == 200
    body = response.json()
    assert isinstance(body["projects"], list)
    assert {item["id"] for item in body["projects"]} == SEEDED_PROJECT_IDS
    assert body["rule_set_version"] == "rules-v1"
    assert body["snapshot_week_start"] == "2026-08-03"
    assert body["snapshot_week_end"] == "2026-08-09"
    assert 0 <= body["data_completeness_pct"] <= 100


async def test_latest_snapshot_project_shape_is_frontend_compatible(app_client):
    body = (await app_client.get("/snapshots/latest")).json()
    project = next(item for item in body["projects"] if item["id"] == "member-portal")

    assert project["name"] == "Member Portal"
    assert project["status"] == "At risk"
    assert project["statusClass"] == "risk"
    assert project["signalSource"] == "rules"
    assert len(project["weeks"]) == 8
    assert set(project["series"]) >= {"activity", "openPRs", "reviewLatency"}
    assert set(project["seriesBaselines"]) >= {"openPRs", "reviewLatency"}
    assert project["boundary"]["rootTeam"] == "product-experience"
    assert project["boundary"]["repos"] == ["member-portal", "member-portal-api"]
    assert project["snapshot_id"] == MEMBER_PORTAL_SNAPSHOT_ID
    assert project["evidence"], "at-risk projects must carry inspectable evidence"


async def test_latest_snapshot_omits_contributor_series_when_gated(app_client):
    """``mobile-lab`` has no contributor aggregate, so the series is withheld."""
    body = (await app_client.get("/snapshots/latest")).json()
    project = next(item for item in body["projects"] if item["id"] == "mobile-lab")

    assert project["status"] == "Insufficient data"
    assert project["series"].get("contributors") is None
    assert project["seriesBaselines"].get("contributors") is None


async def test_latest_snapshot_planned_pause_has_no_warnings(app_client):
    body = (await app_client.get("/snapshots/latest")).json()
    project = next(item for item in body["projects"] if item["id"] == "winter-campaign")

    assert project["status"] == "Planned pause"
    assert project["statusClass"] == "pause"
    assert project["evidence"] == []


async def test_latest_snapshot_on_an_empty_portfolio(empty_app_client):
    response = await empty_app_client.get("/snapshots/latest")

    assert response.status_code == 200
    body = response.json()
    assert body["projects"] == []
    assert body["snapshot_week_start"] is None
    assert body["rule_set_version"] == "none"


# ---------------------------------------------------------------------------
# GET /projects/{id}/snapshots
# ---------------------------------------------------------------------------


async def test_project_snapshots_for_a_known_project(app_client):
    response = await app_client.get("/projects/member-portal/snapshots")

    assert response.status_code == 200
    body = response.json()
    assert body["project_id"] == "member-portal"
    assert len(body["snapshots"]) == 1

    snapshot = body["snapshots"][0]
    assert snapshot["snapshot_id"] == MEMBER_PORTAL_SNAPSHOT_ID
    assert snapshot["snapshot_week_start"] == "2026-08-03"
    assert snapshot["project"]["id"] == "member-portal"


async def test_project_snapshots_404_for_unknown_project(app_client):
    response = await app_client.get("/projects/no-such-project/snapshots")

    assert response.status_code == 404
    assert response.json()["detail"] == "project not found"


# ---------------------------------------------------------------------------
# GET /projects/{id}/boundary
# ---------------------------------------------------------------------------


async def test_project_boundary_for_a_known_project(app_client):
    response = await app_client.get("/projects/member-portal/boundary")

    assert response.status_code == 200
    boundary = response.json()["boundary"]
    assert boundary["rootTeam"] == "product-experience"
    assert boundary["subteams"] == ["member-portal-core", "growth"]
    assert boundary["repos"] == ["member-portal", "member-portal-api"]
    assert boundary["dataOwner"] == "priya-n"
    assert boundary["lifecycle"] == "active"


async def test_project_boundary_404_for_unknown_project(app_client):
    assert (await app_client.get("/projects/nope/boundary")).status_code == 404


# ---------------------------------------------------------------------------
# GET /projects/{id}/health-assessment
# ---------------------------------------------------------------------------


async def test_project_health_assessment(app_client):
    response = await app_client.get("/projects/member-portal/health-assessment")

    assert response.status_code == 200
    body = response.json()
    assert body["project_id"] == "member-portal"
    assessment = body["assessment"]
    assert assessment is not None
    assert 0 <= assessment["score"] <= 100
    assert 0 <= assessment["confidence"] <= 1
    assert assessment["expectedWeek"] == 3
    assert assessment["explanation"]


async def test_project_health_assessment_404_for_unknown_project(app_client):
    assert (
        await app_client.get("/projects/nope/health-assessment")
    ).status_code == 404


# ---------------------------------------------------------------------------
# POST /feedback
# ---------------------------------------------------------------------------


async def test_create_feedback_succeeds(app_client):
    response = await app_client.post(
        "/feedback",
        json={
            "snapshot_id": MEMBER_PORTAL_SNAPSHOT_ID,
            "project_id": "member-portal",
            "category": "risk_confirmed",
            "note": "Reviewer bandwidth is being backfilled.",
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["project_id"] == "member-portal"
    assert body["snapshot_id"] == MEMBER_PORTAL_SNAPSHOT_ID
    assert body["category"] == "risk_confirmed"
    assert uuid.UUID(body["id"])


async def test_create_feedback_with_a_warning_reference(app_client):
    response = await app_client.post(
        "/feedback",
        json={
            "snapshot_id": MEMBER_PORTAL_SNAPSHOT_ID,
            "warning_id": MEMBER_PORTAL_WARNING_ID,
            "project_id": "member-portal",
            "category": "false_positive",
        },
    )
    assert response.status_code == 201


async def test_create_feedback_is_written_to_history_and_audit(app_client):
    await app_client.post(
        "/feedback",
        json={
            "snapshot_id": MEMBER_PORTAL_SNAPSHOT_ID,
            "project_id": "member-portal",
            "category": "risk_resolved",
            "note": "Queue drained.",
        },
    )

    body = (await app_client.get("/snapshots/latest")).json()
    project = next(item for item in body["projects"] if item["id"] == "member-portal")
    assert any(entry["note"] == "Queue drained." for entry in project["history"])

    audit = (await app_client.get("/audit", params={"project_id": "member-portal"})).json()
    assert any(row["action"] == "feedback.created" for row in audit)


async def test_create_feedback_404_for_unknown_project(app_client):
    response = await app_client.post(
        "/feedback",
        json={
            "snapshot_id": MEMBER_PORTAL_SNAPSHOT_ID,
            "project_id": "no-such-project",
            "category": "helpful",
        },
    )
    assert response.status_code == 404


async def test_create_feedback_422_for_a_non_uuid_snapshot_id(app_client):
    response = await app_client.post(
        "/feedback",
        json={
            "snapshot_id": "not-a-uuid",
            "project_id": "member-portal",
            "category": "helpful",
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "snapshot_id is invalid"


async def test_create_feedback_404_when_snapshot_belongs_to_another_project(app_client):
    response = await app_client.post(
        "/feedback",
        json={
            "snapshot_id": CAMPUS_EVENTS_SNAPSHOT_ID,
            "project_id": "member-portal",
            "category": "helpful",
        },
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "snapshot not found for project"


async def test_create_feedback_404_when_warning_is_not_on_the_snapshot(app_client):
    response = await app_client.post(
        "/feedback",
        json={
            "snapshot_id": CAMPUS_EVENTS_SNAPSHOT_ID,
            "warning_id": MEMBER_PORTAL_WARNING_ID,
            "project_id": "campus-events",
            "category": "helpful",
        },
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "warning not found for snapshot"


async def test_create_feedback_422_for_an_unknown_category(app_client):
    response = await app_client.post(
        "/feedback",
        json={
            "snapshot_id": MEMBER_PORTAL_SNAPSHOT_ID,
            "project_id": "member-portal",
            "category": "not-a-category",
        },
    )
    assert response.status_code == 422


async def test_create_feedback_422_for_extra_fields(app_client):
    response = await app_client.post(
        "/feedback",
        json={
            "snapshot_id": MEMBER_PORTAL_SNAPSHOT_ID,
            "project_id": "member-portal",
            "category": "helpful",
            "author_user_id": "spoofed",
        },
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# GET /audit
# ---------------------------------------------------------------------------


async def test_audit_log_returns_entries(app_client):
    response = await app_client.get("/audit")

    assert response.status_code == 200
    rows = response.json()
    assert isinstance(rows, list)
    assert rows, "the seed writes one audit entry"
    assert {"id", "actor_user_id", "action", "target_type", "at"} <= set(rows[0])


async def test_audit_log_filters_by_project(app_client):
    rows = (await app_client.get("/audit", params={"project_id": "member-portal"})).json()
    assert all((row["after"] or {}).get("project_id") == "member-portal" for row in rows)

    empty = (await app_client.get("/audit", params={"project_id": "nope"})).json()
    assert empty == []


async def test_audit_log_respects_the_limit(app_client):
    rows = (await app_client.get("/audit", params={"limit": 1})).json()
    assert len(rows) <= 1


@pytest.mark.parametrize("limit", [0, 501, -1])
async def test_audit_log_422_for_out_of_range_limits(app_client, limit):
    assert (
        await app_client.get("/audit", params={"limit": limit})
    ).status_code == 422


# ---------------------------------------------------------------------------
# GET /rules
# ---------------------------------------------------------------------------


async def test_rules_returns_rule_metadata(app_client):
    response = await app_client.get("/rules")

    assert response.status_code == 200
    body = response.json()
    assert body["rule_set_version"] == "rules-v1"
    assert {rule["rule_id"] for rule in body["rules"]} == set(RULES)

    for rule in body["rules"]:
        assert {
            "rule_id",
            "version",
            "signal_name",
            "description",
            "minimum_data",
            "threshold",
            "severity",
            "status",
        } <= set(rule)
        assert rule["status"] == "Active"
        assert rule["signal_name"]


async def test_rules_is_available_without_data(empty_app_client):
    assert (await empty_app_client.get("/rules")).status_code == 200


# ---------------------------------------------------------------------------
# GET /boundaries and POST /boundaries
# ---------------------------------------------------------------------------


async def test_list_boundaries(app_client):
    response = await app_client.get("/boundaries")

    assert response.status_code == 200
    rows = response.json()
    assert {row["project_id"] for row in rows} == SEEDED_PROJECT_IDS


async def test_create_boundary_versions_the_previous_one(app_client):
    response = await app_client.post(
        "/boundaries",
        json={
            "project_id": "member-portal",
            "root_authentik_team_id": "product-experience-v2",
            "included_subteam_ids": ["member-portal-core"],
            "primary_repos": [
                {"gitea_repo_id": "g-new", "repo_slug": "member-portal"}
            ],
            "effective_from": "2026-09-01",
            "data_owner_user_id": "priya-n",
        },
    )

    assert response.status_code == 201
    assert response.json()["boundary"]["rootTeam"] == "product-experience-v2"

    rows = (await app_client.get("/boundaries")).json()
    member_portal = [row for row in rows if row["project_id"] == "member-portal"]
    assert len(member_portal) == 2
    # The superseded version is closed at the new effective date.
    superseded = next(row for row in member_portal if row["effective_from"] == "2026-01-01")
    assert superseded["effective_to"] == "2026-09-01"


async def test_create_boundary_409_when_effective_from_does_not_advance(app_client):
    response = await app_client.post(
        "/boundaries",
        json={
            "project_id": "member-portal",
            "root_authentik_team_id": "product-experience",
            "effective_from": "2025-01-01",
        },
    )
    assert response.status_code == 409


async def test_create_boundary_404_for_unknown_project(app_client):
    response = await app_client.post(
        "/boundaries",
        json={
            "project_id": "no-such-project",
            "root_authentik_team_id": "team",
            "effective_from": "2026-09-01",
        },
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# CI assessment routes (LLM disabled — the deterministic scorer runs)
# ---------------------------------------------------------------------------


def _ci_payload(commit_sha: str = "abc123", **evidence_overrides):
    evidence = {
        "project_id": "member-portal",
        "commit_sha": commit_sha,
        "branch": "main",
        "expected_week": 3,
        "changed_files": ["src/core-flow.ts", "tests/core-flow.test.ts"],
        "tests_total": 12,
        "tests_passed": 12,
        "tests_failed": 0,
        "coverage_pct": 88,
        "check_results": [{"name": "required-checks", "status": "passed"}],
        "scope_change_count": 1,
        "docs_updated": True,
    }
    evidence.update(evidence_overrides)
    return {
        "project_id": "member-portal",
        "spec": {
            "project_id": "member-portal",
            "version": "appdev-plan-v1",
            "lifecycle_weeks": 12,
            "weeks": [
                {
                    "week": 3,
                    "title": "Core milestone",
                    "milestone": "Core flow ready for review",
                    "tasks": ["Implement the core user flow"],
                    "acceptance_criteria": ["Primary flow is testable"],
                    "artifacts": ["Milestone notes"],
                }
            ],
        },
        "evidence": evidence,
    }


async def test_submit_ci_assessment_creates_an_assessment(app_client):
    response = await app_client.post("/ci/assessments", json=_ci_payload())

    assert response.status_code == 201
    body = response.json()
    assert body["idempotent"] is False
    assessment = body["assessment"]
    assert assessment["project_id"] == "member-portal"
    assert assessment["commit_sha"] == "abc123"
    assert 0 <= assessment["score"] <= 100


async def test_submit_ci_assessment_is_idempotent_per_commit(app_client):
    first = await app_client.post("/ci/assessments", json=_ci_payload())
    second = await app_client.post("/ci/assessments", json=_ci_payload())

    assert first.json()["idempotent"] is False
    assert second.json()["idempotent"] is True
    assert (
        first.json()["assessment"]["assessment_id"]
        == second.json()["assessment"]["assessment_id"]
    )


async def test_ci_evidence_route_is_an_alias(app_client):
    response = await app_client.post("/ci/evidence", json=_ci_payload("def456"))
    assert response.status_code == 201


async def test_submit_ci_assessment_422_on_project_id_mismatch(app_client):
    payload = _ci_payload()
    payload["evidence"]["project_id"] = "campus-events"

    response = await app_client.post("/ci/assessments", json=payload)
    assert response.status_code == 422
    assert "does not match" in response.json()["detail"]


async def test_submit_ci_assessment_404_for_unknown_project(app_client):
    payload = _ci_payload()
    payload["project_id"] = "no-such-project"
    payload["evidence"]["project_id"] = "no-such-project"

    assert (await app_client.post("/ci/assessments", json=payload)).status_code == 404


async def test_submit_ci_assessment_422_for_an_unparseable_spec(app_client):
    payload = _ci_payload()
    payload["spec"] = {"project_id": "member-portal", "weeks": "not-a-list"}

    assert (await app_client.post("/ci/assessments", json=payload)).status_code == 422


async def test_submit_ci_evidence_rejects_identities_in_the_narrative(app_client):
    payload = _ci_payload("ghi789", progress_summary="Great work by @ada this week")

    response = await app_client.post("/ci/assessments", json=payload)
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# assessment read routes
# ---------------------------------------------------------------------------


async def test_project_assessments_list(app_client):
    response = await app_client.get("/projects/member-portal/assessments")

    assert response.status_code == 200
    body = response.json()
    assert body["project_id"] == "member-portal"
    assert len(body["assessments"]) >= 1


async def test_latest_project_assessment(app_client):
    response = await app_client.get("/projects/member-portal/assessments/latest")

    assert response.status_code == 200
    assert response.json()["assessment"] is not None


async def test_latest_project_assessment_404_for_unknown_project(app_client):
    assert (
        await app_client.get("/projects/nope/assessments/latest")
    ).status_code == 404


async def test_project_weekly_tasks(app_client):
    response = await app_client.get("/projects/member-portal/weekly-tasks")

    assert response.status_code == 200
    body = response.json()
    assert body["project_id"] == "member-portal"
    assert body["week"] == 3
    assert isinstance(body["tasks"], list)


async def test_project_weekly_tasks_for_a_week_without_an_assessment(app_client):
    body = (
        await app_client.get(
            "/projects/member-portal/weekly-tasks", params={"week": 9}
        )
    ).json()
    assert body["week"] == 9
    assert body["tasks"] == []


@pytest.mark.parametrize("week", [0, 53])
async def test_project_weekly_tasks_422_for_out_of_range_weeks(app_client, week):
    response = await app_client.get(
        "/projects/member-portal/weekly-tasks", params={"week": week}
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# POST /projects/{id}/spec/decompose  (falls back to Markdown when LLM is off)
# ---------------------------------------------------------------------------


async def test_decompose_spec_without_an_llm_parses_markdown(app_client):
    context = (
        "# Member Portal\n"
        "## Week 1: Kickoff\n"
        "- Agree the project boundary\n"
        "## Week 2: Core flow\n"
        "- Implement the core user flow\n"
    )
    response = await app_client.post(
        "/projects/member-portal/spec/decompose",
        json={"context": context, "lifecycle_weeks": 12},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["project_id"] == "member-portal"
    assert body["llm_generated"] is False
    assert body["lifecycle_weeks"] == 12
    assert body["chunk_count"] >= 1
    assert body["spec"]["chunks"]


async def test_decompose_spec_404_for_unknown_project(app_client):
    response = await app_client.post(
        "/projects/nope/spec/decompose", json={"context": "# Plan\n## Week 1: Go\n- do"}
    )
    assert response.status_code == 404


async def test_decompose_spec_422_for_an_empty_context(app_client):
    response = await app_client.post(
        "/projects/member-portal/spec/decompose", json={"context": ""}
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# routing
# ---------------------------------------------------------------------------


async def test_unknown_route_is_404(app_client):
    assert (await app_client.get("/does-not-exist")).status_code == 404


async def test_feedback_rejects_get(app_client):
    assert (await app_client.get("/feedback")).status_code == 405
