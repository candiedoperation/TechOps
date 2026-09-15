"""Integration coverage for the lazy LLM-signal job functions in backend.jobs."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest

from backend.code_evidence import CommitFact, RepoCodeEvidence, WeekCodeEvidence
from backend.db import SqliteStore
from backend.jobs import generate_llm_snapshot, generate_llm_weekly_snapshots, run_weekly_snapshot_job
from backend.models import LifecycleState, PlannedPause, RepoActivityDocument
from backend.signal_llm import SIGNAL_VERSION, WeeklySignalJudge

WEEK_START = date(2026, 8, 3)


def _commit(sha: str) -> CommitFact:
    return CommitFact(
        sha=sha, repo_slug="member-portal", subject="add feature", committed_at=datetime(2026, 8, 4, tzinfo=timezone.utc),
        additions=200, deletions=10, files=["src/feature.py"], noise_files=[], is_noise_only=False, is_chore_like=False,
    )


class FakeReader:
    def __init__(self, evidence: WeekCodeEvidence) -> None:
        self._evidence = evidence
        self.closed = False

    def week_evidence(self, **_: Any) -> WeekCodeEvidence:
        return self._evidence

    def close(self) -> None:
        self.closed = True


class FakeLLM:
    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.calls = 0

    async def call_tool(self, *, system: str, user: str, tool: dict[str, Any], model: str, max_tokens: int) -> dict[str, Any]:
        self.calls += 1
        return self.response


def _valid_response(status: str = "watch") -> dict[str, Any]:
    return {
        "status": status,
        "confidence": 0.7,
        "headline": "Steady progress",
        "summary": "Real work landed this week.",
        "work_volume": "moderate",
        "what_changed": [{"text": "Added a feature", "evidence": ["member-portal@aaaaaaa"]}],
        "concerns": [{"text": "No tests included", "severity": "warning", "evidence": ["member-portal@aaaaaaa"]}],
        "recommendations": [],
        "data_gaps": [],
    }


@pytest.mark.asyncio
async def test_generate_llm_snapshot_caches_on_second_call(in_memory_store: SqliteStore, make_project, make_boundary, monkeypatch) -> None:
    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary())

    evidence = WeekCodeEvidence(
        project_id="member-portal", week_start=WEEK_START, week_end=WEEK_START + timedelta(days=6),
        repos=[RepoCodeEvidence(repo_slug="member-portal", commits=[_commit("aaaaaaa1234")], diffs={"aaaaaaa1234": "diff --git a/src/feature.py b/src/feature.py\n"})],
        tier="tier2",
    )
    reader = FakeReader(evidence)

    async def fake_builder(settings, database, project_id, *, at):
        return reader, ["member-portal"]

    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", fake_builder)

    llm = FakeLLM(_valid_response())
    judge = WeeklySignalJudge(llm, model="gemini-2.5-flash")

    first = await generate_llm_snapshot("member-portal", WEEK_START, database=in_memory_store, judge=judge)
    assert first is not None
    assert first.signal_source == "llm"
    assert first.rule_set_version == SIGNAL_VERSION
    assert llm.calls == 1

    second = await generate_llm_snapshot("member-portal", WEEK_START, database=in_memory_store, judge=judge)
    assert second is not None
    assert second.id == first.id
    assert llm.calls == 1  # cache hit, no second provider call

    warnings = [w for w in await in_memory_store.list("warnings") if w.project_id == "member-portal"]
    assert len(warnings) == 1
    assert warnings[0].rule_id == "llm.weekly_signal"


@pytest.mark.asyncio
async def test_generate_llm_snapshot_returns_none_on_llm_failure(in_memory_store: SqliteStore, make_project, make_boundary, monkeypatch) -> None:
    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary())

    evidence = WeekCodeEvidence(
        project_id="member-portal", week_start=WEEK_START, week_end=WEEK_START + timedelta(days=6),
        repos=[RepoCodeEvidence(repo_slug="member-portal", commits=[_commit("bbbbbbb1234")], diffs={"bbbbbbb1234": "diff --git a/src/feature.py b/src/feature.py\n"})],
        tier="tier2",
    )
    reader = FakeReader(evidence)

    async def fake_builder(settings, database, project_id, *, at):
        return reader, ["member-portal"]

    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", fake_builder)

    result = await generate_llm_snapshot("member-portal", WEEK_START, database=in_memory_store, judge=None)
    assert result is None

    snapshots = [s for s in await in_memory_store.list("snapshots") if s.project_id == "member-portal"]
    assert snapshots == []  # nothing persisted on the fail-closed path


@pytest.mark.asyncio
async def test_generate_llm_snapshot_honors_planned_pause(in_memory_store: SqliteStore, make_project, make_boundary) -> None:
    project = make_project(
        lifecycle_state=LifecycleState.PAUSED,
        planned_pauses=[PlannedPause(starts_on=date(2026, 8, 1), ends_on=date(2026, 8, 31), reason="summer break")],
    )
    await in_memory_store.add("projects", project)
    await in_memory_store.add("boundaries", make_boundary())

    result = await generate_llm_snapshot("member-portal", WEEK_START, database=in_memory_store, judge=None)
    assert result is not None
    assert result.signal_headline == "Planned pause"


@pytest.mark.asyncio
async def test_generate_llm_weekly_snapshots_fans_out_across_projects(in_memory_store: SqliteStore, make_project, make_boundary, monkeypatch) -> None:
    await in_memory_store.add("projects", make_project(project_id="proj-a"))
    await in_memory_store.add("boundaries", make_boundary(project_id="proj-a"))
    await in_memory_store.add("projects", make_project(project_id="proj-b"))
    await in_memory_store.add("boundaries", make_boundary(project_id="proj-b"))

    async def fake_builder(settings, database, project_id, *, at):
        evidence = WeekCodeEvidence(
            project_id=project_id, week_start=WEEK_START, week_end=WEEK_START + timedelta(days=6),
            repos=[RepoCodeEvidence(repo_slug=project_id, commits=[], diffs={})], tier="tier0",
        )
        return FakeReader(evidence), [project_id]

    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", fake_builder)
    monkeypatch.setattr("backend.jobs.get_signal_judge", lambda settings: WeeklySignalJudge(FakeLLM(_valid_response()), model="test"))

    written = await generate_llm_weekly_snapshots(database=in_memory_store, week_start=WEEK_START)
    assert written == 2

    snapshots = [s for s in await in_memory_store.list("snapshots") if s.rule_set_version == SIGNAL_VERSION]
    assert {s.project_id for s in snapshots} == {"proj-a", "proj-b"}


@pytest.mark.asyncio
async def test_run_weekly_snapshot_job_defaults_to_llm_when_active(in_memory_store: SqliteStore, test_settings, make_project, make_boundary, monkeypatch) -> None:
    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary())
    test_settings.llm_enabled = True
    test_settings.gemini_api_key = "test-key"

    called: dict[str, Any] = {}

    async def fake_llm_fanout(*, settings, database, week_start=None, concurrency=3):
        called["engine"] = "llm"
        return 0

    monkeypatch.setattr("backend.jobs.generate_llm_weekly_snapshots", fake_llm_fanout)
    result = await run_weekly_snapshot_job(settings=test_settings, database=in_memory_store, week_start=WEEK_START)
    assert result["engine"] == "llm"
    assert called["engine"] == "llm"


@pytest.mark.asyncio
async def test_weekly_default_targets_completed_week(in_memory_store, test_settings, monkeypatch):
    monkeypatch.setattr("backend.jobs._utc_now", lambda: datetime(2026, 9, 9, tzinfo=timezone.utc))
    called = []
    async def generate(**kwargs):
        called.append(kwargs["week_start"])
        return 0
    monkeypatch.setattr("backend.jobs.generate_weekly_snapshots", generate)
    await run_weekly_snapshot_job(settings=test_settings, database=in_memory_store)
    assert called == [date(2026, 8, 31)]
    with pytest.raises(ValueError):
        await run_weekly_snapshot_job(settings=test_settings, database=in_memory_store, week_start=date(2026, 9, 7))


@pytest.mark.asyncio
async def test_enabled_with_blank_key_does_not_silently_use_rules(in_memory_store, test_settings):
    from backend.llm import LLMUnavailable
    test_settings.llm_enabled = True
    test_settings.gemini_api_key = "   "
    assert not test_settings.llm_active
    with pytest.raises(LLMUnavailable):
        await run_weekly_snapshot_job(settings=test_settings, database=in_memory_store, week_start=WEEK_START)


@pytest.mark.asyncio
async def test_direct_weekly_trigger_builds_judge_and_preserves_findings(in_memory_store, make_project, make_boundary, monkeypatch):
    from backend.jobs import _snapshot_to_weekly_signal
    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary())
    evidence = WeekCodeEvidence(project_id="member-portal", week_start=WEEK_START, week_end=WEEK_START + timedelta(days=6), repos=[RepoCodeEvidence(repo_slug="member-portal", commits=[_commit("aaaaaaa")])], tier="tier1")
    async def builder(*args, **kwargs):
        return FakeReader(evidence), ["member-portal"]
    llm = FakeLLM(_valid_response())
    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", builder)
    monkeypatch.setattr("backend.jobs.get_signal_judge", lambda settings: WeeklySignalJudge(llm, model="test"))
    snapshot = await generate_llm_snapshot("member-portal", WEEK_START, database=in_memory_store)
    assert snapshot is not None and llm.calls == 1
    stored = (await in_memory_store.list("snapshots"))[0]
    signal = _snapshot_to_weekly_signal(stored)
    assert signal.what_changed == _valid_response()["what_changed"]
    assert signal.concerns == _valid_response()["concerns"]
    assert signal.data_gaps


@pytest.mark.asyncio
async def test_run_weekly_snapshot_job_rules_override_bypasses_llm(in_memory_store: SqliteStore, test_settings, make_project, make_boundary, monkeypatch) -> None:
    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary())
    test_settings.llm_enabled = True
    test_settings.gemini_api_key = "test-key"

    async def fail_if_called(*args: Any, **kwargs: Any) -> int:
        raise AssertionError("LLM fanout should not run when engine='rules' is forced")

    monkeypatch.setattr("backend.jobs.generate_llm_weekly_snapshots", fail_if_called)
    result = await run_weekly_snapshot_job(settings=test_settings, database=in_memory_store, week_start=WEEK_START, engine="rules")
    assert result["engine"] == "rules"


@pytest.mark.asyncio
async def test_generate_llm_snapshot_carries_pull_request_aggregates(
    in_memory_store: SqliteStore, make_project, make_boundary, monkeypatch
) -> None:
    """PR aggregates come from repo_activity, and a real zero is not dropped.

    The code-evidence reader is commit-only, so without the repo_activity
    fold the snapshot would carry ``None`` for every PR field and the
    "Project aggregates" panel would render "--" for counts that were
    actually synced.
    """

    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary())
    for repo_slug, open_prs, merged in (("member-portal", 0, 0), ("member-portal-web", 2, 3)):
        await in_memory_store.add(
            "repo_activity",
            RepoActivityDocument(
                id=f"activity-{repo_slug}",
                project_id="member-portal",
                gitea_repo_id=repo_slug,
                repo_slug=repo_slug,
                window_start=WEEK_START,
                window_end=WEEK_START + timedelta(days=6),
                active_days=1,
                open_prs=open_prs,
                merged_count=merged,
            ),
        )

    evidence = WeekCodeEvidence(
        project_id="member-portal", week_start=WEEK_START, week_end=WEEK_START + timedelta(days=6),
        repos=[RepoCodeEvidence(repo_slug="member-portal", commits=[_commit("ccccccc1234")], diffs={"ccccccc1234": "diff --git a/src/feature.py b/src/feature.py\n"})],
        tier="tier2",
    )

    async def fake_builder(settings, database, project_id, *, at):
        return FakeReader(evidence), ["member-portal"]

    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", fake_builder)

    judge = WeeklySignalJudge(FakeLLM(_valid_response()), model="gemini-2.5-flash")
    snapshot = await generate_llm_snapshot("member-portal", WEEK_START, database=in_memory_store, judge=judge)

    assert snapshot is not None
    assert snapshot.metrics.open_prs == 2
    assert snapshot.metrics.merged_count == 3
    # No review activity was recorded, so this stays an honest "no data".
    assert snapshot.metrics.review_latency_days is None


@pytest.mark.asyncio
async def test_generate_llm_snapshot_keeps_zero_pull_request_counts(
    in_memory_store: SqliteStore, make_project, make_boundary, monkeypatch
) -> None:
    """A genuine zero must survive the fold rather than collapsing to absent."""

    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary())
    await in_memory_store.add(
        "repo_activity",
        RepoActivityDocument(
            id="activity-zero",
            project_id="member-portal",
            gitea_repo_id="member-portal",
            repo_slug="member-portal",
            window_start=WEEK_START,
            window_end=WEEK_START + timedelta(days=6),
            active_days=0,
            open_prs=0,
            merged_count=0,
        ),
    )

    evidence = WeekCodeEvidence(
        project_id="member-portal", week_start=WEEK_START, week_end=WEEK_START + timedelta(days=6),
        repos=[RepoCodeEvidence(repo_slug="member-portal", commits=[_commit("ddddddd1234")], diffs={"ddddddd1234": "diff --git a/src/feature.py b/src/feature.py\n"})],
        tier="tier2",
    )

    async def fake_builder(settings, database, project_id, *, at):
        return FakeReader(evidence), ["member-portal"]

    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", fake_builder)

    judge = WeeklySignalJudge(FakeLLM(_valid_response()), model="gemini-2.5-flash")
    snapshot = await generate_llm_snapshot("member-portal", WEEK_START, database=in_memory_store, judge=judge)

    assert snapshot is not None
    assert snapshot.metrics.open_prs == 0
    assert snapshot.metrics.merged_count == 0


@pytest.mark.asyncio
async def test_generate_llm_snapshot_does_not_duplicate_synced_activity_row(
    in_memory_store: SqliteStore, make_project, make_boundary, monkeypatch
) -> None:
    """The snapshot must not add a second repo_activity row for a synced week.

    ``repo_activity`` is a one-row-per-(project, repo, week) projection, and
    ``_history_by_project`` folds additively across a bucket.  A commit-only
    row written alongside the Gitea-synced one carries no PR aggregates,
    double-counts ``active_days``, and can shadow the synced row -- which is
    how the "Project aggregates" panel regressed to "--" after a fix that
    only read the fold.
    """

    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary())
    await in_memory_store.add(
        "repo_activity",
        RepoActivityDocument(
            id="activity-synced",
            project_id="member-portal",
            gitea_repo_id="42",
            repo_slug="member-portal",
            window_start=WEEK_START,
            window_end=WEEK_START + timedelta(days=6),
            active_days=4,
            open_prs=3,
            merged_count=9,
            review_latency_days=2.21,
            aggregation_floor=5,
        ),
    )

    evidence = WeekCodeEvidence(
        project_id="member-portal", week_start=WEEK_START, week_end=WEEK_START + timedelta(days=6),
        repos=[RepoCodeEvidence(repo_slug="member-portal", commits=[_commit("eeeeeee1234")], diffs={"eeeeeee1234": "diff --git a/src/feature.py b/src/feature.py\n"})],
        tier="tier2",
    )

    async def fake_builder(settings, database, project_id, *, at):
        return FakeReader(evidence), ["member-portal"]

    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", fake_builder)

    response = _valid_response()
    for field in ("what_changed", "concerns"):
        response[field][0]["evidence"] = ["member-portal@eeeeeee"]
    judge = WeeklySignalJudge(FakeLLM(response), model="gemini-2.5-flash")
    snapshot = await generate_llm_snapshot("member-portal", WEEK_START, database=in_memory_store, judge=judge)

    assert snapshot is not None
    assert snapshot.metrics.open_prs == 3
    assert snapshot.metrics.merged_count == 9
    assert snapshot.metrics.review_latency_days == 2.21

    rows = await in_memory_store.list("repo_activity")
    assert [str(row.id) for row in rows] == ["activity-synced"]
    # Concern evidence now points at the real synced row instead of a
    # throwaway one that only this job knew about.
    warnings = await in_memory_store.list("warnings")
    assert warnings
    assert warnings[0].evidence[0].source_refs[0].source_id == "activity-synced"


@pytest.mark.asyncio
async def test_generate_llm_snapshot_reuses_its_own_prior_activity_row(
    in_memory_store: SqliteStore, make_project, make_boundary, monkeypatch
) -> None:
    """A week the Gitea sync never covered gets one row, not one per run.

    The commit-only row this job writes when nothing is synced is what a
    later ingestion refreshes in place, so a second run must reuse it rather
    than pile another partial row onto the same week.
    """

    await in_memory_store.add("projects", make_project())
    await in_memory_store.add("boundaries", make_boundary())
    await in_memory_store.add(
        "repo_activity",
        RepoActivityDocument(
            id="activity-commit-only",
            project_id="member-portal",
            gitea_repo_id="member-portal",
            repo_slug="member-portal",
            window_start=WEEK_START,
            window_end=WEEK_START + timedelta(days=6),
            active_days=1,
        ),
    )

    evidence = WeekCodeEvidence(
        project_id="member-portal", week_start=WEEK_START, week_end=WEEK_START + timedelta(days=6),
        repos=[RepoCodeEvidence(repo_slug="member-portal", commits=[_commit("fffffff1234")], diffs={"fffffff1234": "diff --git a/src/feature.py b/src/feature.py\n"})],
        tier="tier2",
    )

    async def fake_builder(settings, database, project_id, *, at):
        return FakeReader(evidence), ["member-portal"]

    monkeypatch.setattr("backend.jobs.build_code_evidence_reader", fake_builder)

    judge = WeeklySignalJudge(FakeLLM(_valid_response()), model="gemini-2.5-flash")
    snapshot = await generate_llm_snapshot("member-portal", WEEK_START, database=in_memory_store, judge=judge)

    assert snapshot is not None
    # Nothing was ever synced for this week, so "no data" is the honest answer.
    assert snapshot.metrics.open_prs is None
    rows = await in_memory_store.list("repo_activity")
    assert [str(row.id) for row in rows] == ["activity-commit-only"]
