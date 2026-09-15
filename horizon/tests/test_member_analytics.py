"""Ingestion and HTTP tests for the Gitea member-analytics feature.

These documents carry named per-person metrics, which is a deliberate
exception to the aggregate-only shape of the rest of the backend, so the
tests below pin the identity handling as much as the arithmetic.
"""

from __future__ import annotations

import json

import pytest

from backend.member_analytics import (
    build_documents,
    ingest_file,
    ingest_payload,
    run_id_from_payload,
)


GENERATED_AT = "2026-08-28T07:11:46.786574+00:00"


def payload(**overrides) -> dict:
    """A minimal but structurally complete analytics payload."""
    base = {
        "generated_at": GENERATED_AT,
        "gitea_url": "https://git.example.test",
        "history_scope": "default branch and all discovered branches",
        "commit_stats_scope": "default branch commits only",
        "blame_method": "native git blame over SSH",
        "api_calls": 275,
        "warnings": ["/repos/org-a/repo-b/pulls: HTTP 404"],
        "organizations": [
            {
                "organization": "OrgA",
                "member_count": 3,
                "repositories": [
                    {
                        "organization": "OrgA",
                        "name": "repo-a",
                        "default_branch": "main",
                        "html_url": "https://git.example.test/OrgA/repo-a",
                        "branches": ["main", "feat"],
                        "commits": [{"sha": "a1"}, {"sha": "a2"}],
                        "pulls": [{"number": 1, "merged": True}, {"number": 2, "merged": False}],
                        "issue_count": 4,
                    }
                ],
            },
            {"organization": "EmptyOrg", "member_count": 2, "repositories": []},
        ],
        "members": [
            {
                "login": "adevlin",
                "name": "A Devlin",
                "email": "adevlin@example.test",
                "organizations": ["OrgA"],
                "commits": 10,
                "additions": 500,
                "deletions": 50,
                "unique_files": 12,
                "pulls_opened": 2,
                "pulls_merged": 1,
                "reviews_submitted": 3,
                "reviews_approved": 2,
                "issues_opened": 1,
                "active_days": 5,
                "blame_lines": 400,
                "blame_files": 9,
                "repositories": ["OrgA/repo-a"],
                "first_activity": "2026-08-01T00:00:00+00:00",
                "last_activity": "2026-08-20T00:00:00+00:00",
                "roster_member": True,
            },
            {"login": "quiet", "name": "Quiet Member", "organizations": ["EmptyOrg"]},
            {"login": "gitadmin", "organizations": ["OrgA"], "service_or_admin": True},
            {
                "login": "Someone <someone@example.test>",
                "name": "Someone",
                "organizations": ["OrgA"],
                "commits": 99,
                "roster_member": False,
            },
        ],
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Document mapping
# ---------------------------------------------------------------------------


def test_run_id_is_derived_from_generated_at():
    assert run_id_from_payload(payload()) == "20260828T071146Z"


def test_explicit_unavailable_activity_is_not_coerced_to_zero():
    _, members = build_documents(payload(
        identity_resolution={"schema": "gitea.identity-resolution.v2"},
        members=[{"login": "alice", "commits": None, "pulls_merged": None,
                  "reviews_submitted": None, "active_days": None}],
    ))
    assert members[0].commits is None
    assert members[0].pulls_merged is None
    assert members[0].reviews_submitted is None
    assert members[0].active_days is None


def test_run_id_requires_a_usable_timestamp():
    with pytest.raises(ValueError, match="generated_at"):
        run_id_from_payload({"members": []})


def test_build_documents_maps_run_metadata_and_rollups():
    run, members = build_documents(payload())

    assert run.run_id == "20260828T071146Z"
    assert run.api_calls == 275
    assert run.member_count == 4
    assert run.warnings == ["/repos/org-a/repo-b/pulls: HTTP 404"]
    assert [org.organization for org in run.organizations] == ["OrgA", "EmptyOrg"]
    # An organization holding no repositories is retained rather than dropped:
    # its members are legitimately unable to contribute anywhere.
    assert [org.repository_count for org in run.organizations] == [1, 0]

    assert len(run.repositories) == 1
    repo = run.repositories[0]
    assert (repo.branch_count, repo.commit_count, repo.pull_count) == (2, 2, 2)
    assert repo.merged_count == 1
    assert repo.issue_count == 4
    assert len(members) == 4


def test_weak_git_alias_is_not_folded_into_canonical_roster_member():
    run, members = build_documents(payload(members=[
        {
            "login": "yashwant",
            "name": "Yashwant Ponnaganti",
            "email": "yashwant@roster.example.invalid",
            "organizations": ["MitsubishiSPRING2026"],
            "roster_member": True,
        },
        {
            "login": "yashwant-creator <yashwant.personal@example.invalid>",
            "name": "yashwant-creator <yashwant.personal@example.invalid>",
            "organizations": ["MitsubishiSPRING2026"],
            "commits": 13,
            "additions": 18099,
            "unique_files": 78,
            "active_days": 7,
            "repositories": ["MitsubishiSPRING2026/GoodReturns"],
        },
    ]))

    assert run.member_count == 2
    assert [member.login for member in members] == ["yashwant", "yashwant-creator <yashwant.personal@example.invalid>"]
    yashwant = members[0]
    assert (yashwant.commits, yashwant.additions, yashwant.unique_files, yashwant.active_days) == (None, None, None, None)
    assert yashwant.repositories == []


def test_legacy_exact_email_alias_can_be_folded():
    legacy = payload(members=[
        {
            "login": "alice",
            "name": "Alice",
            "email": "alice@example.test",
            "organizations": ["OrgA"],
            "roster_member": True,
        },
        {
            "login": "Alice Work <alice@example.test>",
            "name": "Alice Work",
            "email": "alice@example.test",
            "organizations": ["OrgA"],
            "commits": 3,
            "roster_member": False,
        },
    ])

    run, members = build_documents(legacy)

    assert run.member_count == 1
    assert members[0].login == "alice"
    assert members[0].commits is None  # Missing canonical activity cannot become zero.


def test_v2_resolution_is_never_reinterpreted_downstream():
    current = payload(
        identity_resolution={"schema": "gitea.identity-resolution.v2"},
        members=[
            {
                "login": "alice",
                "email": "alice@example.test",
                "organizations": ["OrgA"],
                "roster_member": True,
            },
            {
                "login": "alice [unmatched identity]",
                "email": "alice@example.test",
                "organizations": ["OrgA"],
                "commits": 3,
                "roster_member": False,
            },
        ],
    )

    run, members = build_documents(current)

    assert run.member_count == 2
    assert [member.login for member in members] == ["alice", "alice [unmatched identity]"]


def test_disabled_blame_is_preserved_as_unavailable():
    disabled = payload(
        blame_method=None,
        blame={"status": "disabled", "method": None, "requested_repositories": 0, "completed_repositories": 0},
    )
    for member in disabled["members"]:
        member["blame_lines"] = None
        member["blame_files"] = None

    run, members = build_documents(disabled)

    assert run.blame_status == "disabled"
    assert run.blame_method is None
    assert all(member.blame_lines is None and member.blame_files is None for member in members)


def test_incomplete_line_stats_and_collection_coverage_remain_explicit():
    current = payload(
        coverage=[
            {
                "path": "/repos/OrgA/repo-a/git/commits/feature123",
                "params": {},
                "status": "failed",
                "page_count": 1,
                "record_count": 0,
            }
        ],
        identity_resolution={"schema": "gitea.identity-resolution.v2"},
        members=[
            {
                "login": "alice",
                "email": "alice@example.test",
                "organizations": ["OrgA"],
                "commits": 1,
                "additions": None,
                "deletions": None,
                "files_changed": None,
                "unique_files": None,
                "commit_stats_status": "failed",
                "file_stats_status": "failed",
                "commit_stats_failed": 1,
                "file_stats_failed": 1,
                "identity_aliases": [{"resolution": "unmatched_email", "candidate_identities": ["alice"]}],
                "roster_member": True,
            }
        ],
    )

    run, members = build_documents(current)

    assert run.coverage[0]["status"] == "failed"
    assert members[0].additions is None
    assert members[0].unique_files is None
    assert members[0].commit_stats_status == "failed"
    assert members[0].identity_aliases[0]["resolution"] == "unmatched_email"


def test_member_metrics_carry_identity_and_counters():
    _, members = build_documents(payload())
    devlin = next(m for m in members if m.login == "adevlin")

    assert devlin.name == "A Devlin"
    assert (devlin.commits, devlin.additions, devlin.blame_lines) == (10, 500, 400)
    assert devlin.roster_member is True
    assert devlin.has_activity is True
    assert devlin.first_activity is not None and devlin.last_activity is not None


def test_member_with_no_counters_reports_no_activity():
    _, members = build_documents(payload())
    quiet = next(m for m in members if m.login == "quiet")

    assert quiet.has_activity is False
    assert quiet.commits is None
    # A roster member with nothing to contribute to is still a roster member.
    assert quiet.roster_member is True


def test_service_account_flag_survives_ingestion():
    _, members = build_documents(payload())
    assert next(m for m in members if m.login == "gitadmin").service_or_admin is True


def test_roster_member_is_inferred_when_the_payload_predates_the_flag():
    """Runs collected before ``roster_member`` existed still separate correctly."""
    legacy = payload()
    for member in legacy["members"]:
        member.pop("roster_member", None)

    _, members = build_documents(legacy)
    by_login = {m.login: m for m in members}

    assert by_login["adevlin"].roster_member is True
    assert by_login["gitadmin"].roster_member is True
    # "Name <email>" is how the collector renders an unmatched commit identity.
    assert by_login["Someone <someone@example.test>"].roster_member is False


def test_members_without_a_login_are_rejected():
    broken = payload(members=[{"login": "", "commits": 5}, {"name": "no login"}])
    with pytest.raises(ValueError, match="login is required"):
        build_documents(broken)


def test_explicit_run_id_overrides_the_derived_one():
    run, members = build_documents(payload(), run_id="custom-run")
    assert run.run_id == "custom-run"
    assert {m.run_id for m in members} == {"custom-run"}


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


async def test_ingest_persists_run_and_members(in_memory_store):
    result = await ingest_payload(payload())

    assert result["members"] == 4
    assert result["replaced"] is False

    run = await in_memory_store.latest_member_analytics_run()
    assert run.run_id == "20260828T071146Z"
    metrics = await in_memory_store.member_metrics_for_run(run.run_id)
    assert len(metrics) == 4


async def test_reingesting_a_run_is_idempotent_and_conflicts_need_new_version(in_memory_store):
    original = payload()
    await ingest_payload(original)
    result = await ingest_payload(original)
    assert result["replaced"] is True
    with pytest.raises(ValueError, match="different content"):
        await ingest_payload(payload(members=[{"login": "adevlin", "commits": 1}]))
    runs = await in_memory_store.member_analytics_runs()
    assert len(runs) == 1
    assert len(await in_memory_store.member_metrics_for_run(runs[0].run_id)) == 4


async def test_latest_run_is_the_most_recently_generated(in_memory_store):
    await ingest_payload(payload())
    await ingest_payload(payload(generated_at="2026-09-01T00:00:00+00:00"))

    run = await in_memory_store.latest_member_analytics_run()
    assert run.run_id == "20260901T000000Z"
    assert len(await in_memory_store.member_analytics_runs()) == 2


async def test_member_lookup_is_scoped_to_its_run(in_memory_store):
    await ingest_payload(payload())
    run = await in_memory_store.latest_member_analytics_run()

    assert (await in_memory_store.member_metric(run.run_id, "adevlin")).commits == 10
    assert await in_memory_store.member_metric(run.run_id, "absent") is None
    assert await in_memory_store.member_metric("other-run", "adevlin") is None


async def test_ingest_file_reads_a_run_directory(in_memory_store, tmp_path):
    run_dir = tmp_path / "20260830T120000Z"
    run_dir.mkdir()
    (run_dir / "analytics.json").write_text(json.dumps(payload()), encoding="utf-8")

    result = await ingest_file(run_dir)
    # The directory names the run, overriding the payload's own timestamp.
    assert result["run_id"] == "20260830T120000Z"


async def test_ingest_file_ignores_the_rolling_latest_directory_name(in_memory_store, tmp_path):
    latest = tmp_path / "latest"
    latest.mkdir()
    (latest / "analytics.json").write_text(json.dumps(payload()), encoding="utf-8")

    result = await ingest_file(latest)
    # "latest" is a copy of the newest run, not a run id of its own.
    assert result["run_id"] == "20260828T071146Z"


async def test_ingest_file_reports_a_missing_payload(in_memory_store, tmp_path):
    with pytest.raises(FileNotFoundError):
        await ingest_file(tmp_path / "nope.json")


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------


async def test_endpoints_404_before_any_run_is_ingested(empty_app_client):
    for path in ("/analytics/summary", "/analytics/members", "/analytics/organizations"):
        response = await empty_app_client.get(path)
        assert response.status_code == 404, path
        assert "no analytics run" in response.json()["detail"]


async def test_summary_totals_and_warnings(empty_app_client):
    await ingest_payload(payload())
    body = (await empty_app_client.get("/analytics/summary")).json()

    totals = body["totals"]
    assert totals["organizations"] == 2
    assert totals["repositories"] == 1
    assert totals["roster_members"] == 2      # adevlin + quiet
    assert totals["unmatched_identities"] == 1
    assert totals["service_accounts"] == 1
    assert totals["active_members"] == 1      # only adevlin has counters
    assert totals["commits"] == 2             # repository commits, not member sums
    assert totals["merged_pull_requests"] == 1
    assert body["run"]["warnings"] == ["/repos/org-a/repo-b/pulls: HTTP 404"]
    assert "not a performance score" in body["disclaimer"]


async def test_members_rank_roster_above_unmatched_regardless_of_volume(empty_app_client):
    await ingest_payload(payload())
    body = (await empty_app_client.get("/analytics/members")).json()

    logins = [m["login"] for m in body["members"]]
    # The unmatched identity has 99 commits against adevlin's 10 and must still
    # sort below every roster member, with the service account last.
    assert logins[0] == "adevlin"
    assert logins.index("Someone <someone@example.test>") < logins.index("gitadmin")
    assert logins[-1] == "gitadmin"


async def test_members_filters(empty_app_client):
    await ingest_payload(payload())

    roster_only = await empty_app_client.get(
        "/analytics/members", params={"include_unmatched": False, "include_service": False}
    )
    assert {m["login"] for m in roster_only.json()["members"]} == {"adevlin", "quiet"}

    by_org = await empty_app_client.get("/analytics/members", params={"organization": "EmptyOrg"})
    assert [m["login"] for m in by_org.json()["members"]] == ["quiet"]

    by_search = await empty_app_client.get("/analytics/members", params={"search": "DEVLIN"})
    assert [m["login"] for m in by_search.json()["members"]] == ["adevlin"]

    missing = await empty_app_client.get("/analytics/members", params={"organization": "Nowhere"})
    assert missing.json()["members"] == []


async def test_members_sort_and_limit(empty_app_client):
    await ingest_payload(payload())

    by_name = await empty_app_client.get("/analytics/members", params={"sort": "name"})
    assert [m["login"] for m in by_name.json()["members"]][0] == "adevlin"

    limited = await empty_app_client.get("/analytics/members", params={"limit": 1})
    assert len(limited.json()["members"]) == 1
    # count reports the full filtered set, not the truncated page.
    assert limited.json()["count"] == 4

    rejected = await empty_app_client.get("/analytics/members", params={"sort": "salary"})
    assert rejected.status_code == 422


async def test_member_detail(empty_app_client):
    await ingest_payload(payload())

    found = await empty_app_client.get("/analytics/members/adevlin")
    assert found.status_code == 200
    assert found.json()["member"]["commits"] == 10
    assert found.json()["member"]["has_activity"] is True

    missing = await empty_app_client.get("/analytics/members/nobody")
    assert missing.status_code == 404


async def test_organizations_include_empty_orgs(empty_app_client):
    await ingest_payload(payload())
    rows = (await empty_app_client.get("/analytics/organizations")).json()["organizations"]
    by_name = {row["organization"]: row for row in rows}

    assert by_name["OrgA"]["commits"] == 2
    assert by_name["OrgA"]["active_members"] == 1
    # Members of a repo-less org have nothing to contribute to; the row still
    # appears so that absence is visible rather than silently missing.
    assert by_name["EmptyOrg"]["repositories"] == 0
    assert by_name["EmptyOrg"]["commits"] == 0
    assert by_name["EmptyOrg"]["roster"] == 2
    assert by_name["EmptyOrg"]["active_members"] == 0


async def test_org_activity_is_not_credited_from_another_org(empty_app_client):
    """A multi-org member is active only where their repositories actually are."""
    both = payload()
    both["members"].append({
        "login": "roamer",
        "name": "Roamer",
        "organizations": ["OrgA", "EmptyOrg"],
        "commits": 40,
        "repositories": ["OrgA/repo-a"],
        "roster_member": True,
    })
    await ingest_payload(both)
    rows = (await empty_app_client.get("/analytics/organizations")).json()["organizations"]
    by_name = {row["organization"]: row for row in rows}

    assert by_name["OrgA"]["active_members"] == 2       # adevlin + roamer
    # EmptyOrg lists roamer on its roster, but roamer's work is in OrgA and
    # EmptyOrg holds no repositories, so it cannot have an active member.
    assert by_name["EmptyOrg"]["roster"] == 2
    assert by_name["EmptyOrg"]["active_members"] == 0


async def test_repositories_rollup(empty_app_client):
    await ingest_payload(payload())
    rows = (await empty_app_client.get("/analytics/repositories")).json()["repositories"]

    assert len(rows) == 1
    assert rows[0]["name"] == "repo-a"
    assert rows[0]["merged_count"] == 1

    filtered = await empty_app_client.get("/analytics/repositories", params={"organization": "EmptyOrg"})
    assert filtered.json()["repositories"] == []


async def test_runs_listing_is_newest_first(empty_app_client):
    await ingest_payload(payload())
    await ingest_payload(payload(generated_at="2026-09-01T00:00:00+00:00"))

    runs = (await empty_app_client.get("/analytics/runs")).json()["runs"]
    assert [run["run_id"] for run in runs] == ["20260901T000000Z", "20260828T071146Z"]


async def test_a_named_run_can_be_queried_directly(empty_app_client):
    await ingest_payload(payload())
    await ingest_payload(payload(generated_at="2026-09-01T00:00:00+00:00"))

    pinned = await empty_app_client.get("/analytics/summary", params={"run_id": "20260828T071146Z"})
    assert pinned.json()["run"]["run_id"] == "20260828T071146Z"

    unknown = await empty_app_client.get("/analytics/summary", params={"run_id": "nope"})
    assert unknown.status_code == 404
