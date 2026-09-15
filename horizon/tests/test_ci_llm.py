"""Tests for the LLM enrichment layer over the deterministic CI assessment.

These cover the two properties the architecture depends on — the LLM can only
worsen a verdict, and every surviving blocker is citation-grounded — plus the
prompt-shaping helpers that feed the model.
"""

from __future__ import annotations

from typing import Any

import pytest

from backend.ci_agent import (
    AssessmentStatus,
    CIEvidence,
    assess_project,
    expected_chunks,
    normalize_spec,
)
from backend.ci_llm import (
    LLMAssessor,
    assess_project_llm,
    build_fact_table,
    reconcile,
    render_facts,
)
from backend.llm import LLMUnavailable

SPEC_PAYLOAD: dict[str, Any] = {
    "project_id": "proj",
    "version": "spec-v1",
    "lifecycle_weeks": 12,
    "weeks": [
        {
            "week_start": 3,
            "week_end": 3,
            "title": "Ingestion slice",
            "milestone": "Live ingestion adapter",
            "tasks": ["Add webhook retry with backoff", "Normalise activity events"],
            "acceptance_criteria": ["Webhook retries survive an outage"],
            "required_artifacts": ["backend/ingestion.py"],
        }
    ],
}


def _spec():
    return normalize_spec(SPEC_PAYLOAD, project_id="proj")


def _evidence(**overrides: Any) -> CIEvidence:
    payload: dict[str, Any] = {
        "project_id": "proj",
        "commit_sha": "abc123",
        "expected_week": 3,
        "changed_files": ["backend/ingestion.py"],
        "tests_total": 40,
        "tests_passed": 40,
        "tests_failed": 0,
        "coverage_pct": 85.0,
        "deploy_status": "passed",
        "milestone_refs": ["live-ingestion"],
        "acceptance_criteria_refs": ["Webhook retries survive an outage"],
        "artifact_refs": ["backend/ingestion.py"],
    }
    payload.update(overrides)
    return CIEvidence.model_validate(payload)


def _table(evidence: CIEvidence):
    spec = _spec()
    return build_fact_table(spec, evidence, expected_chunks(spec, evidence))


class _StubLLM:
    """Returns a canned proposal, or raises, to exercise both enrichment paths."""

    def __init__(self, proposal: dict[str, Any] | None = None, *, fail: bool = False):
        self.proposal = proposal or {}
        self.fail = fail
        self.calls: list[dict[str, Any]] = []

    async def call_tool(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if self.fail:
            raise LLMUnavailable("provider down")
        return self.proposal


# --- fact table -------------------------------------------------------------


def test_fact_table_records_absence_and_gaps() -> None:
    table = _table(_evidence(acceptance_criteria_refs=[], artifact_refs=[]))
    assert "no linked evidence" in table["ci:acceptance_gap"].excerpt
    assert "backend/ingestion.py" in table["ci:artifact_gap"].excerpt


def test_acceptance_gap_reports_closure_when_all_linked() -> None:
    table = _table(_evidence())
    assert "has linked evidence" in table["ci:acceptance_gap"].excerpt
    assert "ci:artifact_gap" not in table


def test_progress_summary_is_redacted_in_the_fact_table() -> None:
    # model_construct bypasses the ingestion validator that normally rejects this.
    evidence = _evidence().model_construct(
        **{**_evidence().model_dump(), "progress_summary": "ping @alice about the retry"}
    )
    table = _table(evidence)
    assert "@alice" not in table["ci:progress_summary"].excerpt
    assert "[REDACTED]" in table["ci:progress_summary"].excerpt


def test_render_facts_omits_the_redundant_source_field_column() -> None:
    table = _table(_evidence())
    line = next(
        ln for ln in render_facts(table).splitlines() if ln.startswith("ci:coverage_pct")
    )
    # id | excerpt, not id | field | excerpt
    assert line.count("|") == 1
    # the field is still carried for citation resolution
    assert table["ci:coverage_pct"].source_field == "coverage_pct"


# --- reconcile safety invariants -------------------------------------------


def test_llm_cannot_improve_a_failing_verdict() -> None:
    evidence = _evidence(tests_failed=20, tests_passed=20, coverage_pct=20.0,
                         deploy_status="failed", milestone_refs=[])
    baseline = assess_project(_spec(), evidence)
    assert baseline.status is AssessmentStatus.AT_RISK

    merged = reconcile(
        baseline,
        {
            "status": "clear",
            "score": 100,
            "summary": "Everything shipped.",
            "blockers": [],
            "recommendations": [],
            "weekly_tasks": [],
        },
        _table(evidence),
    )
    assert merged.status is AssessmentStatus.AT_RISK
    assert merged.score <= baseline.score


def test_llm_may_worsen_a_clear_verdict() -> None:
    evidence = _evidence()
    baseline = assess_project(_spec(), evidence)
    merged = reconcile(
        baseline,
        {
            "status": "at_risk",
            "score": 30,
            "summary": "Coverage is trending down.",
            "blockers": [
                {"text": "Coverage is slipping.", "impact": "Milestone at risk.",
                 "fact_ids": ["ci:coverage_pct"]}
            ],
            "recommendations": [],
            "weekly_tasks": [],
        },
        _table(evidence),
    )
    assert merged.status is AssessmentStatus.AT_RISK
    assert merged.score == 30


@pytest.mark.parametrize("score", [-1, 101, float("nan"), True, "20"])
def test_out_of_contract_score_is_rejected(score):
    evidence = _evidence()
    with pytest.raises(LLMUnavailable):
        reconcile(assess_project(_spec(), evidence), {"status": "watch", "score": score, "summary": "s"}, _table(evidence))


def test_uncited_penalty_does_not_change_status_or_score():
    evidence = _evidence()
    baseline = assess_project(_spec(), evidence)
    merged = reconcile(baseline, {"status": "at_risk", "score": 0, "summary": "unsupported", "blockers": []}, _table(evidence))
    assert merged.status == baseline.status
    assert merged.score == baseline.score


def test_blocker_impact_is_folded_into_the_stored_string() -> None:
    evidence = _evidence()
    merged = reconcile(
        assess_project(_spec(), evidence),
        {
            "status": "watch", "score": 60, "summary": "s",
            "blockers": [
                {"text": "Coverage is slipping.", "impact": "Week-3 milestone at stake.",
                 "fact_ids": ["ci:coverage_pct"]}
            ],
            "recommendations": [], "weekly_tasks": [],
        },
        _table(evidence),
    )
    assert merged.blockers == [
        "Coverage is slipping. Impact: Week-3 milestone at stake."
    ]


def test_uncited_blockers_are_dropped() -> None:
    evidence = _evidence()
    baseline = assess_project(_spec(), evidence)
    merged = reconcile(
        baseline,
        {
            "status": "watch", "score": 70, "summary": "s",
            "blockers": [
                {"text": "Vibes are off.", "impact": "x", "fact_ids": []},
                {"text": "Coverage is slipping.", "impact": "y",
                 "fact_ids": ["ci:coverage_pct"]},
            ],
            "recommendations": [], "weekly_tasks": [],
        },
        _table(evidence),
    )
    assert not any("Vibes" in b for b in merged.blockers)


def test_unknown_fact_id_is_rejected() -> None:
    evidence = _evidence()
    with pytest.raises(LLMUnavailable):
        reconcile(
            assess_project(_spec(), evidence),
            {
                "status": "watch", "score": 70, "summary": "s",
                "blockers": [{"text": "t", "impact": "i",
                              "fact_ids": ["ci:invented_metric"]}],
                "recommendations": [], "weekly_tasks": [],
            },
            _table(evidence),
        )


@pytest.mark.parametrize(
    "proposal_patch",
    [
        {"summary": "ask @alice to fix it"},
        {"blockers": [{"text": "t", "impact": "ping @bob", "fact_ids": ["ci:coverage_pct"]}]},
        {"recommendations": ["email dev@example.com"]},
        {"weekly_tasks": ["Co-authored-by: someone"]},
    ],
)
def test_identity_markers_anywhere_in_the_output_are_rejected(proposal_patch) -> None:
    evidence = _evidence()
    proposal: dict[str, Any] = {
        "status": "watch", "score": 70, "summary": "s",
        "blockers": [], "recommendations": [], "weekly_tasks": [],
    }
    proposal.update(proposal_patch)
    with pytest.raises(LLMUnavailable):
        reconcile(assess_project(_spec(), evidence), proposal, _table(evidence))


def test_fact_ids_leaked_into_prose_are_scrubbed() -> None:
    evidence = _evidence()
    merged = reconcile(
        assess_project(_spec(), evidence),
        {
            "status": "watch", "score": 70,
            "summary": "Coverage per ci:coverage_pct is low.",
            "blockers": [],
            "recommendations": ["Raise coverage to close ci:coverage_pct."],
            "weekly_tasks": [],
        },
        _table(evidence),
    )
    assert "ci:coverage_pct" not in merged.summary
    assert "coverage_pct" in merged.summary
    assert not any("ci:" in r for r in merged.recommendations)


def test_weekly_tasks_strip_the_render_prefix_and_dedupe() -> None:
    evidence = _evidence()
    baseline = assess_project(_spec(), evidence)
    merged = reconcile(
        baseline,
        {
            "status": "watch", "score": 70, "summary": "s", "blockers": [],
            "recommendations": [],
            # the model copies the excerpt prefix along with the plan wording
            "weekly_tasks": ["[w3 task] Add webhook retry with backoff"],
        },
        _table(evidence),
    )
    assert "Add webhook retry with backoff" in merged.weekly_tasks
    assert not any(t.startswith("[w3") for t in merged.weekly_tasks)
    assert len(merged.weekly_tasks) == len(set(merged.weekly_tasks))


# --- end-to-end enrichment path --------------------------------------------


@pytest.mark.asyncio
async def test_llm_failure_returns_the_baseline_unchanged() -> None:
    evidence = _evidence()
    baseline = assess_project(_spec(), evidence)
    assessor = LLMAssessor(_StubLLM(fail=True), model="test-model")
    result = await assess_project_llm(_spec(), evidence, assessor=assessor)
    assert result == baseline


@pytest.mark.asyncio
async def test_policy_states_never_reach_the_llm() -> None:
    evidence = _evidence(planned_pause=True)
    stub = _StubLLM({"status": "at_risk", "score": 0, "summary": "x",
                     "blockers": [], "recommendations": [], "weekly_tasks": []})
    result = await assess_project_llm(
        _spec(), evidence, assessor=LLMAssessor(stub, model="test-model")
    )
    assert result.status is AssessmentStatus.PLANNED_PAUSE
    assert stub.calls == []


@pytest.mark.asyncio
async def test_prompt_carries_no_duplicate_plan_block() -> None:
    evidence = _evidence()
    stub = _StubLLM({"status": "watch", "score": 70, "summary": "s",
                     "blockers": [], "recommendations": [], "weekly_tasks": []})
    await assess_project_llm(
        _spec(), evidence, assessor=LLMAssessor(stub, model="test-model")
    )
    user = stub.calls[0]["user"]
    # the plan and the narrative live in the fact table only
    assert "<project_plan" not in user
    assert "<progress_summary>" not in user
    assert "<evidence" in user
    # every plan item is still present, and citable
    assert user.count("Add webhook retry with backoff") == 1
