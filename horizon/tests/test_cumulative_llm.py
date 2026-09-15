"""Unit coverage for the cumulative-progress synthesis judge."""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest

from backend.code_evidence import HistoryMetadata
from backend.cumulative_llm import (
    CumulativeCheckpoint,
    CumulativeCheckpointJudge,
    build_checkpoint_user,
    judge_project_cumulative,
    no_history_checkpoint,
)
from backend.llm import LLMUnavailable
from backend.models import AttentionStatus
from backend.signal_llm import WeeklySignal

AS_OF = date(2026, 4, 20)
COVERAGE_START = date(2026, 1, 1)


def _deep_signal(week_start: date, status: AttentionStatus = AttentionStatus.WATCH) -> tuple[date, WeeklySignal]:
    signal = WeeklySignal(
        status=status, confidence=0.8, headline="Some work happened", summary="summary",
        work_volume="moderate",
        concerns=[{"text": "No tests", "severity": "warning", "evidence": ["repo/api.py@abc1234"]}],
        what_changed=[{"text": "Added feature", "evidence": ["repo/api.py@abc1234"]}],
    )
    return week_start, signal


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
        "confidence": 0.7,
        "trajectory": "steady",
        "headline": "Steady progress through April",
        "narrative": "The project has made consistent progress.",
        "work_to_date": "moderate",
        "milestones": [{"text": "Core feature landed", "evidence": ["repo/api.py@abc1234"]}],
        "open_concerns": [{"text": "No tests yet", "severity": "warning", "evidence": ["repo/api.py@abc1234"]}],
        "recommendations": [],
        "data_gaps": [],
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_no_history_short_circuits_without_llm_call() -> None:
    checkpoint = await judge_project_cumulative(
        project_name="Test", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[], shallow=None, judge=None,
    )
    assert checkpoint.status == AttentionStatus.INSUFFICIENT_DATA
    assert checkpoint.is_failure is False
    assert checkpoint == checkpoint  # sanity
    assert no_history_checkpoint().is_failure is False


@pytest.mark.asyncio
async def test_failed_history_is_not_cached_as_no_history():
    checkpoint = await judge_project_cumulative(
        project_name="Test", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[], shallow=HistoryMetadata(fetch_errors=["unavailable"]), judge=None,
    )
    assert checkpoint.is_failure


@pytest.mark.asyncio
async def test_invented_cumulative_citations_are_rejected():
    llm = FakeLLM(_valid_response(status="at_risk", open_concerns=[{"text": "Broken", "evidence": ["week 2099-01-01"], "severity": "critical"}]))
    checkpoint = await judge_project_cumulative(
        project_name="Test", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[_deep_signal(date(2026, 4, 13))], shallow=None, judge=CumulativeCheckpointJudge(llm, model="test"),
    )
    assert checkpoint.is_failure


@pytest.mark.asyncio
async def test_prior_context_survives_empty_new_history():
    prior = CumulativeCheckpoint(status=AttentionStatus.WATCH, confidence=0.7, trajectory="steady", headline="Prior work", narrative="Known work", work_to_date="moderate")
    llm = FakeLLM(_valid_response(milestones=[], open_concerns=[]))
    checkpoint = await judge_project_cumulative(
        project_name="Test", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[], shallow=None, prior=prior, judge=CumulativeCheckpointJudge(llm, model="test"),
    )
    assert llm.calls == 1
    assert not checkpoint.is_failure


@pytest.mark.asyncio
async def test_judge_none_with_real_history_is_a_failure() -> None:
    shallow = HistoryMetadata(weeks_counts={date(2026, 2, 2): 5}, repos_covered=["repo"])
    checkpoint = await judge_project_cumulative(
        project_name="Test", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[], shallow=shallow, judge=None,
    )
    assert checkpoint.is_failure is True
    assert checkpoint.status == AttentionStatus.INSUFFICIENT_DATA


@pytest.mark.asyncio
async def test_llm_exception_is_fail_closed() -> None:
    shallow = HistoryMetadata(weeks_counts={date(2026, 2, 2): 5}, repos_covered=["repo"])
    llm = FakeLLM(LLMUnavailable("boom"))
    judge = CumulativeCheckpointJudge(llm, model="gemini-2.5-flash")
    checkpoint = await judge_project_cumulative(
        project_name="Test", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[_deep_signal(date(2026, 4, 13))], shallow=shallow, judge=judge,
    )
    assert checkpoint.is_failure is True


@pytest.mark.asyncio
async def test_valid_response_parses_and_keeps_grounded_items() -> None:
    shallow = HistoryMetadata(weeks_counts={date(2026, 2, 2): 5, date(2026, 3, 2): 12}, repos_covered=["repo"])
    llm = FakeLLM(_valid_response())
    judge = CumulativeCheckpointJudge(llm, model="gemini-2.5-flash")
    checkpoint = await judge_project_cumulative(
        project_name="Test", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[_deep_signal(date(2026, 4, 13))], shallow=shallow, judge=judge,
    )
    assert checkpoint.is_failure is False
    assert checkpoint.status == AttentionStatus.WATCH
    assert checkpoint.trajectory == "steady"
    assert len(checkpoint.milestones) == 1
    assert len(checkpoint.open_concerns) == 1
    assert llm.calls == 1


@pytest.mark.asyncio
async def test_ungrounded_items_are_dropped() -> None:
    shallow = HistoryMetadata(weeks_counts={date(2026, 2, 2): 5}, repos_covered=["repo"])
    response = _valid_response(
        milestones=[{"text": "ungrounded claim", "evidence": []}],
        open_concerns=[{"text": "ungrounded concern", "severity": "critical", "evidence": []}],
    )
    llm = FakeLLM(response)
    judge = CumulativeCheckpointJudge(llm, model="gemini-2.5-flash")
    checkpoint = await judge_project_cumulative(
        project_name="Test", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[], shallow=shallow, judge=judge,
    )
    assert checkpoint.milestones == []
    assert checkpoint.open_concerns == []


@pytest.mark.asyncio
async def test_unrecognized_status_is_fail_closed() -> None:
    shallow = HistoryMetadata(weeks_counts={date(2026, 2, 2): 5}, repos_covered=["repo"])
    llm = FakeLLM(_valid_response(status="on_track"))
    judge = CumulativeCheckpointJudge(llm, model="gemini-2.5-flash")
    checkpoint = await judge_project_cumulative(
        project_name="Test", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[], shallow=shallow, judge=judge,
    )
    assert checkpoint.is_failure is True


@pytest.mark.asyncio
async def test_prompt_wraps_commit_subjects_in_untrusted_delimiters() -> None:
    shallow = HistoryMetadata(
        weeks_counts={date(2026, 2, 2): 1},
        subject_samples=[{"repo_slug": "repo", "sha": "abc1234", "subject": "evil instruction", "week_start": "2026-02-02"}],
        repos_covered=["repo"],
    )
    llm = FakeLLM(_valid_response())
    judge = CumulativeCheckpointJudge(llm, model="gemini-2.5-flash")
    await judge_project_cumulative(
        project_name="Test", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[], shallow=shallow, judge=judge,
    )
    assert "<untrusted_commit_subjects>" in llm.last_user
    start = llm.last_user.index("<untrusted_commit_subjects>")
    end = llm.last_user.index("</untrusted_commit_subjects>")
    assert "evil instruction" in llm.last_user[start:end]


@pytest.mark.asyncio
async def test_deep_signal_evidence_is_carried_into_prompt() -> None:
    shallow = HistoryMetadata(weeks_counts={}, repos_covered=["repo"])
    llm = FakeLLM(_valid_response())
    judge = CumulativeCheckpointJudge(llm, model="gemini-2.5-flash")
    await judge_project_cumulative(
        project_name="Test", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[_deep_signal(date(2026, 4, 13))], shallow=shallow, judge=judge,
    )
    assert "2026-04-13" in llm.last_user
    assert "No tests" in llm.last_user


@pytest.mark.asyncio
async def test_placeholder_evidence_refs_are_rejected() -> None:
    """Same regression as backend.signal_llm: a real model response echoed
    the prompt's format-description text verbatim instead of a real ref."""
    shallow = HistoryMetadata(weeks_counts={date(2026, 2, 2): 5}, repos_covered=["repo"])
    response = _valid_response(
        milestones=[{"text": "Core feature landed", "evidence": ["repo/path@shortsha"]}],
        open_concerns=[{"text": "No tests yet", "severity": "warning", "evidence": ["repo@shortsha"]}],
    )
    llm = FakeLLM(response)
    judge = CumulativeCheckpointJudge(llm, model="gemini-2.5-flash")
    checkpoint = await judge_project_cumulative(
        project_name="Test", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[_deep_signal(date(2026, 4, 13))], shallow=shallow, judge=judge,
    )
    assert checkpoint.milestones == []
    assert checkpoint.open_concerns == []


def test_prior_checkpoint_carries_its_substance_into_the_prompt() -> None:
    """The prior block is the accumulated standing on the incremental path.

    ``generate_cumulative_checkpoint``'s "warm" branch judges only the weeks
    added since the prior checkpoint and skips the shallow sweep entirely,
    so the prior IS the project's history for that call. Rendering only
    "status - headline" left the model with one (often quiet) week and it
    returned insufficient_data for projects with months of real work.
    """

    prior = CumulativeCheckpoint(
        status=AttentionStatus.WATCH,
        confidence=0.8,
        trajectory="steady",
        headline="Steady delivery on the parser",
        narrative="The team shipped the parser and the ingest path over eight weeks.",
        work_to_date="substantial",
        milestones=[{"text": "Parser landed", "evidence": ["repo/parse.py@abc1234"]}],
        open_concerns=[{"text": "No tests", "severity": "warning", "evidence": ["repo/parse.py@abc1234"]}],
    )
    user = build_checkpoint_user(
        project_name="Proj", lifecycle="active", as_of_date=AS_OF, coverage_start=COVERAGE_START,
        deep_signals=[_deep_signal(date(2026, 4, 20))], shallow=None, prior=prior,
    )
    assert "substantial" in user
    assert "steady" in user
    assert prior.narrative in user
    assert "Parser landed" in user
    assert "repo/parse.py@abc1234" in user
    assert "No tests" in user
