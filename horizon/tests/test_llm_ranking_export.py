"""JSON/JSONL provenance regressions for the profile and evidence pipeline."""

from __future__ import annotations

import json
import zipfile
from argparse import Namespace

import pytest

from backend.gitea_evidence import METRIC_FIELDS, apply_collection_coverage, metric_snapshot
from build_member_profiles import build as build_profiles
from scripts.build_llm_ranking_export import build as build_export, build_pull_registry


def record(login, email, *, candidate=None, **metrics):
    return {
        "login": login,
        "email": email,
        "name": login,
        "roster_member": candidate is None,
        "organizations": ["Org"],
        "repositories": ["Org/repo"],
        **{field: 0 for field in METRIC_FIELDS},
        **metrics,
        "identity_aliases": [] if candidate is None else [{
            "resolution": "heuristic_candidate_only",
            "candidate_identities": candidate,
            "email": email,
            "login": None,
            "name": login,
        }],
    }


@pytest.fixture
def pipeline(tmp_path):
    members = [
        {"email": f"{login}@example.test", "name": login, "username": login, "active": True}
        for login in ("yashwant", "alice", "unlinked", "multi", "member0")
    ]
    archive_path = tmp_path / "peopleportal.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        for filename, payload in {
            "active-members.json": members,
            "applications.json": [{
                "memberEmail": "alice@example.test",
                "applicationId": "app-alice",
                "applicationInfo": {
                    "responses": {"What/how~now?": "A source-grounded answer."},
                    "notes": "An interviewer observation.",
                    "stars": None,
                },
                "applicationCard": {"stars": 0},
            }],
            "teams.json": [],
            "manifest.json": {"resumes": [], "summary": {}},
            "failures.json": [],
        }.items():
            archive.writestr(f"peopleportal/{filename}", json.dumps(payload))
    records = [
        record("yashwant", "yashwant@example.test"),
        record("alice", "alice@example.test"),
        record("multi", "multi@example.test"),
        record("creator <git@example.test>", "git@example.test", candidate=["yashwant"], commits=16,
               pulls_contributed_to=3, pulls_merged_contributed_to=2, merged_pull_commits_authored=13),
        record("alias1", "alias1@example.test", candidate=["multi"], commits=3),
        record("alias2", "alias2@example.test", candidate=["multi"], commits=7),
        record("Shared", "shared@example.test", candidate=[f"member{i}" for i in range(124)], commits=100),
    ]
    alice = {"login": "alice", "email": "alice@example.test", "resolution": "organization_exact_email_and_login"}
    pulls = [{"number": 1, "author_identity": alice, "merged": True, "contributing_authors": [
        {"identity": "alice", "resolution": "organization_exact_email_and_login", "commit_shas": ["exact"]},
        {"identity": records[3]["login"], "resolution": "heuristic_candidate_only", "candidate_identities": ["yashwant"], "commit_shas": ["candidate"]},
        {"identity": "Shared", "resolution": "heuristic_candidate_only", "candidate_identities": [f"member{i}" for i in range(124)], "commit_shas": ["broad"]},
    ]}]
    analytics = {
        "generated_at": "2026-09-01T00:00:00Z",
        "members": records,
        "coverage": [],
        "organizations": [{"organization": "Org", "repositories": [{
            "name": "repo", "pulls": pulls, "commits": [{"sha": "exact", "author_identity": alice}],
        }]}],
    }
    (tmp_path / "analytics.json").write_text(json.dumps(analytics))
    (tmp_path / "manifest.json").write_text("{}")
    profiles = build_profiles(Namespace(
        peopleportal_zip=archive_path,
        gitea_analytics=tmp_path / "analytics.json",
        gitea_manifest=tmp_path / "manifest.json",
        output_dir=tmp_path,
    ))
    build_export(Namespace(root=tmp_path, output=tmp_path / "llm-ranking-export"))
    return tmp_path, profiles


def read_cards(root):
    return [json.loads(line) for line in (root / "llm-ranking-export/members.jsonl").read_text().splitlines()]


def test_json_export_preserves_pending_identity_evidence(pipeline):
    root, _ = pipeline
    cards = read_cards(root)
    assert all("email" not in card["member"] for card in cards)
    pending = [json.loads(line) for line in (root / "llm-ranking-export/pending-pull-identities.jsonl").read_text().splitlines()]
    broad = next(row for row in pending if row["candidate_count"] == 124)
    assert broad["reason"] == "broad_candidate_set_rejected"
    assert broad["identity"]["candidate_identities"] == []


def test_exact_typed_pull_actors_resolve():
    analytics = {"members": [record("alice", "alice@example.test")], "organizations": [{"organization": "Org", "repositories": [{
        "name": "repo", "pulls": [{"number": 1, "author_identity": {"email": "alice@example.test"}}],
    }]}]}
    pulls, refs, pending = build_pull_registry(analytics)
    assert pulls[0]["pull"]["author"] == "alice"
    assert refs["alice"][0]["attribution_status"] == "canonical_exact"
    assert pending == []


def test_ambiguous_or_untyped_pull_actor_never_resolves():
    analytics = {"members": [record("alice", "alice@example.test"), record("bob", "bob@example.test")], "organizations": [{"organization": "Org", "repositories": [{
        "name": "repo", "pulls": [{"number": 1, "author_identity": {"name": "alice"}}],
    }]}]}
    pulls, refs, pending = build_pull_registry(analytics)
    assert not refs
    assert len(pending) == 1


@pytest.mark.parametrize("status,value", [("complete", 0), ("unavailable", None), ("failed", 0), ("partial", 3)])
def test_zero_and_unavailable_states_are_distinct(status, value):
    result = metric_snapshot({"commits": value, "availability": {"commits": status}})
    assert result["availability"]["commits"] == status
    assert result["commits"] == (value if status == "complete" else None)
    if value is not None and status != "complete":
        assert result["observed_values"]["commits"] == value


def test_missing_coverage_and_failed_endpoint_cannot_imply_zero():
    row = record("alice", "alice@example.test")
    unknown = apply_collection_coverage(row, None)
    assert unknown["commits"] is None
    assert unknown["availability"]["commits"] == "unknown"
    failed = apply_collection_coverage(row, [{"path": "/repos/Org/repo/pulls", "status": "failed"}])
    assert failed["pulls_merged"] is None
    assert failed["availability"]["pulls_merged"] == "failed"
    assert failed["commits"] == 0


def test_export_is_byte_deterministic_and_rejects_stale_profile_sources(pipeline):
    root, _ = pipeline
    manifest = root / "llm-ranking-export/manifest.json"
    before = manifest.read_bytes()
    build_export(Namespace(root=root, output=root / "llm-ranking-export"))
    assert manifest.read_bytes() == before
    source = root / "analytics.json"
    source.write_text(source.read_text() + " ")
    with pytest.raises(ValueError, match="rebuild member profiles"):
        build_export(Namespace(root=root, output=root / "llm-ranking-export"))
