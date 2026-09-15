"""Recruiting pipeline tests.

The endpoint contract is intentionally reviewer-oriented: AI output is
provisional, source evidence is inspectable, and a final review is an
explicit write with an audit trail.
"""

from __future__ import annotations

from backend.config import Settings
from backend.member_analytics import ingest_payload
from backend.recruiting import classify_outreach_eligibility, normalize_people_portal_payload, _attach_shared_ranking, _signal_for_candidate, _stats_from_payload


def stats_payload() -> dict:
    return {
        "generated_at": "2026-08-31T14:30:00+00:00",
        "gitea_url": "https://gitea.example.test",
        "history_scope": "all member activity",
        "members": [
            {
                "login": "alex-r",
                "name": "Alex Rivera",
                "email": "alex@example.test",
                "roster_member": True,
                "commits": 55,
                "unique_files": 120,
                "pulls_opened": 22,
                "pulls_merged": 18,
                "reviews_submitted": 22,
                "reviews_approved": 18,
                "issues_opened": 6,
                "active_days": 48,
                "blame_lines": 1200,
                "repositories": ["member-portal", "design-system", "onboarding"],
            },
            {
                "login": "jordan-k",
                "name": "Jordan Kim",
                "email": "jordan@example.test",
                "roster_member": True,
                "commits": 18,
                "unique_files": 48,
                "pulls_opened": 8,
                "pulls_merged": 5,
                "reviews_submitted": 9,
                "reviews_approved": 7,
                "issues_opened": 2,
                "active_days": 24,
                "blame_lines": 500,
                "repositories": ["campus-events"],
            },
            {
                "login": "casey-l",
                "name": "Casey Lee",
                "email": "casey@example.test",
                "roster_member": True,
                "repositories": [],
            },
        ],
    }


def test_unavailable_gitea_activity_stays_unknown_in_recruiting_source():
    stats = _stats_from_payload({
        "member_stats": {
            "commits": None,
            "pulls_merged": None,
            "pulls_merged_contributed_to": None,
            "reviews_submitted": None,
            "commit_stats_status": "partial",
        }
    })

    assert stats.commits is None
    assert stats.pulls_merged is None
    assert stats.pulls_merged_contributed_to is None
    assert stats.reviews_submitted is None


def test_shared_ranking_uses_exact_artifact_rank_and_components():
    _, candidates = normalize_people_portal_payload({
        "generated_at": "2026-08-31T14:30:00+00:00",
        "source_run_id": "people-source-1",
        "candidates": [{
            "member_login": "alex-r",
            "member_name": "Alex Rivera",
            "email": "alex@example.test",
        }],
    })
    _attach_shared_ranking(candidates, {
        "pipeline_run_id": "20260908T050825Z",
        "artifact_sha256": "a" * 64,
        "export_manifest_sha256": "b" * 64,
        "ranking_status": "current_provisional",
        "rubric_version": "leadership-weighted-35-35-30-v1",
        "rows": [{
            "person_id": "alex@example.test",
            "member_username": "alex-r",
            "combined_rank": 7,
            "technical_execution_score": 4.5,
            "technical_leadership_score": 3.5,
            "club_contribution_score": 2.5,
            "combined_score": 3.5,
            "human_review_required": True,
        }],
    }, source_run_id="people-source-1-ranking-aaaaaaaaaaaa")

    signal = _signal_for_candidate(candidates[0], candidates, gitea_run_id=None)
    assert signal.provisional_rank == 7
    assert signal.provisional_score == 70.0
    assert signal.score_breakdown == {
        "technical_execution": 90.0,
        "technical_leadership": 70.0,
        "club_contribution": 50.0,
        "shared_combined_score": 70.0,
    }
    assert signal.resume_score is None
    assert signal.interview_score is None


async def create_stats_only_run(client) -> str:
    await ingest_payload(stats_payload())
    response = await client.post("/recruiting/run")
    assert response.status_code == 200
    return response.json()["run"]["run_id"]


async def test_recruiting_overview_uses_stats_only_and_exposes_policy(empty_app_client):
    run_id = await create_stats_only_run(empty_app_client)
    response = await empty_app_client.get("/recruiting/overview", params={"run_id": run_id})

    assert response.status_code == 200
    body = response.json()
    # Empty roster rows stay in the member analytics audit, but they are not
    # eligible for a recruiting rank without club or People Portal evidence.
    assert body["summary"]["candidate_count"] == 3
    assert body["summary"]["reviewed_count"] == 0
    assert body["policy"]["excluded_from_score"]
    assert body["candidates"][0]["member_login"] == "alex-r"
    assert body["summary"]["underrated_count"] == 2
    assert body["candidates"][-1]["provisional_score"] is None
    assert body["candidates"][-1]["provisional_rank"] is None
    assert body["candidates"][0]["source_status"] == "missing"
    assert body["candidates"][0]["resume_evidence_count"] == 0
    assert body["run"]["people_portal_source_run_id"] is None
    assert "casey-l" in {candidate["member_login"] for candidate in body["candidates"]}


async def test_recruiting_detail_contains_stats_and_no_people_portal_evidence(empty_app_client):
    run_id = await create_stats_only_run(empty_app_client)
    response = await empty_app_client.get("/recruiting/candidates/alex-r", params={"run_id": run_id})

    assert response.status_code == 200
    candidate = response.json()["candidate"]
    assert candidate["member_stats"]["pulls_merged"] == 18
    assert candidate["resume"]["evidence"] == []
    assert candidate["interview"]["evidence"] == []
    assert candidate["context_excluded_from_score"]["prior_employers"] == []
    assert all(ref["source_type"] == "gitea_member_analytics" for ref in candidate["evidence_refs"])
    assert candidate["evidence_claims"] == []
    assert candidate["review_history"] == []


async def test_recruiting_audit_reports_coverage_and_calibration(empty_app_client):
    run_id = await create_stats_only_run(empty_app_client)
    response = await empty_app_client.get("/recruiting/audit", params={"run_id": run_id})

    assert response.status_code == 200
    audit = response.json()["audit"]
    assert audit["coverage"]["candidate_count"] == 3
    assert audit["coverage"]["with_observable_stats"] == 2
    assert audit["coverage"]["reviewed_candidates"] == 0
    assert audit["calibration"]["reviewer_count"] == 0
    assert audit["calibration"]["multi_reviewer_candidates"] == 0
    assert any("second reviewer" in flag.lower() for flag in audit["flags"])

    review_response = await empty_app_client.post(
        "/recruiting/reviews",
        json={
            "run_id": run_id,
            "member_login": "alex-r",
            "decision": "confirm",
            "note": "Reviewed source-backed contribution evidence.",
        },
    )
    assert review_response.status_code == 201
    after_review = (await empty_app_client.get("/recruiting/audit", params={"run_id": run_id})).json()["audit"]
    assert after_review["coverage"]["reviewed_candidates"] == 1
    assert after_review["calibration"]["review_count"] == 1
    assert after_review["recent_reviews"][0]["member_login"] == "alex-r"


async def test_recruiting_review_requires_reason_for_adjustment(empty_app_client):
    run_id = await create_stats_only_run(empty_app_client)
    response = await empty_app_client.post(
        "/recruiting/reviews",
        json={
            "run_id": run_id,
            "member_login": "alex-r",
            "decision": "adjust",
            "final_rank": 2,
        },
    )

    assert response.status_code == 422
    assert "note is required" in response.json()["detail"]


async def test_recruiting_review_can_be_made_fail_closed_with_reviewer_auth(empty_app_client, monkeypatch):
    run_id = await create_stats_only_run(empty_app_client)
    monkeypatch.setattr(
        "backend.auth.get_settings",
        lambda: Settings(
            sqlite_path=":memory:",
            environment="test",
            require_recruiting_review_auth=True,
            recruiting_review_token="review-secret",
        ),
    )
    unauthenticated = await empty_app_client.post(
        "/recruiting/reviews",
        json={"run_id": run_id, "member_login": "alex-r", "decision": "confirm"},
    )
    assert unauthenticated.status_code == 401
    authenticated = await empty_app_client.post(
        "/recruiting/reviews",
        headers={"Authorization": "Bearer review-secret", "X-Reviewer-Id": "reviewer-1"},
        json={
            "run_id": run_id,
            "member_login": "alex-r",
            "decision": "confirm",
            "eligibility_decision": "eligible",
            "note": "Reviewed source-backed evidence.",
        },
    )
    assert authenticated.status_code == 201
    assert authenticated.json()["review"]["reviewer_user_id"] == "reviewer-1"


async def test_recruiting_review_updates_signal_run_and_audit(empty_app_client):
    run_id = await create_stats_only_run(empty_app_client)
    response = await empty_app_client.post(
        "/recruiting/reviews",
        json={
            "run_id": run_id,
            "member_login": "alex-r",
            "decision": "confirm",
            "eligibility_decision": "eligible",
            "final_rank": 1,
            "note": "Verified the contribution and resume evidence against the source records.",
        },
    )

    assert response.status_code == 201
    assert response.json()["candidate"]["review_status"] == "confirmed"
    overview = (await empty_app_client.get("/recruiting/overview", params={"run_id": run_id})).json()
    assert overview["summary"]["reviewed_count"] == 1
    assert overview["summary"]["confirmed_count"] == 1
    shortlist = (await empty_app_client.get("/recruiting/shortlist", params={"run_id": run_id})).json()
    assert shortlist["ready"] is True
    assert shortlist["candidates"][0]["member_login"] == "alex-r"
    audit = (await empty_app_client.get("/audit")).json()
    assert any(row["action"] == "recruiting.review.created" for row in audit)


def test_employer_context_does_not_change_signal_score():
    base = {
        "generated_at": "2026-08-31T14:30:00+00:00",
        "candidates": [
            {
                "member_login": "engineer",
                "member_name": "Engineer",
                "member_stats": {"commits": 10, "pulls_merged": 4, "reviews_submitted": 5, "active_days": 12, "repositories": ["repo"]},
                "interview": {"score": 4, "evidence": ["Explained testing tradeoffs."]},
                "resume": {"impact_bullets": ["Built and shipped a useful workflow."]},
            }
        ],
    }
    _, first = normalize_people_portal_payload({**base, "candidates": [{**base["candidates"][0], "prior_employers": ["Google"]}]})
    _, second = normalize_people_portal_payload({**base, "candidates": [{**base["candidates"][0], "prior_employers": ["Mitsubishi Electric"]}]})
    first_signal = _signal_for_candidate(first[0], first, gitea_run_id=None)
    second_signal = _signal_for_candidate(second[0], second, gitea_run_id=None)

    assert first_signal.provisional_score == second_signal.provisional_score
    assert first_signal.contribution_score == second_signal.contribution_score
    assert first_signal.resume_score == second_signal.resume_score


def test_llm_evidence_output_cannot_override_numeric_signal_components():
    payload = {
        "generated_at": "2026-08-31T14:30:00+00:00",
        "candidates": [
            {
                "member_login": "engineer",
                "member_name": "Engineer",
                "member_stats": {"commits": 10, "pulls_merged": 4, "reviews_submitted": 5, "active_days": 12, "repositories": ["repo"]},
            }
        ],
    }
    _, candidates = normalize_people_portal_payload(payload)
    baseline = _signal_for_candidate(candidates[0], candidates, gitea_run_id=None)
    organized = _signal_for_candidate(
        candidates[0],
        candidates,
        gitea_run_id=None,
        llm_result={
            "contribution_score": 0,
            "resume_score": 100,
            "interview_score": 100,
            "rationale": "Evidence summary only.",
            "strengths": [],
            "caveats": [],
            "evidence_claims": [{
                "source_field": "member_stats",
                "claim": "The source contains contribution metrics.",
                "supporting_text": "commits=10",
            }],
        },
    )

    assert organized.provisional_score == baseline.provisional_score
    assert organized.contribution_score == baseline.contribution_score
    assert organized.resume_score == baseline.resume_score
    assert organized.interview_score == baseline.interview_score
    assert organized.evidence_claims == []  # Fabricated supporting text is rejected.


def test_outreach_eligibility_requires_review_for_all_employers():
    status, reasons = classify_outreach_eligibility(["Google"])
    assert status.value == "needs_review"
    assert any("google" in reason.lower() for reason in reasons)

    status, reasons = classify_outreach_eligibility(["Apex Fund (quantitative trading role)"])
    assert status.value == "needs_review"
    assert any("quant" in reason.lower() for reason in reasons)

    status, reasons = classify_outreach_eligibility(["Mitsubishi Electric"])
    assert status.value == "needs_review"
    assert reasons


def test_people_portal_rows_are_deduplicated_by_email_without_summing_gitea_stats():
    _, documents = normalize_people_portal_payload(
        {
            "generated_at": "2026-08-31T14:30:00+00:00",
            "candidates": [
                {
                    "member_login": "first-login",
                    "member_name": "Same Person",
                    "email": "same@example.test",
                    "member_stats": {"commits": 4, "repositories": ["one"]},
                    "resume": {"impact_bullets": ["Built one system."]},
                },
                {
                    "member_login": "second-login",
                    "member_name": "Same Person",
                    "email": "SAME@example.test",
                    "member_stats": {"commits": 9, "repositories": ["two"]},
                    "interview": {"score": 4, "evidence": ["Explained tradeoffs."]},
                },
            ],
        }
    )
    assert len(documents) == 1
    assert documents[0].member_stats.commits == 9
    assert documents[0].member_stats.repositories == ["one", "two"]
    assert documents[0].resume_evidence == ["Built one system."]
    assert documents[0].interview_evidence == ["Explained tradeoffs."]
