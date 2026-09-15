"""Unit coverage for the bounded Gitea code-evidence reader and its tiering."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from backend.code_evidence import DiffLimits, GiteaCodeEvidenceReader

UTC = timezone.utc
WEEK_START = date(2026, 3, 2)
WEEK_END = date(2026, 3, 8)


class FakeResponse:
    def __init__(self, payload: Any = None, text: str | None = None) -> None:
        self._payload = payload
        self._text = text if text is not None else ""
        self.headers: dict[str, str] = {}

    def json(self) -> Any:
        return self._payload

    @property
    def text(self) -> str:
        return self._text

    def raise_for_status(self) -> None:
        return None


def _commit(sha: str, message: str, when: str) -> dict[str, Any]:
    return {"sha": sha, "commit": {"message": message, "committer": {"date": when}}}


def _meta(*, additions: int, deletions: int, files: list[dict[str, str]], parents: int = 1) -> dict[str, Any]:
    return {
        "stats": {"additions": additions, "deletions": deletions, "total": additions + deletions},
        "files": files,
        "parents": [{}] * parents,
    }


class FakeGiteaClient:
    """Routes GET calls by URL shape, mirroring the real Gitea API surface used."""

    def __init__(self, *, commits: list[dict[str, Any]], meta_by_sha: dict[str, dict[str, Any]], diff_by_sha: dict[str, str] | None = None) -> None:
        self.commits = commits
        self.meta_by_sha = meta_by_sha
        self.diff_by_sha = diff_by_sha or {}
        self.diff_calls: list[str] = []
        self.stat_calls: list[str] = []

    def get(self, url: str, params: dict[str, Any] | None = None, **_: Any) -> FakeResponse:
        params = params or {}
        if url.endswith(".diff"):
            sha = url.rsplit("/", 1)[-1].removesuffix(".diff")
            self.diff_calls.append(sha)
            return FakeResponse(text=self.diff_by_sha.get(sha, ""))
        if "/git/commits/" in url:
            sha = url.rsplit("/", 1)[-1]
            self.stat_calls.append(sha)
            return FakeResponse(payload=self.meta_by_sha.get(sha, {}))
        if url.endswith("/commits"):
            return FakeResponse(payload=self.commits)
        return FakeResponse(payload=[])


def _reader(client: FakeGiteaClient, *, limits: DiffLimits = DiffLimits()) -> GiteaCodeEvidenceReader:
    return GiteaCodeEvidenceReader(base_url="https://gitea.example", token="tok", organization="org", client=client, limits=limits)


def test_zero_commits_is_tier0_with_no_diff_fetch() -> None:
    client = FakeGiteaClient(commits=[], meta_by_sha={})
    reader = _reader(client)
    evidence = reader.week_evidence(project_id="p1", repo_slugs=["r1"], week_start=WEEK_START, week_end=WEEK_END)
    assert evidence.tier == "tier0"
    assert evidence.non_noise_commits == []
    assert client.diff_calls == []


def test_merge_with_real_conflict_resolution_is_not_noise():
    client = FakeGiteaClient(
        commits=[_commit("aaa", "Merge feature", "2026-03-03T00:00:00Z")],
        meta_by_sha={"aaa": _meta(additions=10, deletions=1, files=[{"filename": "api.py"}], parents=2)},
    )
    evidence = _reader(client).week_evidence(project_id="p", repo_slugs=["r"], week_start=WEEK_START, week_end=WEEK_END)
    assert evidence.tier == "tier1"
    assert len(evidence.non_noise_commits) == 1


def test_metadata_cap_is_global_and_disclosed():
    commits = [_commit(str(i), "fix", "2026-03-03T00:00:00Z") for i in range(4)]
    client = FakeGiteaClient(commits=commits, meta_by_sha={str(i): _meta(additions=2, deletions=0, files=[{"filename": "api.py"}]) for i in range(4)})
    evidence = _reader(client, limits=DiffLimits(max_commits_total=3)).week_evidence(project_id="p", repo_slugs=["r1", "r2"], week_start=WEEK_START, week_end=WEEK_END)
    assert len(client.stat_calls) == 3
    assert all(repo.truncation_notes for repo in evidence.repos)


def test_capped_history_keeps_collected_counts():
    class PagedClient(FakeGiteaClient):
        def get(self, url, params=None, **kwargs):
            response = FakeResponse([_commit(str(params["page"]), "feature", "2026-03-03T00:00:00Z")])
            response.headers = {"X-HasMore": "true"}
            return response
    reader = _reader(PagedClient(commits=[], meta_by_sha={}), limits=DiffLimits(max_history_pages_per_repo=2))
    history = reader.history_metadata(["r"], start=WEEK_START, end=WEEK_END)
    assert history.truncated
    assert history.weeks_counts[WEEK_START] == 2


def test_diff_file_and_utf8_caps():
    from backend.code_evidence import _select_and_truncate_diff
    diff = "diff --git a/a.py b/a.py\n+hello\ndiff --git a/b.py b/b.py\n+world\n"
    selected, notes = _select_and_truncate_diff(diff, limits=DiffLimits(max_files_per_commit=1))
    assert "b.py" not in selected
    assert notes
    selected, notes = _select_and_truncate_diff("é" * 50, limits=DiffLimits(max_bytes_per_commit=15))
    assert len(selected.encode()) <= 15
    assert notes


def test_noise_only_commit_does_not_escape_tier0() -> None:
    commits = [_commit("aaa", "bump deps", "2026-03-03T00:00:00Z")]
    meta = {"aaa": _meta(additions=400, deletions=10, files=[{"filename": "package-lock.json", "status": "modified"}])}
    client = FakeGiteaClient(commits=commits, meta_by_sha=meta)
    reader = _reader(client)
    evidence = reader.week_evidence(project_id="p1", repo_slugs=["r1"], week_start=WEEK_START, week_end=WEEK_END)
    assert evidence.tier == "tier0"
    assert client.diff_calls == []


def test_small_real_change_is_tier1_and_skips_diff_fetch() -> None:
    commits = [_commit("aaa", "fix typo", "2026-03-03T00:00:00Z")]
    meta = {"aaa": _meta(additions=3, deletions=1, files=[{"filename": "README.md", "status": "modified"}])}
    client = FakeGiteaClient(commits=commits, meta_by_sha=meta)
    reader = _reader(client)
    evidence = reader.week_evidence(project_id="p1", repo_slugs=["r1"], week_start=WEEK_START, week_end=WEEK_END)
    assert evidence.tier == "tier1"
    assert len(evidence.non_noise_commits) == 1
    assert client.diff_calls == []
    assert evidence.repos[0].diffs == {}


def test_substantial_change_is_tier2_and_fetches_diff() -> None:
    commits = [_commit("aaa", "add rebalance endpoint", "2026-03-03T00:00:00Z")]
    meta = {"aaa": _meta(additions=180, deletions=12, files=[{"filename": "api/rebalance.py", "status": "modified"}])}
    diff_text = "diff --git a/api/rebalance.py b/api/rebalance.py\n@@ -1,2 +1,4 @@\n+def rebalance():\n+    pass\n"
    client = FakeGiteaClient(commits=commits, meta_by_sha=meta, diff_by_sha={"aaa": diff_text})
    reader = _reader(client)
    evidence = reader.week_evidence(project_id="p1", repo_slugs=["r1"], week_start=WEEK_START, week_end=WEEK_END)
    assert evidence.tier == "tier2"
    assert client.diff_calls == ["aaa"]
    assert "aaa" in evidence.repos[0].diffs
    assert "rebalance" in evidence.repos[0].diffs["aaa"]


def test_noise_file_within_a_real_commit_is_skipped_not_fetched_verbatim() -> None:
    commits = [_commit("aaa", "wire feature + lockfile", "2026-03-03T00:00:00Z")]
    meta = {
        "aaa": _meta(
            additions=250,
            deletions=5,
            files=[
                {"filename": "src/feature.py", "status": "modified"},
                {"filename": "package-lock.json", "status": "modified"},
            ],
        )
    }
    diff_text = (
        "diff --git a/src/feature.py b/src/feature.py\n@@ -1,1 +1,3 @@\n+def feature():\n+    return 1\n"
        "diff --git a/package-lock.json b/package-lock.json\n@@ -1,500 +1,500 @@\n" + "+x\n" * 500
    )
    client = FakeGiteaClient(commits=commits, meta_by_sha=meta, diff_by_sha={"aaa": diff_text})
    reader = _reader(client)
    evidence = reader.week_evidence(project_id="p1", repo_slugs=["r1"], week_start=WEEK_START, week_end=WEEK_END)
    selected = evidence.repos[0].diffs["aaa"]
    assert "SKIPPED" in selected
    assert selected.count("+x\n") == 0


def test_merge_commit_is_treated_as_noise_only() -> None:
    commits = [_commit("aaa", "Merge pull request #4", "2026-03-03T00:00:00Z")]
    meta = {"aaa": _meta(additions=0, deletions=0, files=[], parents=2)}
    client = FakeGiteaClient(commits=commits, meta_by_sha=meta)
    reader = _reader(client)
    evidence = reader.week_evidence(project_id="p1", repo_slugs=["r1"], week_start=WEEK_START, week_end=WEEK_END)
    assert evidence.tier == "tier0"
    assert client.diff_calls == []


def test_diff_fetch_failure_is_isolated_not_fatal() -> None:
    commits = [
        _commit("aaa", "big real change", "2026-03-03T00:00:00Z"),
        _commit("bbb", "another big real change", "2026-03-04T00:00:00Z"),
    ]
    meta = {
        "aaa": _meta(additions=500, deletions=10, files=[{"filename": "a.py", "status": "modified"}]),
        "bbb": _meta(additions=400, deletions=5, files=[{"filename": "b.py", "status": "modified"}]),
    }
    # "aaa" has no diff registered -> commit_diff returns None for it (fetch failure path).
    client = FakeGiteaClient(commits=commits, meta_by_sha=meta, diff_by_sha={"bbb": "diff --git a/b.py b/b.py\n@@ -1 +1 @@\n+x\n"})

    def failing_get(url: str, params: dict[str, Any] | None = None, **_: Any) -> FakeResponse:
        if url.endswith("aaa.diff"):
            raise RuntimeError("simulated network failure")
        return client.get(url, params)

    class Wrapper:
        get = staticmethod(failing_get)

    reader = _reader(Wrapper())
    evidence = reader.week_evidence(project_id="p1", repo_slugs=["r1"], week_start=WEEK_START, week_end=WEEK_END)
    assert evidence.tier == "tier2"
    assert "bbb" in evidence.repos[0].diffs
    assert any("aaa" in error for error in evidence.repos[0].fetch_errors)


def test_tier2_selects_largest_commits_first_when_over_budget() -> None:
    commits = [
        _commit("small", "small real change", "2026-03-03T00:00:00Z"),
        _commit("large", "large real change", "2026-03-04T00:00:00Z"),
    ]
    meta = {
        "small": _meta(additions=200, deletions=0, files=[{"filename": "a.py", "status": "modified"}]),
        "large": _meta(additions=900, deletions=0, files=[{"filename": "b.py", "status": "modified"}]),
    }
    diffs = {
        "small": "diff --git a/a.py b/a.py\n@@ -1 +1 @@\n+x\n",
        "large": "diff --git a/b.py b/b.py\n@@ -1 +1 @@\n+y\n",
    }
    client = FakeGiteaClient(commits=commits, meta_by_sha=meta, diff_by_sha=diffs)
    reader = _reader(client)
    reader.week_evidence(project_id="p1", repo_slugs=["r1"], week_start=WEEK_START, week_end=WEEK_END)
    # Both fit under the default 60KB budget, but confirm selection order was largest-first.
    assert client.diff_calls[0] == "large"
    assert client.diff_calls[1] == "small"


def test_commits_outside_the_window_are_dropped_even_if_gitea_returns_them() -> None:
    """Regression: Gitea's server-side since/until on /commits is not reliably
    restrictive on its own (confirmed against the real deployed instance --
    a request scoped to one week returned a commit from ~7 weeks later)."""
    commits = [
        _commit("in1234567", "in-window commit", "2026-03-04T00:00:00Z"),
        _commit("out123456", "way outside the requested week", "2026-04-28T00:00:00Z"),
    ]
    meta = {"in1234567": _meta(additions=3, deletions=1, files=[{"filename": "README.md", "status": "modified"}])}
    client = FakeGiteaClient(commits=commits, meta_by_sha=meta)
    reader = _reader(client)
    evidence = reader.week_evidence(project_id="p1", repo_slugs=["r1"], week_start=WEEK_START, week_end=WEEK_END)
    shas = {commit.sha for commit in evidence.repos[0].commits}
    assert shas == {"in1234567"}


def test_history_metadata_never_calls_stat_or_diff() -> None:
    """Cost-regression guard: the shallow layer must stay cheap regardless
    of how many commits/how much history it covers."""
    commits = [_commit(f"sha{i:04d}", f"commit {i}", f"2026-{2 + i // 20:02d}-{1 + i % 20:02d}T00:00:00Z") for i in range(80)]
    client = FakeGiteaClient(commits=commits, meta_by_sha={})
    reader = GiteaCodeEvidenceReader(base_url="https://gitea.example", token="tok", organization="org", client=client)
    result = reader.history_metadata(["r1"], start=date(2026, 1, 1), end=date(2026, 6, 1))
    assert client.stat_calls == []
    assert client.diff_calls == []
    assert sum(result.weeks_counts.values()) == 80


def test_history_metadata_buckets_by_iso_week() -> None:
    commits = [
        _commit("a1234567", "one", "2026-03-04T00:00:00Z"),
        _commit("a2234567", "two", "2026-03-05T00:00:00Z"),
        _commit("a3234567", "three", "2026-03-11T00:00:00Z"),
    ]
    client = FakeGiteaClient(commits=commits, meta_by_sha={})
    reader = GiteaCodeEvidenceReader(base_url="https://gitea.example", token="tok", organization="org", client=client)
    result = reader.history_metadata(["r1"], start=date(2026, 3, 1), end=date(2026, 3, 31))
    assert result.weeks_counts == {date(2026, 3, 2): 2, date(2026, 3, 9): 1}


def test_history_metadata_caps_subject_samples() -> None:
    commits = [_commit(f"s{i:04d}", f"subject {i}", "2026-03-04T00:00:00Z") for i in range(10)]
    client = FakeGiteaClient(commits=commits, meta_by_sha={})
    limits = DiffLimits(max_history_subject_samples=3)
    reader = GiteaCodeEvidenceReader(base_url="https://gitea.example", token="tok", organization="org", client=client, limits=limits)
    result = reader.history_metadata(["r1"], start=date(2026, 3, 1), end=date(2026, 3, 31))
    assert len(result.subject_samples) == 3
    assert sum(result.weeks_counts.values()) == 10


def test_history_metadata_isolates_per_repo_failures() -> None:
    commits = [_commit("ok1234567", "fine", "2026-03-04T00:00:00Z")]
    client = FakeGiteaClient(commits=commits, meta_by_sha={})

    def failing_get(url: str, params: dict[str, Any] | None = None, **_: Any) -> FakeResponse:
        if "bad-repo" in url:
            raise OSError("simulated network failure")
        return client.get(url, params)

    class Wrapper:
        get = staticmethod(failing_get)

    reader = GiteaCodeEvidenceReader(base_url="https://gitea.example", token="tok", organization="org", client=Wrapper())
    result = reader.history_metadata(["bad-repo", "good-repo"], start=date(2026, 3, 1), end=date(2026, 3, 31))
    assert result.fetch_errors
    assert sum(result.weeks_counts.values()) == 1


def test_history_metadata_follows_x_hasmore_past_a_server_capped_page() -> None:
    """Gitea caps ``limit`` below what we ask for; a short page is not the last page.

    Real Gitea (MAX_RESPONSE_ITEMS, 50 by default) answers ``limit=100``
    with 50 items and advertises the rest only via ``X-HasMore``. Treating
    the short page as the end silently truncated every project's history to
    its 50 most recent commits, which starved the cumulative-progress
    shallow layer into reporting "no history" for repos with hundreds of
    commits.
    """

    server_cap = 3
    all_commits = [_commit(f"c{i:04d}", f"subject {i}", "2026-03-04T00:00:00Z") for i in range(7)]
    seen_pages: list[int] = []

    class CappedPagingClient:
        def get(self, url: str, params: dict[str, Any] | None = None, **_: Any) -> FakeResponse:
            params = params or {}
            page = int(params.get("page", 1))
            seen_pages.append(page)
            chunk = all_commits[(page - 1) * server_cap : page * server_cap]
            response = FakeResponse(payload=chunk)
            response.headers["x-hasmore"] = "true" if page * server_cap < len(all_commits) else "false"
            return response

    reader = GiteaCodeEvidenceReader(
        base_url="https://gitea.example", token="tok", organization="org", client=CappedPagingClient(),
    )
    result = reader.history_metadata(["r1"], start=date(2026, 3, 1), end=date(2026, 3, 31))
    assert sum(result.weeks_counts.values()) == len(all_commits)
    assert seen_pages == [1, 2, 3]
    assert result.truncated is False


def test_history_metadata_stops_when_x_hasmore_is_false() -> None:
    calls: list[int] = []

    class SinglePageClient:
        def get(self, url: str, params: dict[str, Any] | None = None, **_: Any) -> FakeResponse:
            calls.append(int((params or {}).get("page", 1)))
            response = FakeResponse(payload=[_commit("a1b2c3d", "only", "2026-03-04T00:00:00Z")])
            response.headers["x-hasmore"] = "false"
            return response

    reader = GiteaCodeEvidenceReader(
        base_url="https://gitea.example", token="tok", organization="org", client=SinglePageClient(),
    )
    result = reader.history_metadata(["r1"], start=date(2026, 3, 1), end=date(2026, 3, 31))
    assert calls == [1]
    assert sum(result.weeks_counts.values()) == 1
