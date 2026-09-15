"""Collector-level regressions for identity and unavailable blame semantics."""

from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "member_analytics.py"
SPEC = importlib.util.spec_from_file_location("member_analytics_collector", SCRIPT)
assert SPEC and SPEC.loader
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


def test_shared_domain_and_124_way_heuristic_cannot_propagate():
    candidates = {f"member{i}" for i in range(124)}
    assert "terpmail" not in collector.identity_alias_keys("alice", "Alice", "alice@roster.example.invalid")
    identity, resolution, matches = collector.resolve_member_with_evidence(
        "", "Shared", "", {}, candidate_index={"shared": candidates}
    )
    assert matches == []
    assert resolution == "heuristic_candidates_suppressed"


def test_exact_full_email_handles_quote_transport_noise():
    result = collector.resolve_member_with_evidence(
        "", "Unrelated Name", "“alice@example.test”", {"email:alice@example.test": "alice"}
    )
    assert result == ("alice", "global_exact_email", [])


def test_untyped_name_equal_to_login_does_not_reuse_canonical_metric_key():
    result = collector.resolve_member_with_evidence(
        "", "alice", "", {"login:alice": "alice"}, candidate_index={"alice": {"alice"}}
    )
    assert result[0] != "alice"
    assert result[1:] == ("heuristic_candidate_only", ["alice"])


def test_only_typed_exact_identity_is_automatic():
    strong = {
        "login:alice": "alice",
        "email:alice@example.test": "alice",
    }
    candidate = {}
    for key in collector.identity_alias_keys("alice", "Alice Example", "alice@example.test"):
        candidate.setdefault(key, set()).add("alice")

    exact = collector.resolve_member_with_evidence(
        "alice", "Different Display Name", "", strong, candidate_index=candidate
    )
    weak = collector.resolve_member_with_evidence(
        "", "Alice Example", "", strong, candidate_index=candidate
    )

    assert exact == ("alice", "global_exact_login", [])
    assert weak[0] == "Alice Example"
    assert weak[1] == "heuristic_candidate_only"
    assert weak[2] == ["alice"]


def test_pipeline_mode_keeps_aliases_as_review_candidates():
    strong = {
        "login:akota1": "akota1",
        "email:akota1@roster.example.invalid": "akota1",
        "login:vkota": "vkota",
        "email:vkota@roster.example.invalid": "vkota",
    }
    candidate = {}
    for login, name, email in (
        ("akota1", "Abhinav Kota", "akota1@roster.example.invalid"),
        ("vkota", "Varun Kota", "vkota@roster.example.invalid"),
    ):
        for key in collector.identity_alias_keys(login, name, email):
            candidate.setdefault(key, set()).add(login)

    identity = collector.resolve_member_with_evidence(
        "",
        "Abhinav Kota",
        "akota.personal@example.invalid",
        strong,
        candidate_index=candidate,
        auto_match_candidates=True,
    )

    assert identity[0] == "Abhinav Kota <akota.personal@example.invalid>"
    assert identity[1] == "heuristic_candidate_only"
    assert identity[2] == ["akota1", "vkota"]


def test_pipeline_mode_keeps_unresolved_alias_ties_separate():
    candidate = {
        "eric": {"ehuang34", "gilerson"},
        "huang": {"ehuang34"},
        "gilerson": {"gilerson"},
    }

    identity = collector.resolve_member_with_evidence(
        "",
        "Eric",
        "unknown@example.test",
        {},
        candidate_index=candidate,
        auto_match_candidates=True,
    )

    assert identity[0] == "Eric <unknown@example.test>"
    assert identity[1] == "heuristic_candidate_only"


def test_conflicting_strong_identifiers_stay_unmatched():
    strong = {
        "login:alice": "alice",
        "email:bob@example.test": "bob",
    }

    identity, resolution, candidates = collector.resolve_member_with_evidence(
        "alice", "", "bob@example.test", strong
    )

    assert identity == "alice [unmatched identity]"
    assert resolution == "ambiguous_strong_identity"
    assert candidates == ["alice", "bob"]


def test_blank_metric_does_not_encode_unavailable_blame_as_zero():
    metric = collector.blank_metric({"login": "alice"})

    assert metric["blame_lines"] is None
    assert metric["blame_files"] is None


def test_commit_author_never_falls_back_to_committer_account():
    raw = {
        "author": None,
        "committer": {"login": "mbanga1", "full_name": "Michael Banga"},
        "commit": {
            "author": {"name": "K Chen", "email": "kchen@example.test"},
            "committer": {"name": "Michael Banga", "email": "mbanga@example.test"},
        },
    }

    identities = collector.commit_identities(raw)
    assert identities["author"] == {"login": "", "name": "K Chen", "email": "kchen@example.test"}
    assert identities["committer"]["login"] == "mbanga1"
    assert identities["author"]["login"] == ""


def test_pagination_preserves_successful_pages_and_records_partial_coverage():
    class PagingGitea(collector.Gitea):
        def __init__(self):
            super().__init__("https://gitea.example.test", "token")

        def get(self, path, **params):
            if params["page"] == 1:
                return list(range(collector.PAGE_SIZE))
            raise RuntimeError("second page unavailable")

    api = PagingGitea()
    records = api.try_pages("/orgs/example/members")

    assert len(records) == collector.PAGE_SIZE
    assert api.coverage[-1]["status"] == "partial"
    assert api.coverage[-1]["failed_page"] == 2
    assert api.coverage[-1]["record_count"] == collector.PAGE_SIZE


def test_pagination_rejects_malformed_and_repeated_pages():
    class MalformedGitea(collector.Gitea):
        def __init__(self):
            super().__init__("https://gitea.example.test", "token")

        def get(self, path, **params):
            return {"message": "not a list"}

    malformed = MalformedGitea()
    assert malformed.try_pages("/orgs/example/members") == []
    assert malformed.coverage[-1]["status"] == "failed"

    class RepeatingGitea(collector.Gitea):
        def __init__(self):
            super().__init__("https://gitea.example.test", "token")

        def get(self, path, **params):
            return list(range(collector.PAGE_SIZE))

    repeating = RepeatingGitea()
    assert len(repeating.try_pages("/orgs/example/members")) == collector.PAGE_SIZE
    assert repeating.coverage[-1]["status"] == "partial"
    assert "repeated page" in repeating.coverage[-1]["error"]


def test_commit_detail_enrichment_marks_line_and_file_stats_complete():
    class DetailGitea:
        failures = []
        coverage = []

        def get(self, path, **params):
            assert path.endswith("/git/commits/abc123")
            return {
                "stats": {"additions": 7, "deletions": 2},
                "files": [{"filename": "src/app.py"}],
            }

    commit = {"sha": "abc123", "stats": {}, "files": []}
    collector.enrich_commit_details(DetailGitea(), "OrgA", "repo-a", commit)

    assert commit["stats_status"] == "complete"
    assert commit["files_status"] == "complete"
    assert commit["stats"]["additions"] == 7
    assert commit["files"][0]["filename"] == "src/app.py"


def test_null_commit_stats_are_unavailable_not_complete():
    commit = {"sha": "abc123", "stats": {}, "files": []}
    collector._apply_commit_detail(
        commit,
        {"stats": {"additions": None, "deletions": None}, "files": []},
    )

    assert commit["stats_status"] == "unavailable"
    assert commit["files_status"] == "complete"


def test_collect_repo_enriches_a_feature_branch_commit_before_aggregation():
    class RepoGitea:
        failures = []
        coverage = []

        def try_pages(self, path, **params):
            if path.endswith("/branches"):
                return [{"name": "main"}, {"name": "feature/data-quality"}]
            if path.endswith("/commits"):
                return [{
                    "sha": "feature123",
                    "author": {"login": "alice"},
                    "commit": {
                        "author": {"name": "Alice", "email": "alice@example.test"},
                        "committer": {"name": "Alice", "email": "alice@example.test", "date": "2026-09-01T00:00:00Z"},
                    },
                    "parents": [{"sha": "parent"}],
                }]
            return []

        def get(self, path, **params):
            assert path.endswith("/git/commits/feature123")
            return {
                "stats": {"additions": 11, "deletions": 4},
                "files": [{"filename": "src/feature.py"}],
            }

    metrics = {}
    repo = collector.collect_repo(
        RepoGitea(),
        "OrgA",
        {"name": "repo-a", "default_branch": "main"},
        {"login:alice": "alice", "email:alice@example.test": "alice"},
        metrics,
        all_branches=True,
    )

    assert repo["commit_stats"]["status"] == "complete"
    assert repo["commits"][0]["stats_status"] == "complete"
    assert metrics["alice"]["additions"] == 11
    assert metrics["alice"]["deletions"] == 4


def test_pull_commit_membership_is_separate_from_authored_pr_metrics():
    class PullMembershipGitea:
        failures = []
        coverage = []

        def try_pages(self, path, **params):
            if path.endswith("/branches"):
                return [{"name": "main"}]
            if path.endswith("/commits") and "/pulls/" not in path:
                return []
            if path.endswith("/pulls"):
                return [{
                    "number": 7,
                    "user": {"login": "reviewer", "full_name": "Reviewer"},
                    "created_at": "2026-09-01T00:00:00Z",
                    "merged_at": "2026-09-02T00:00:00Z",
                    "merge_commit_sha": "merge7",
                    "state": "closed",
                }]
            if "/pulls/7/commits" in path:
                return [{
                    "sha": "alice-pr-commit",
                    "author": {"login": "alice", "full_name": "Alice"},
                    "commit": {"author": {"name": "Alice", "email": "alice@example.test"}},
                }]
            if "/pulls/7/reviews" in path:
                return []
            if path.endswith("/issues"):
                return []
            return []

    metrics = {}
    repo = collector.collect_repo(
        PullMembershipGitea(),
        "OrgA",
        {"name": "repo-a", "default_branch": "main"},
        {"login:alice": "alice", "email:alice@example.test": "alice", "login:reviewer": "reviewer"},
        metrics,
        all_branches=False,
    )

    finalized = {row["login"]: row for row in collector.finalize_metrics(metrics)}
    assert finalized["alice"]["pulls_merged"] == 0
    assert finalized["alice"]["pulls_merged_contributed_to"] == 1
    assert finalized["alice"]["merged_pull_commits_authored"] == 1
    assert repo["pulls"][0]["contributing_authors"][0]["identity"] == "alice"
