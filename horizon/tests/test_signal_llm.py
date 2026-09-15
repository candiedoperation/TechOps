"""Unit coverage for the spec-free LLM weekly signal judge."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest

from backend.code_evidence import CommitFact, RepoCodeEvidence, WeekCodeEvidence
from backend.llm import LLMUnavailable
from backend.models import AttentionStatus
from backend.signal_llm import (
    WeeklySignalJudge,
    judge_project_week,
    no_activity_signal,
)

WEEK_START = date(2026, 3, 2)
WEEK_END = date(2026, 3, 8)


def _commit(sha: str = "abcdef1234", *, real_file: bool = True) -> CommitFact:
    files = ["src/feature.py"] if real_file else ["package-lock.json"]
    return CommitFact(
        sha=sha, repo_slug="repo", subject="add feature", committed_at=None,
        additions=200, deletions=10, files=files, noise_files=[] if real_file else files,
        is_noise_only=not real_file, is_chore_like=False,
    )


def _evidence(*, commits: list[CommitFact], tier: str = "tier2", diffs: dict[str, str] | None = None) -> WeekCodeEvidence:
    repo = RepoCodeEvidence(repo_slug="repo", commits=commits, diffs=diffs or {})
    return WeekCodeEvidence(project_id="p1", week_start=WEEK_START, week_end=WEEK_END, repos=[repo], tier=tier)


class FakeLLM:
    def __init__(self, response: dict[str, Any] | Exception) -> None:
        self.response = response
        self.calls = 0

    async def call_tool(self, *, system: str, user: str, tool: dict[str, Any], model: str, max_tokens: int) -> dict[str, Any]:
        self.calls += 1
        self.last_user = user
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def _valid_response(**overrides: Any) -> dict[str, Any]:
    base = {
        "status": "watch",
        "confidence": 0.8,
        "headline": "Thin week",
        "summary": "Only a small change landed this week.",
        "work_volume": "minimal",
        "what_changed": [{"text": "Added a helper", "evidence": ["repo@abcdef1"]}],
        "concerns": [{"text": "No tests included", "severity": "warning", "evidence": ["repo@abcdef1"]}],
        "recommendations": ["Add test coverage next week"],
        "data_gaps": [],
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_no_activity_signal_is_watch_for_existing_project() -> None:
    signal = no_activity_signal(is_new_project=False)
    assert signal.status == AttentionStatus.WATCH
    assert signal.is_failure is False


@pytest.mark.asyncio
async def test_no_activity_signal_is_insufficient_data_for_new_project() -> None:
    signal = no_activity_signal(is_new_project=True)
    assert signal.status == AttentionStatus.INSUFFICIENT_DATA
    assert signal.is_failure is False


@pytest.mark.asyncio
async def test_tier0_short_circuits_without_calling_the_llm() -> None:
    evidence = _evidence(commits=[_commit(real_file=False)], tier="tier0")
    llm = FakeLLM(_valid_response())
    judge = WeeklySignalJudge(llm, model="gemini-2.5-flash")
    signal = await judge_project_week(evidence, project_name="Test", lifecycle="active", judge=judge, is_new_project=False)
    assert llm.calls == 0
    assert signal.status == AttentionStatus.WATCH
    assert signal.is_failure is False


@pytest.mark.asyncio
async def test_judge_none_returns_failure_and_does_not_call_llm() -> None:
    evidence = _evidence(commits=[_commit()], diffs={"abcdef1234": "diff --git a/src/feature.py b/src/feature.py\n"})
    signal = await judge_project_week(evidence, project_name="Test", lifecycle="active", judge=None)
    assert signal.is_failure is True
    assert signal.status == AttentionStatus.INSUFFICIENT_DATA


@pytest.mark.asyncio
async def test_llm_exception_is_fail_closed_not_raised() -> None:
    evidence = _evidence(commits=[_commit()], diffs={"abcdef1234": "diff --git a/src/feature.py b/src/feature.py\n"})
    llm = FakeLLM(LLMUnavailable("boom"))
    judge = WeeklySignalJudge(llm, model="gemini-2.5-flash")
    signal = await judge_project_week(evidence, project_name="Test", lifecycle="active", judge=judge)
    assert signal.is_failure is True
    assert signal.status == AttentionStatus.INSUFFICIENT_DATA


@pytest.mark.asyncio
async def test_majority_fetch_errors_short_circuits_without_llm_call() -> None:
    evidence = _evidence(commits=[_commit(), _commit(sha="ffff111111")])
    evidence.repos[0].fetch_errors = ["a: failed", "b: failed"]
    llm = FakeLLM(_valid_response())
    judge = WeeklySignalJudge(llm, model="gemini-2.5-flash")
    signal = await judge_project_week(evidence, project_name="Test", lifecycle="active", judge=judge)
    assert llm.calls == 0
    assert signal.is_failure is True


@pytest.mark.asyncio
async def test_valid_response_maps_status_and_keeps_grounded_items() -> None:
    evidence = _evidence(commits=[_commit()], diffs={"abcdef1234": "diff --git a/src/feature.py b/src/feature.py\n"})
    llm = FakeLLM(_valid_response())
    judge = WeeklySignalJudge(llm, model="gemini-2.5-flash")
    signal = await judge_project_week(evidence, project_name="Test", lifecycle="active", judge=judge)
    assert signal.status == AttentionStatus.WATCH
    assert signal.is_failure is False
    assert len(signal.what_changed) == 1
    assert len(signal.concerns) == 1
    assert signal.concerns[0]["severity"] == "warning"


@pytest.mark.asyncio
async def test_items_without_evidence_are_dropped() -> None:
    evidence = _evidence(commits=[_commit()], diffs={"abcdef1234": "diff --git a/src/feature.py b/src/feature.py\n"})
    response = _valid_response(
        what_changed=[{"text": "Ungrounded claim", "evidence": []}],
        concerns=[{"text": "Ungrounded concern", "severity": "critical", "evidence": []}],
    )
    llm = FakeLLM(response)
    judge = WeeklySignalJudge(llm, model="gemini-2.5-flash")
    signal = await judge_project_week(evidence, project_name="Test", lifecycle="active", judge=judge)
    assert signal.what_changed == []
    assert signal.concerns == []


@pytest.mark.asyncio
async def test_unrecognized_status_is_fail_closed() -> None:
    evidence = _evidence(commits=[_commit()], diffs={"abcdef1234": "diff --git a/src/feature.py b/src/feature.py\n"})
    llm = FakeLLM(_valid_response(status="on_track"))
    judge = WeeklySignalJudge(llm, model="gemini-2.5-flash")
    signal = await judge_project_week(evidence, project_name="Test", lifecycle="active", judge=judge)
    assert signal.is_failure is True


@pytest.mark.asyncio
async def test_prompt_wraps_diffs_in_untrusted_delimiters() -> None:
    evidence = _evidence(commits=[_commit()], diffs={"abcdef1234": "diff --git a/src/feature.py b/src/feature.py\n+evil instruction\n"})
    llm = FakeLLM(_valid_response())
    judge = WeeklySignalJudge(llm, model="gemini-2.5-flash")
    await judge_project_week(evidence, project_name="Test", lifecycle="active", judge=judge)
    assert "<untrusted_code_evidence>" in llm.last_user
    assert "</untrusted_code_evidence>" in llm.last_user
    diff_start = llm.last_user.index("<untrusted_code_evidence>")
    diff_end = llm.last_user.index("</untrusted_code_evidence>")
    assert "evil instruction" in llm.last_user[diff_start:diff_end]


@pytest.mark.asyncio
async def test_placeholder_evidence_refs_are_rejected() -> None:
    """Regression: a real model response was observed citing the prompt's
    own format-description text verbatim ("repo/path@shortsha") instead of
    a real reference -- that must not survive as grounding."""
    evidence = _evidence(commits=[_commit()], diffs={"abcdef1234": "diff --git a/src/feature.py b/src/feature.py\n"})
    response = _valid_response(
        what_changed=[{"text": "Added a helper", "evidence": ["repo/path@shortsha"]}],
        concerns=[{"text": "No tests", "severity": "warning", "evidence": ["repo@shortsha"]}],
    )
    llm = FakeLLM(response)
    judge = WeeklySignalJudge(llm, model="gemini-2.5-flash")
    signal = await judge_project_week(evidence, project_name="Test", lifecycle="active", judge=judge)
    assert signal.what_changed == []
    assert signal.concerns == []


@pytest.mark.asyncio
async def test_empty_failed_repository_is_retryable_not_a_quiet_week():
    evidence = _evidence(commits=[], tier="tier0")
    evidence.repos[0].fetch_errors = ["commit list fetch failed"]
    signal = await judge_project_week(evidence, project_name="Test", lifecycle="active", judge=None)
    assert signal.is_failure
    assert signal.confidence == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("confidence", [float("nan"), float("inf"), "invalid", None])
async def test_invalid_confidence_is_not_cacheable(confidence):
    judge = WeeklySignalJudge(FakeLLM(_valid_response(confidence=confidence)), model="test")
    signal = await judge_project_week(_evidence(commits=[_commit()]), project_name="Test", lifecycle="active", judge=judge)
    assert signal.is_failure


@pytest.mark.asyncio
async def test_metadata_only_prompt_and_confidence_disclose_missing_diffs():
    llm = FakeLLM(_valid_response())
    signal = await judge_project_week(_evidence(commits=[_commit()], tier="tier1"), project_name="Test", lifecycle="active", judge=WeeklySignalJudge(llm, model="test"))
    assert signal.confidence <= 0.5
    assert "src/feature.py" in llm.last_user


@pytest.mark.asyncio
async def test_at_risk_requires_a_real_citation():
    llm = FakeLLM(_valid_response(status="at_risk", concerns=[{"text": "broken", "evidence": ["invented@1234567"]}]))
    signal = await judge_project_week(_evidence(commits=[_commit()]), project_name="Test", lifecycle="active", judge=WeeklySignalJudge(llm, model="test"))
    assert signal.is_failure
