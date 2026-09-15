"""Integration coverage for backend.jobs.generate_cumulative_checkpoint."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest

from backend.code_evidence import CommitFact, HistoryMetadata, RepoCodeEvidence, WeekCodeEvidence
from backend.cumulative_llm import CUMULATIVE_VERSION, CumulativeCheckpoint
from backend.db import SqliteStore
from backend.jobs import _checkpoint_to_context, generate_cumulative_checkpoint
from backend.models import AttentionStatus, CumulativeCheckpointDocument
from backend.signal_llm import WeeklySignalJudge

# Fixed "today" for these tests, matched against generate_cumulative_checkpoint's
# use of the real clock via _utc_now() -- tests only exercise weeks safely in
# the past relative to whenever they actually run, using far-past dates.
AS_OF = date(2026, 4, 20)
FAR_PAST_WEEK = date(2026, 3, 30)


def _commit(sha: str) -> CommitFact:
    return CommitFact(
        sha=sha, repo_slug="member-portal", subject="add feature", committed_at=datetime(2026, 4, 14, tzinfo=timezone.utc),
        additions=200, deletions=10, files=["src/feature.py"], noise_files=[], is_noise_only=False, is_chore_like=False,
    )


class FakeReader:
    def __init__(self, evidence: WeekCodeEvidence | None = None, history: HistoryMetadata | None = None, call_counter: list[int] | None = None) -> None:
        self._evidence = evidence
        self._history = history or HistoryMetadata()
        # Shared across every reader fake_builder hands out, since a fresh
        # instance is created per call -- tracking calls on "the last
        # reader" would just measure whichever call happened to run last.
        self._call_counter = call_counter if call_counter is not None else [0]

    def week_evidence(self, **_: Any) -> WeekCodeEvidence:
        return self._evidence or WeekCodeEvidence(project_id="p", week_start=AS_OF, week_end=AS_OF, repos=[], tier="tier0")

    def history_metadata(self, repo_slugs: Any, *, start: date, end: date) -> HistoryMetadata:
        self._call_counter[0] += 1
        return self._history

    def close(self) -> None:
        pass


class FakeWeeklyLLM:
    def __init__(self) -> None:
        self.calls = 0

    async def call_tool(self, *, system: str, user: str, tool: dict[str, Any], model: str, max_tokens: int) -> dict[str, Any]:
        self.calls += 1
        return {
            "status": "watch", "confidence": 0.7, "headline": "Some progress", "summary": "summary",
            "work_volume": "moderate",
            "what_changed": [{"text": "did stuff", "evidence": ["member-portal@abc1234"]}],
            "concerns": [],
        }


class FakeCumulativeLLM:
    def __init__(self) -> None:
        self.calls = 0

    async def call_tool(self, *, system: str, user: str, tool: dict[str, Any], model: str, max_tokens: int) -> dict[str, Any]:
        self.calls += 1
        return {
            "status": "watch", "confidence": 0.7, "trajectory": "steady", "headline": "Steady progress",
            "narrative": "The project is progressing steadily.", "work_to_date": "moderate",
            "milestones": [], "open_concerns": [], "recommendations": [], "data_gaps": [],
        }


class FailingLLM:
    async def call_tool(self, **_: Any) -> dict[str, Any]:
        raise RuntimeError("boom")


def _week_evidence(commits: list[CommitFact], tier: str = "tier2") -> WeekCodeEvidence:
    return WeekCodeEvidence(
        project_id="p", week_start=AS_OF, week_end=AS_OF, tier=tier,
        repos=[RepoCodeEvidence(repo_slug="member-portal", commits=commits, diffs={c.sha: "diff --git a b\n" for c in commits})],
    )


@pytest.mark.asyncio
async def test_cold_path_deep_judges_and_sweeps_shallow(in_memory_store: SqliteStore, make_project, make_boundary, monkeypatch) -> None:
    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary(effective_from=date(2026, 1, 1)))

    async def fake_builder(settings, database, project_id, *, at):
        return FakeReader(evidence=_week_evidence([_commit(f"c{at.isoformat()}")]), history=HistoryMetadata(weeks_counts={date(2026, 1, 5): 3})), ["member-portal"]

    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", fake_builder)

    weekly_llm = FakeWeeklyLLM()
    cumulative_llm = FakeCumulativeLLM()
    weekly_judge = WeeklySignalJudge(weekly_llm, model="gemini-2.5-flash")
    from backend.cumulative_llm import CumulativeCheckpointJudge
    cumulative_judge = CumulativeCheckpointJudge(cumulative_llm, model="gemini-2.5-flash")

    doc = await generate_cumulative_checkpoint(
        "member-portal", FAR_PAST_WEEK, database=in_memory_store,
        weekly_judge=weekly_judge, cumulative_judge=cumulative_judge,
    )
    assert doc is not None
    assert doc.status == AttentionStatus.WATCH
    assert doc.trajectory == "steady"
    assert weekly_llm.calls > 0  # deep tail was judged
    assert cumulative_llm.calls == 1
    assert doc.chain_depth == 0


@pytest.mark.asyncio
async def test_second_call_same_week_is_cached(in_memory_store: SqliteStore, make_project, make_boundary, monkeypatch) -> None:
    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary(effective_from=date(2026, 1, 1)))

    async def fake_builder(settings, database, project_id, *, at):
        return FakeReader(evidence=_week_evidence([]), history=HistoryMetadata()), ["member-portal"]

    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", fake_builder)
    cumulative_llm = FakeCumulativeLLM()
    from backend.cumulative_llm import CumulativeCheckpointJudge
    cumulative_judge = CumulativeCheckpointJudge(cumulative_llm, model="gemini-2.5-flash")

    first = await generate_cumulative_checkpoint("member-portal", FAR_PAST_WEEK, database=in_memory_store, weekly_judge=None, cumulative_judge=cumulative_judge)
    second = await generate_cumulative_checkpoint("member-portal", FAR_PAST_WEEK, database=in_memory_store, weekly_judge=None, cumulative_judge=cumulative_judge)
    assert first is not None and second is not None
    assert first.id == second.id
    assert cumulative_llm.calls == 1


@pytest.mark.asyncio
async def test_warm_path_only_judges_gap_weeks_no_shallow_fetch(in_memory_store: SqliteStore, make_project, make_boundary, monkeypatch) -> None:
    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary(effective_from=date(2026, 1, 1)))

    history_call_counter = [0]

    async def fake_builder(settings, database, project_id, *, at):
        reader = FakeReader(
            evidence=_week_evidence([_commit(f"c{at.isoformat()}")]),
            history=HistoryMetadata(weeks_counts={date(2026, 1, 5): 3}),
            call_counter=history_call_counter,
        )
        return reader, ["member-portal"]

    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", fake_builder)
    from backend.cumulative_llm import CumulativeCheckpointJudge
    cumulative_judge = CumulativeCheckpointJudge(FakeCumulativeLLM(), model="gemini-2.5-flash")
    weekly_judge = WeeklySignalJudge(FakeWeeklyLLM(), model="gemini-2.5-flash")

    first_week = date(2026, 4, 5)  # completed Sunday: safe incremental anchor
    second_week = date(2026, 4, 12)

    first = await generate_cumulative_checkpoint("member-portal", first_week, database=in_memory_store, weekly_judge=weekly_judge, cumulative_judge=cumulative_judge)
    assert first is not None
    history_calls_after_first = history_call_counter[0]
    assert history_calls_after_first >= 1  # the cold first call did a shallow sweep

    second = await generate_cumulative_checkpoint("member-portal", second_week, database=in_memory_store, weekly_judge=weekly_judge, cumulative_judge=cumulative_judge)
    assert second is not None
    assert second.chain_depth == first.chain_depth + 1
    # Warm path must not trigger a new shallow sweep at all.
    assert history_call_counter[0] == history_calls_after_first


@pytest.mark.asyncio
async def test_failed_synthesis_returns_none_and_persists_nothing(in_memory_store: SqliteStore, make_project, make_boundary, monkeypatch) -> None:
    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary(effective_from=date(2026, 1, 1)))

    async def fake_builder(settings, database, project_id, *, at):
        return FakeReader(evidence=_week_evidence([_commit("c1")]), history=HistoryMetadata()), ["member-portal"]

    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", fake_builder)
    from backend.cumulative_llm import CumulativeCheckpointJudge
    cumulative_judge = CumulativeCheckpointJudge(FailingLLM(), model="gemini-2.5-flash")
    weekly_judge = WeeklySignalJudge(FakeWeeklyLLM(), model="gemini-2.5-flash")

    doc = await generate_cumulative_checkpoint("member-portal", FAR_PAST_WEEK, database=in_memory_store, weekly_judge=weekly_judge, cumulative_judge=cumulative_judge)
    assert doc is None

    checkpoints = await in_memory_store.list("cumulative_checkpoints")
    assert checkpoints == []


@pytest.mark.asyncio
async def test_all_quiet_deep_weeks_still_synthesizes_a_real_checkpoint(in_memory_store: SqliteStore, make_project, make_boundary, monkeypatch) -> None:
    """Tier-0 'no activity' weeks are still real, non-failure signals (per
    signal_llm.no_activity_signal), so the deep tail is non-empty and the
    cumulative judge still runs -- this is not the same as zero history
    anywhere (covered at the judge level in test_cumulative_llm.py)."""
    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary(effective_from=date(2026, 1, 1)))

    async def fake_builder(settings, database, project_id, *, at):
        return FakeReader(evidence=_week_evidence([]), history=HistoryMetadata()), ["member-portal"]

    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", fake_builder)
    cumulative_llm = FakeCumulativeLLM()
    from backend.cumulative_llm import CumulativeCheckpointJudge
    cumulative_judge = CumulativeCheckpointJudge(cumulative_llm, model="gemini-2.5-flash")

    doc = await generate_cumulative_checkpoint("member-portal", FAR_PAST_WEEK, database=in_memory_store, weekly_judge=None, cumulative_judge=cumulative_judge)
    assert doc is not None
    assert cumulative_llm.calls == 1
    assert doc.weeks_deep_judged


def test_checkpoint_to_context_carries_grounded_findings() -> None:
    """Prior context must keep milestones/concerns, not just the headline.

    On the incremental path the prior checkpoint is the only record of
    everything before the newly judged weeks; dropping its grounded
    findings left the synthesis with nothing to build on.
    """

    doc = CumulativeCheckpointDocument.model_construct(
        id="c1", project_id="proj", as_of_date=date(2026, 5, 4), as_of_week_start=date(2026, 5, 4),
        coverage_start=date(2026, 1, 1), signal_version=CUMULATIVE_VERSION,
        status=AttentionStatus.WATCH, confidence=0.8, trajectory="steady",
        headline="Steady delivery", narrative="Real work happened.", work_to_date="substantial",
        milestones=[{"text": "Parser landed", "evidence": ["repo/parse.py@abc1234"]}],
        open_concerns=[{"text": "No tests", "severity": "warning", "evidence": ["repo/parse.py@abc1234"]}],
    )
    context = _checkpoint_to_context(doc)
    assert context.work_to_date == "substantial"
    assert context.milestones == doc.milestones
    assert context.open_concerns == doc.open_concerns


@pytest.mark.asyncio
async def test_exact_dates_do_not_share_cache_or_include_later_commits(in_memory_store, make_project, make_boundary, monkeypatch):
    from backend.cumulative_llm import CumulativeCheckpointJudge
    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary(effective_from=date(2026, 3, 2)))
    windows = []

    class RecordingReader(FakeReader):
        def week_evidence(self, **kwargs):
            windows.append((kwargs["week_start"], kwargs["week_end"]))
            return WeekCodeEvidence(project_id="member-portal", week_start=kwargs["week_start"], week_end=kwargs["week_end"], repos=[RepoCodeEvidence(repo_slug="member-portal")], tier="tier0")

    async def builder(*args, **kwargs):
        return RecordingReader(), ["member-portal"]
    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", builder)
    judge = CumulativeCheckpointJudge(FakeCumulativeLLM(), model="test")
    monday, wednesday = date(2026, 3, 30), date(2026, 4, 1)
    first = await generate_cumulative_checkpoint("member-portal", monday, database=in_memory_store, cumulative_judge=judge)
    assert first is not None
    assert max(end for _, end in windows) == monday
    windows.clear()
    second = await generate_cumulative_checkpoint("member-portal", wednesday, database=in_memory_store, cumulative_judge=judge)
    assert second is not None and second.id != first.id
    assert max(end for _, end in windows) == wednesday
    assert len(await in_memory_store.list("cumulative_checkpoints")) == 2
    assert all(s.week_start != monday for s in await in_memory_store.list("snapshots"))


@pytest.mark.asyncio
async def test_failed_deep_week_does_not_freeze_partial_cumulative_result(in_memory_store, make_project, make_boundary, monkeypatch):
    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary(effective_from=date(2026, 1, 1)))
    async def failed_week(*args, **kwargs):
        return None
    monkeypatch.setattr("backend.jobs.generate_llm_snapshot", failed_week)
    result = await generate_cumulative_checkpoint("member-portal", FAR_PAST_WEEK, database=in_memory_store)
    assert result is None
    assert await in_memory_store.list("cumulative_checkpoints") == []
