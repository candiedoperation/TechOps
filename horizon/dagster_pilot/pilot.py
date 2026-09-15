"""Reproducible People Portal + Gitea feature pilot.

This module is deliberately separate from Horizon production code. It models
the requested source contracts with synthetic, API-shaped records and keeps
LLM-derived features explicitly unavailable.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import dagster as dg

SEMESTERS = ["2025-fall", "2026-spring"]
PARTITIONS = dg.StaticPartitionsDefinition(SEMESTERS)


def _source(value: Any, system: str, path: str) -> dict[str, Any]:
    return {"value": value, "source": {"system": system, "path": path, "synthetic": True}}


def _members() -> list[dict[str, Any]]:
    return [
        {"id": "alice", "name": "Alice", "tenure_months": 18, "role": "member", "event_count": 4, "sow": ["payments", "platform"], "questionnaire": {"on_time_ownership": 5, "proactivity": 4, "design_influence": 5, "stakeholder_participation": 4}},
        {"id": "bob", "name": "Bob", "tenure_months": 8, "role": "tl", "event_count": 2, "sow": ["payments"], "questionnaire": {"on_time_ownership": 4, "proactivity": 5, "design_influence": 3, "stakeholder_participation": 4}},
        {"id": "cara", "name": "Cara", "tenure_months": 5, "role": "pl", "event_count": 0, "sow": ["platform"], "questionnaire": {"on_time_ownership": 3, "proactivity": 3, "design_influence": 4, "stakeholder_participation": 2}},
        {"id": "dan", "name": "Dan", "tenure_months": 2, "role": "member", "event_count": 1, "sow": [], "questionnaire": {"on_time_ownership": 2, "proactivity": 2, "design_influence": 2, "stakeholder_participation": 2}},
        {"id": "erin", "name": "Erin", "tenure_months": 24, "role": "member", "event_count": 3, "sow": ["payments"], "questionnaire": {"on_time_ownership": 5, "proactivity": 5, "design_influence": 4, "stakeholder_participation": 5}},
    ]


def _events() -> list[dict[str, Any]]:
    return [{"member_id": m, "semester": s, "attended": n} for s in SEMESTERS for m, n in {"alice": 2, "bob": 1, "cara": 0, "dan": 1, "erin": 2}.items()]


def _assignments() -> list[dict[str, Any]]:
    return [{"project": "checkout", "sow": "payments", "tl": "bob", "pl": "erin"}, {"project": "platform", "sow": "platform", "tl": "bob", "pl": "cara"}, {"project": "legacy", "sow": None, "tl": "cara", "pl": None}]


def _teams() -> list[dict[str, Any]]:
    return [{"team_id": "appdev", "member_ids": [m["id"] for m in _members()], "team_size": 5, "aggregation_eligible": True}]


def _repos() -> list[dict[str, Any]]:
    return [{"project": "checkout", "repo": "checkout-api", "areas": ["payments", "api"], "activity_coverage": 1.0}, {"project": "platform", "repo": "platform-ui", "areas": ["platform", "ui"], "activity_coverage": 0.4}, {"project": "legacy", "repo": None, "areas": [], "activity_coverage": 0.0}]


def _commits() -> list[dict[str, Any]]:
    rows = []
    counts = {"2025-fall": {"alice": 4, "bob": 3, "cara": 2, "dan": 0, "erin": 2}, "2026-spring": {"alice": 10, "bob": 5, "cara": 1, "dan": 0, "erin": 6}}
    for semester, members in counts.items():
        for member, count in members.items():
            rows.append({"semester": semester, "member_id": member, "commit_count": count, "active_days": max(0, min(count, 5)), "areas": ["payments"] if member in {"alice", "bob", "erin"} else ["platform"]})
    return rows


def _pulls() -> list[dict[str, Any]]:
    return [
        {"semester": "2026-spring", "id": "pr-1", "author": "alice", "participants": ["alice", "bob"], "project": "checkout", "area": "payments", "merged": True},
        {"semester": "2026-spring", "id": "pr-2", "author": "erin", "participants": ["erin", "alice", "bob"], "project": "checkout", "area": "payments", "merged": True},
        {"semester": "2026-spring", "id": "pr-3", "author": "cara", "participants": ["cara"], "project": "platform", "area": "ui", "merged": False},
        {"semester": "2025-fall", "id": "pr-0", "author": "alice", "participants": ["alice", "bob"], "project": "checkout", "area": "payments", "merged": True},
    ]


def _reviews() -> list[dict[str, Any]]:
    return [{"pr_id": "pr-1", "reviewer": "bob", "rating": 5, "turnaround_days": 1}, {"pr_id": "pr-2", "reviewer": "bob", "rating": 4, "turnaround_days": 4}, {"pr_id": "pr-3", "reviewer": "alice", "rating": 3, "turnaround_days": None}]


def _asset(name: str, payload: Any, path: str):
    return {"asset": name, "records": payload, "provenance": _source(f"{len(payload)} synthetic records", "mock", path), "coverage": 1.0, "flags": []}


@dg.asset(partitions_def=PARTITIONS)
def people_members(): return _asset("people_members", _members(), "/api/org/people")

@dg.asset(partitions_def=PARTITIONS)
def people_events(): return _asset("people_events", _events(), "/api/events/attendance")

@dg.asset(partitions_def=PARTITIONS)
def people_team_hierarchy(): return _asset("people_team_hierarchy", _teams(), "/api/org/teams")

@dg.asset(partitions_def=PARTITIONS)
def people_assignments(): return _asset("people_assignments", _assignments(), "/api/projects/assignments")

@dg.asset(partitions_def=PARTITIONS)
def people_questionnaires(): return _asset("people_questionnaires", [m["questionnaire"] | {"member_id": m["id"]} for m in _members()], "/api/questionnaires")

@dg.asset(partitions_def=PARTITIONS)
def gitea_repositories(): return _asset("gitea_repositories", _repos(), "/api/v1/orgs/appdev/repos")

@dg.asset(partitions_def=PARTITIONS)
def gitea_commits():
    return _asset("gitea_commits", _commits(), "/api/v1/repos/*/commits")

@dg.asset(partitions_def=PARTITIONS)
def gitea_pull_requests(): return _asset("gitea_pull_requests", _pulls(), "/api/v1/repos/*/pulls")

@dg.asset(partitions_def=PARTITIONS)
def gitea_reviews(): return _asset("gitea_reviews", _reviews(), "/api/v1/repos/*/pulls/*/reviews")


def _period(records: list[dict[str, Any]], semester: str) -> list[dict[str, Any]]:
    return [r for r in records if r.get("semester") in (None, semester)]


@dg.asset(partitions_def=PARTITIONS, deps=[people_members, people_events, people_team_hierarchy, people_assignments, people_questionnaires, gitea_repositories, gitea_commits, gitea_pull_requests, gitea_reviews])
def deterministic_features(context, people_members, people_events, people_team_hierarchy, people_assignments, people_questionnaires, gitea_repositories, gitea_commits, gitea_pull_requests, gitea_reviews):
    semester = context.partition_key; prior = "2025-fall"; members = people_members["records"]
    commits = _period(gitea_commits["records"], semester); prior_commits = _period(gitea_commits["records"], prior)
    pulls = _period(gitea_pull_requests["records"], semester); reviews = gitea_reviews["records"]
    by_member = {}
    for member in members:
        mid = member["id"]; cur = next((r for r in commits if r["member_id"] == mid), None); old = next((r for r in prior_commits if r["member_id"] == mid), None)
        member_pulls = [p for p in pulls if mid in p["participants"] or p["author"] == mid]; member_reviews = [r for r in reviews if r["reviewer"] == mid]
        q = next(q for q in people_questionnaires["records"] if q["member_id"] == mid)
        resp = sum(q[k] for k in ("on_time_ownership", "proactivity", "design_influence", "stakeholder_participation")) / 20
        attendance = next(e["attended"] for e in people_events["records"] if e["member_id"] == mid and e["semester"] == semester)
        by_member[mid] = {"member_id": mid, "appdev_tenure": _source(member["tenure_months"], "people_portal", "member.tenure_months"), "event_attendance": _source(attendance, "people_portal", "event.attended"), "commit_frequency": _source((cur or {}).get("commit_count", 0), "gitea", "commit.commit_count"), "active_days": _source((cur or {}).get("active_days", 0), "gitea", "commit.active_days"), "growth": _source((cur or {}).get("commit_count", 0) - (old or {}).get("commit_count", 0), "gitea", "current-minus-prior.commit_count"), "collaborative_prs": _source(sum(len(p["participants"]) > 1 for p in member_pulls), "gitea", "pull.participants"), "peer_review_average": _source(sum(r["rating"] for r in member_reviews) / len(member_reviews) if member_reviews else None, "gitea", "review.rating"), "review_turnaround_days": _source(sum(r["turnaround_days"] for r in member_reviews if r["turnaround_days"] is not None) / len([r for r in member_reviews if r["turnaround_days"] is not None]) if any(r["turnaround_days"] is not None for r in member_reviews) else None, "gitea", "review.turnaround_days"), "responsibility_index": _source(resp, "people_portal", "questionnaire.four_dimensions"), "experience_difficulty": {"value": None, "status": "unavailable", "source": "TBD"}, "performance_consistency": {"value": None, "status": "unavailable", "source": "Horizon weekly reports"}, "sow_final_contribution": _source(sum(1 for p in member_pulls if p["area"] in member["sow"]), "gitea+people_portal", "pull.area-vs-member.sow"), "sow_semantic_llm": {"value": None, "status": "future_optional", "source": "LLM"}, "coverage": 0.9 if cur else 0.4}
    return {"semester": semester, "prior_semester": prior, "features": by_member, "metadata": {"deterministic": True, "llm_features": "future_optional", "missingness": "null/status, never zero"}}


@dg.asset(partitions_def=PARTITIONS, deps=[deterministic_features])
def member_ranking(deterministic_features):
    rows = []
    for mid, f in deterministic_features["features"].items():
        if f["coverage"] < 0.5: continue
        components = {"tenure": min(f["appdev_tenure"]["value"] / 24, 1), "attendance": f["event_attendance"]["value"] / 2, "commits": min(f["commit_frequency"]["value"] / 10, 1), "growth": max(0, min(f["growth"]["value"] / 8, 1)), "collaboration": min(f["collaborative_prs"]["value"] / 2, 1), "review": (f["peer_review_average"]["value"] or 0) / 5, "responsibility": f["responsibility_index"]["value"]}
        score = sum(components.values()) / len(components); rows.append({"member_id": mid, "score": round(score, 4), "components": components, "coverage": f["coverage"], "source_refs": [v["source"] for v in f.values() if isinstance(v, dict) and "source" in v]})
    return {"semester": deterministic_features["semester"], "ranked": sorted(rows, key=lambda r: (-r["score"], r["member_id"])), "unavailable": ["experience_difficulty", "performance_consistency", "sow_semantic_llm"]}


@dg.asset(partitions_def=PARTITIONS, deps=[people_assignments, gitea_repositories, gitea_commits])
def project_audit(people_assignments, gitea_repositories, gitea_commits):
    flags = []
    for repo in gitea_repositories["records"]:
        if not repo["repo"]: flags.append({"project": repo["project"], "issue": "missing_repository_mapping", "source": "people_portal+gitea"})
        elif repo["activity_coverage"] < 1.0: flags.append({"project": repo["project"], "issue": "partial_or_stale_activity", "source": "gitea"})
    for assignment in people_assignments["records"]:
        if not assignment["sow"]: flags.append({"project": assignment["project"], "issue": "missing_sow_mapping", "source": "people_portal"})
    return {"flags": flags, "coverage": 1.0, "source_refs": [people_assignments["provenance"], gitea_repositories["provenance"], gitea_commits["provenance"]]}


@dg.asset(partitions_def=PARTITIONS, deps=[people_assignments, people_members, deterministic_features])
def tl_pl_sow_matching(people_assignments, people_members, deterministic_features):
    matches = []
    for a in people_assignments["records"]:
        if not a["sow"]: matches.append({"project": a["project"], "status": "unavailable", "reason": "missing_sow"}); continue
        for m in people_members["records"]:
            overlap = sorted(set(a["sow"]) & set(m["sow"]))
            if overlap and m["role"] in {"tl", "pl"}: matches.append({"project": a["project"], "member_id": m["id"], "role": m["role"], "sow_overlap": overlap, "evidence": "People Portal SOW + role", "semantic_match": "unavailable"})
    return {"matches": matches, "semantic_gap": "LLM/SOW semantics not implemented"}


defs = dg.Definitions(assets=[people_members, people_events, people_team_hierarchy, people_assignments, people_questionnaires, gitea_repositories, gitea_commits, gitea_pull_requests, gitea_reviews, deterministic_features, member_ranking, project_audit, tl_pl_sow_matching], jobs=[dg.define_asset_job("semester_pilot", selection="*")])
