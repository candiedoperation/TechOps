"""Typed identity, authoritative null, and local extraction regressions."""
from __future__ import annotations

import json
import subprocess
import sys
import types
import zipfile
from argparse import Namespace

import pytest

from backend.gitea_evidence import metric_snapshot
from backend.member_analytics import _identity_alias_keys
from build_member_profiles import _application_evidence, application_rating, build, extract_resume_text
from scripts.build_llm_ranking_export import application_evidence, build_pull_registry
from scripts.member_analytics import blank_metric, finalize_metrics, resolve_member_with_evidence, update_commit


def profiles(tmp_path, members, records):
    archive_path = tmp_path / "peopleportal.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        for name, value in {"active-members.json": members, "applications.json": [], "teams.json": [],
                            "manifest.json": {"resumes": [], "summary": {}}, "failures.json": []}.items():
            archive.writestr(f"peopleportal/{name}", json.dumps(value))
    analytics_path = tmp_path / "analytics.json"
    analytics_path.write_text(json.dumps({"members": records, "organizations": [], "coverage": []}))
    return build(Namespace(peopleportal_zip=archive_path, gitea_analytics=analytics_path,
                          gitea_manifest=tmp_path / "manifest.json", output_dir=tmp_path))


def test_candidate_ids_use_email_linked_gitea_logins_not_portal_usernames(tmp_path):
    member = {"email": "person@example.test", "username": "portal-name", "active": True}
    records = [
        {"login": "gitea-name", "email": member["email"], "roster_member": True, "commits": 0},
        {"login": "git-author", "email": "author@example.test", "roster_member": False, "commits": 16,
         "identity_aliases": [{"resolution": "heuristic_candidate_only", "candidate_identities": ["gitea-name"]}]},
        {"login": "other-author", "email": "other@example.test", "roster_member": False, "commits": 99,
         "identity_aliases": [{"resolution": "heuristic_candidate_only", "candidate_identities": ["portal-name"]}]},
    ]
    artifact = profiles(tmp_path, [member], records)
    gitea = artifact["profiles"][0]["gitea"]
    assert gitea["metrics"]["commits"] == 0
    assert [row["commits"] for row in gitea["candidateRecords"]] == [16]


def test_ambiguous_gitea_roster_login_does_not_select_one_portal_member(tmp_path):
    members = [{"email": f"{name}@example.test", "username": name, "active": True} for name in ("a", "b")]
    records = [{"login": "shared-login", "email": member["email"], "roster_member": True} for member in members]
    records.append({"login": "git-author", "roster_member": False, "commits": 9,
                    "identity_aliases": [{"resolution": "heuristic_candidate_only", "candidate_identities": ["shared-login"]}]})
    artifact = profiles(tmp_path, members, records)
    assert all(not row["gitea"]["candidateRecords"] for row in artifact["profiles"])


def test_duplicate_peopleportal_email_is_quarantined_not_first_write_wins(tmp_path):
    members = [
        {"email": " Alice@example.test ", "username": "alice-one", "active": True},
        {"email": "alice@EXAMPLE.test", "username": "alice-two", "active": True},
    ]
    artifact = profiles(
        tmp_path,
        members,
        [{"login": "alice-gitea", "email": "alice@example.test", "roster_member": True, "commits": 12}],
    )

    assert artifact["summary"]["profilesIncluded"] == 0
    assert artifact["summary"]["duplicateActiveMemberEmails"] == 1
    assert artifact["quarantined_peopleportal_members"][0]["included_in_canonical_profiles"] is False
    assert artifact["summary"]["giteaUnmatchedRecords"] == 1


def test_pending_record_never_becomes_canonical_through_summary_email(tmp_path):
    member = {"email": "alice@example.test", "username": "alice", "active": True}
    record = {"login": "unmatched-alice", "email": member["email"], "roster_member": False, "commits": 99,
              "identity_aliases": [{"resolution": "ambiguous_strong_identity", "candidate_identities": ["alice", "bob"]}]}
    artifact = profiles(tmp_path, [member], [record])
    assert artifact["profiles"][0]["gitea"]["matched"] is False
    assert artifact["profiles"][0]["gitea"]["metrics"]["commits"] is None


def test_duplicate_exact_email_cannot_be_resolved_by_local_scope():
    result = resolve_member_with_evidence(
        "", "Alice", "shared@example.test", {"email:shared@example.test": {"alice", "bob"}},
        scoped_index={"email:shared@example.test": "alice"},
    )
    assert result[1] == "ambiguous_strong_identity"
    assert result[2] == ["alice", "bob"]


def test_legacy_rendered_identity_is_not_a_typed_login_or_email():
    assert _identity_alias_keys("Alice <alice@example.test>", "Alice", None) == set()
    assert _identity_alias_keys("Alice <alice@example.test>", "Alice", "alice@example.test") == {"email:alice@example.test"}


@pytest.mark.parametrize("stars", [None, 0, 4])
def test_detail_null_rating_is_authoritative_and_real_zero_survives(stars):
    application = {"applicationId": "1", "applicationInfo": {"stars": stars}, "applicationCard": {"stars": 0}}
    assert application_rating(application) == (stars, "applicationInfo/stars")
    assert _application_evidence([application])[2] == stars
    claims = []
    application_evidence({"person_id": "alice", "people_portal": {"applications": [application]}}, claims, 0)
    assert len(claims) == (0 if stars is None else 1)
    if claims:
        assert claims[0]["claim"]["stars"] == stars
        assert claims[0]["source_refs"][0]["json_pointer"].endswith("/applicationInfo/stars")


@pytest.mark.parametrize("failure", [False, True])
def test_empty_or_failed_pypdf_uses_local_poppler_fallback(monkeypatch, tmp_path, failure):
    class Reader:
        def __init__(self, path):
            if failure:
                raise ValueError("unsupported PDF text encoding")
            self.pages = [types.SimpleNamespace(extract_text=lambda: "")]

    monkeypatch.setitem(sys.modules, "pypdf", types.SimpleNamespace(PdfReader=Reader))
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, stdout="Resume experience text", stderr="")

    monkeypatch.setattr(subprocess, "run", run)
    assert extract_resume_text(tmp_path / "resume.pdf") == ("Resume experience text", "complete")
    assert calls[0][0] == "pdftotext"


def test_unknown_commit_reachability_is_not_branch_only_activity():
    metrics = {"alice": blank_metric({"login": "alice"})}
    update_commit(metrics, "alice", {"sha": "unknown", "branches": []}, "Org", "repo")
    row = metric_snapshot(finalize_metrics(metrics)[0])
    assert row["commits"] == 1
    assert row["commits_branch_only"] is None
    assert row["commits_default_reachable"] is None
    assert row["availability"]["commits_branch_only"] == "partial"


def test_mixed_typed_contributor_group_cannot_attribute_all_shas():
    analytics = {"members": [{"login": "alice"}, {"login": "bob"}], "organizations": [{"organization": "Org", "repositories": [{
        "name": "repo", "pulls": [{"number": 1, "author_identity": {"login": "alice"}, "contributing_authors": [{
            "identity": "alice", "resolution": "organization_exact_login", "commit_shas": ["a", "b"],
            "author_identities": [{"login": "alice"}, {"login": "bob"}],
        }]}],
    }]}]}
    _, refs, pending = build_pull_registry(analytics)
    assert [ref["relationship"] for ref in refs["alice"]] == ["authored_pr"]
    assert any(row["relationship"] == "contributed_commit" for row in pending)
