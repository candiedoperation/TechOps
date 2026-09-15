#!/usr/bin/env python3
"""Build a provenance-rich hybrid export for the LLM candidate-ranking pass.

The export deliberately separates:
* one member evidence card per JSONL record;
* claim-level People Portal and Gitea evidence;
* Gitea pull/review evidence;
* pending identity candidates;
* source and coverage registries.

The LLM consumes this export for extraction, reconciliation, and scoring. A
deterministic consumer can calculate the versioned combined ranking from the
returned component scores.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.artifacts import atomic_write
from backend.gitea_evidence import (
    MAX_REVIEW_CANDIDATES, METRIC_FIELDS, METRIC_SEMANTICS,
    candidate_identity_id, exact_identity_keys, metric_snapshot,
)
from build_member_profiles import application_rating


DEFAULT_ROOT = Path("data/horizon/latest")
DEFAULT_OUTPUT = DEFAULT_ROOT / "llm-ranking-export"
OMIT_KEYS = {
    "email",
    "phone",
    "phonenumber",
    "phone_number",
    "memberemail",
    "member_email", "age", "gender", "sex", "race", "ethnicity", "religion", "disability",
    "nationality", "citizenship", "dateofbirth", "date_of_birth", "sexualorientation",
    "sexual_orientation", "maritalstatus", "marital_status", "pregnancy", "expectedgrad",
    "expected_grad", "graduationdate", "graduation_date", "major", "member_since",
}
EMAIL_RE = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.I)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    atomic_write(path, json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")


def json_pointer(parts: Iterable[Any]) -> str:
    encoded = []
    for part in parts:
        encoded.append(str(part).replace("~", "~0").replace("/", "~1"))
    return "/" + "/".join(encoded)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scrub(value: Any) -> Any:
    """Remove direct contact fields while preserving source-linked evidence."""

    if isinstance(value, dict):
        return {
            str(key): scrub(item)
            for key, item in value.items()
            if str(key).casefold().replace("-", "_") not in OMIT_KEYS
        }
    if isinstance(value, list):
        return [scrub(item) for item in value]
    return value


def source_ref(source_file: str, pointer: str, record_id: str | None = None) -> dict[str, Any]:
    ref: dict[str, Any] = {"source_file": source_file, "json_pointer": pointer}
    if record_id:
        ref["source_record_id"] = record_id
    return ref


def evidence_id(person_id: str, kind: str, suffix: Any) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.:@-]+", "_", str(suffix))
    return f"{person_id}:{kind}:{safe}"


def add_evidence(
    evidence: list[dict[str, Any]],
    *,
    person_id: str,
    kind: str,
    suffix: Any,
    claim: Any,
    ref: dict[str, Any],
    status: str = "observed",
) -> str:
    item_id = evidence_id(person_id, kind, suffix)
    evidence.append(
        {
            "evidence_id": item_id,
            "person_id": person_id,
            "evidence_type": kind,
            "claim": scrub(claim),
            "status": status,
            "source_refs": [ref],
        }
    )
    return item_id


def member_identity(profile: dict[str, Any]) -> dict[str, Any]:
    member = profile.get("member") or {}
    attributes = member.get("attributes") or {}
    return {
        "person_id": profile.get("person_id"),
        "member_pk": member.get("pk"),
        "username": member.get("username"),
        "name": member.get("name"),
        "active": member.get("active"),
        "roles": attributes.get("roles") or {},
    }


def application_evidence(
    profile: dict[str, Any],
    evidence: list[dict[str, Any]],
    profile_index: int,
) -> list[str]:
    person_id = str(profile["person_id"])
    ids: list[str] = []
    applications = (profile.get("people_portal") or {}).get("applications") or []
    for index, application in enumerate(applications):
        info = application.get("applicationInfo") or {}
        application_id = application.get("applicationId") or info.get("id") or index
        pointer_base = json_pointer(["profiles", profile_index, "people_portal", "applications", index])
        profile_answers = info.get("profile") or {}
        for key in ("whyAppDev", "additionalInfo"):
            if profile_answers.get(key):
                ids.append(
                    add_evidence(
                        evidence,
                        person_id=person_id,
                        kind="application_answer",
                        suffix=f"{application_id}:{key}",
                        claim={"question": key, "answer": profile_answers[key]},
                        ref=source_ref("member-profiles.json", f"{pointer_base}/applicationInfo/profile/{key}", str(application_id)),
                    )
                )
        for question, answer in (info.get("responses") or {}).items():
            if answer:
                ids.append(
                    add_evidence(
                        evidence,
                        person_id=person_id,
                        kind="application_answer",
                        suffix=f"{application_id}:{question}",
                        claim={"question": question, "answer": answer},
                        ref=source_ref("member-profiles.json", pointer_base + json_pointer(["applicationInfo", "responses", question]), str(application_id)),
                    )
                )
        stars, stars_path = application_rating(application)
        if stars is not None:
            ids.append(
                add_evidence(
                    evidence,
                    person_id=person_id,
                    kind="application_rating",
                    suffix=f"{application_id}:stars",
                    claim={"stars": stars, "stage": info.get("stage")},
                    ref=source_ref("member-profiles.json", f"{pointer_base}/{stars_path}", str(application_id)),
                )
            )
        notes = info.get("notes") or application.get("notes")
        if notes:
            ids.append(add_evidence(
                evidence, person_id=person_id, kind="interview_observation",
                suffix=f"{application_id}:notes", claim=notes,
                ref=source_ref("member-profiles.json", f"{pointer_base}/{'applicationInfo/' if info.get('notes') else ''}notes", str(application_id)),
            ))
    return ids


def recruiting_evidence(
    profile: dict[str, Any],
    recruiting: dict[str, Any],
    evidence: list[dict[str, Any]],
) -> tuple[list[str], list[str], dict[str, Any]]:
    person_id = str(profile["person_id"])
    login = str((profile.get("member") or {}).get("username") or "")
    candidate = next(
        (item for item in recruiting.get("candidates") or [] if str(item.get("email") or "").strip().casefold() == person_id.casefold()),
        None,
    )
    if not candidate:
        return [], [], {"interview": {}, "resume": {"extraction_status": "missing"}}
    interview_ids: list[str] = []
    resume_ids: list[str] = []
    interview = candidate.get("interview") or {}
    # Observations are exported from each original application note. Legacy
    # recruiting.interview.evidence included applicant answers and social URLs.
    resume = candidate.get("resume") or {}
    for index, claim in enumerate(resume.get("evidence") or []):
        resume_ids.append(
            add_evidence(
                evidence,
                person_id=person_id,
                kind="resume_claim",
                suffix=f"evidence-{index}",
                claim=claim,
                ref=source_ref("recruiting-source.json", f"/candidates/{recruiting['candidates'].index(candidate)}/resume/evidence/{index}", login),
            )
        )
    resume_meta = {
        "extraction_status": resume.get("extraction_status", "unknown"),
        "summary": resume.get("summary"),
        "summary_is_compressed": True,
        "evidence_count": len(resume.get("evidence") or []),
        "evidence_truncated": resume.get("evidence_truncated", True),
        "employment": scrub(resume.get("employment") or []),
    }
    return interview_ids, resume_ids, {
        "interview": {
            "score": interview.get("score"),
            "evidence_ids": interview_ids,
        },
        "resume": {
            **resume_meta,
            "evidence_ids": resume_ids,
        },
    }


def build_pull_registry(analytics: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    """Canonical refs require typed, nonconflicting account evidence.

    Candidate lists never enter the member index. Every unresolved event is
    stored once in a separate review registry, even for legacy 124-way matches.
    """
    pulls: list[dict[str, Any]] = []
    member_refs: dict[str, list[dict[str, Any]]] = defaultdict(list)
    pending: list[dict[str, Any]] = []
    roster_keys: dict[str, set[str]] = defaultdict(set)
    raw_records = {row.get("login"): row for row in analytics.get("members") or []}
    for row in analytics.get("members") or []:
        if row.get("roster_member", True):
            for key in exact_identity_keys(row.get("login"), row.get("email")):
                roster_keys[key].add(row["login"])

    def canonical_actor(actor: Any) -> str | None:
        if not isinstance(actor, dict):
            return None
        resolution = str(actor.get("resolution") or "")
        exact_resolution = bool(re.fullmatch(r"(?:global|organization)_exact_(?:email|login|email_and_login)", resolution))
        if resolution and not exact_resolution:
            return None
        keys = exact_identity_keys(actor.get("login"), actor.get("email"))
        targets = set().union(*(roster_keys.get(key, set()) for key in keys)) if keys else set()
        return next(iter(targets)) if len(targets) == 1 else None

    for oi, org in enumerate(analytics.get("organizations") or []):
        organization = org.get("organization")
        for ri, repo in enumerate(org.get("repositories") or []):
            repository = repo.get("name")
            commits_by_sha = {row.get("sha"): (index, row) for index, row in enumerate(repo.get("commits") or [])}
            for pi, pull in enumerate(repo.get("pulls") or []):
                pull_id = f"gitea:{organization}/{repository}:pull:{pull.get('number')}"
                base = ["organizations", oi, "repositories", ri, "pulls", pi]
                clean_pull = {key: scrub(value) for key, value in pull.items()
                              if key not in {"author", "author_identity", "contributing_authors", "reviewers"}}
                clean_pull.update(author=None, contributing_authors=[], reviewers=[], pending_identity_review_refs=[])

                def register(actor: Any, role: str, position: int, path: list[Any]) -> str | None:
                    proof_refs = [source_ref("analytics.json", json_pointer(base + path))]
                    owner = canonical_actor(actor)
                    if role == "contributed_commit" and isinstance(actor, dict):
                        # A rendered identity and a legacy resolution label are
                        # insufficient. Verify every authored SHA against typed
                        # raw authors, or the collector's typed author group.
                        proofs = actor.get("author_identities") or []
                        if not proofs:
                            proofs = []
                            for sha in actor.get("commit_shas") or []:
                                entry = commits_by_sha.get(sha)
                                proofs.append(entry[1].get("author_identity") if entry else None)
                                if entry:
                                    proof_refs.append(source_ref("analytics.json", json_pointer([
                                        "organizations", oi, "repositories", ri, "commits", entry[0], "author_identity",
                                    ])))
                        owners = {canonical_actor(proof) for proof in proofs}
                        owner = next(iter(owners)) if actor.get("commit_shas") and proofs and len(owners) == 1 and None not in owners else None
                        if actor.get("resolution") and not re.fullmatch(r"(?:global|organization)_exact_(?:email|login|email_and_login)", actor["resolution"]):
                            owner = None
                    if owner:
                        member_refs[owner].append({
                            "evidence_id": pull_id,
                            "attribution_status": "canonical_exact",
                            "relationship": role,
                            "source_refs": proof_refs,
                        })
                        return owner
                    raw = actor if isinstance(actor, dict) else {"identity": actor}
                    identity_label = raw.get("identity") or raw.get("resolved_identity") or raw.get("login")
                    underlying = raw_records.get(identity_label)
                    review_id = f"{pull_id}:identity-review:{role}:{position}"
                    targets = sorted(set(raw.get("candidate_identities") or []))
                    pending.append({
                        "evidence_id": review_id,
                        "evidence_type": "gitea_pending_pull_identity",
                        "pull_evidence_id": pull_id,
                        "candidate_identity_id": candidate_identity_id(underlying) if underlying else None,
                        "relationship": role,
                        "status": "pending_identity_review",
                        "attribution_status": "candidate_only_pending_review",
                        "included_in_canonical_metrics": False,
                        "candidate_count": len(targets),
                        "reason": "broad_candidate_set_rejected" if len(targets) > MAX_REVIEW_CANDIDATES else "requires_exact_typed_identity",
                        "identity": scrub({**raw, "candidate_identities": targets if len(targets) <= MAX_REVIEW_CANDIDATES else []}),
                        "candidate_list_suppressed": len(targets) > MAX_REVIEW_CANDIDATES,
                        "source_refs": [source_ref("analytics.json", json_pointer(base + path))],
                    })
                    clean_pull["pending_identity_review_refs"].append(review_id)
                    return None

                clean_pull["author"] = register(pull.get("author_identity"), "authored_pr", 0, ["author_identity"])
                for ci, contributor in enumerate(pull.get("contributing_authors") or []):
                    owner = register(contributor, "contributed_commit", ci, ["contributing_authors", ci])
                    if owner:
                        clean_pull["contributing_authors"].append({"identity": owner, "attribution_status": "canonical_exact", "commit_shas": contributor.get("commit_shas") or []})
                for vi, reviewer in enumerate(pull.get("reviewers") or []):
                    owner = register(reviewer.get("author_identity"), "reviewer", vi, ["reviewers", vi, "author_identity"])
                    if owner:
                        clean_pull["reviewers"].append({"identity": owner, "state": reviewer.get("state"), "attribution_status": "canonical_exact"})
                pulls.append({
                    "evidence_id": pull_id, "evidence_type": "gitea_pull",
                    "organization": organization, "repository": repository,
                    "default_branch": repo.get("default_branch"), "pull": clean_pull,
                    "source_refs": [source_ref("analytics.json", json_pointer(base), pull_id)],
                })
    return pulls, member_refs, pending


def member_pull_refs(profile: dict[str, Any], member_refs: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    refs = {}
    for record in (profile.get("gitea") or {}).get("records") or []:
        for item in member_refs.get(record.get("login"), []):
            refs[(item["evidence_id"], item["relationship"])] = item
    return sorted(refs.values(), key=lambda item: (item["evidence_id"], item["relationship"]))


def validate_references(rows: list[dict[str, Any]], sources: dict[str, Any]) -> None:
    """Fail export on broken JSON pointers rather than shipping fake citations."""
    seen = set()
    for row in rows:
        if row["evidence_id"] in seen:
            raise ValueError(f"Duplicate evidence ID: {row['evidence_id']}")
        seen.add(row["evidence_id"])
        for ref in row.get("source_refs") or []:
            value = sources[ref["source_file"]]
            for part in ref["json_pointer"].split("/")[1:]:
                key = part.replace("~1", "/").replace("~0", "~")
                value = value[int(key)] if isinstance(value, list) else value[key]


def file_metadata(root: Path, relative: str) -> dict[str, Any]:
    path = root / relative
    payload = load_json(path)
    return {
        "path": relative,
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "schema": payload.get("schema") if isinstance(payload, dict) else None,
        "generated_at": payload.get("generated_at") if isinstance(payload, dict) else None,
    }


def build(args: argparse.Namespace) -> dict[str, Any]:
    root = args.root
    output = args.output or root / "llm-ranking-export"
    output.mkdir(parents=True, exist_ok=True)
    profiles_doc = load_json(root / "member-profiles.json")
    recruiting_doc = load_json(root / "recruiting-source.json")
    analytics_doc = load_json(root / "analytics.json")
    manifest_doc = load_json(root / "manifest.json")
    identity_doc = load_json(root / "identity-review.json")
    for relative, expected in (profiles_doc.get("source", {}).get("input_sha256") or {}).items():
        if relative in {"analytics.json", "manifest.json"} and expected and sha256(root / relative) != expected:
            raise ValueError(f"Profiles were built from different {relative}; rebuild member profiles")
    profile_rows = profiles_doc.get("profiles") or []
    if len({row["person_id"] for row in profile_rows}) != len(profile_rows):
        raise ValueError("Duplicate person IDs in member profiles")
    if any((row.get("member") or {}).get("active") is not True for row in profile_rows):
        raise ValueError("Member profiles must contain only active members")

    pulls, member_refs, pending_pulls = build_pull_registry(analytics_doc)
    pending_by_identity: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in pending_pulls:
        if row["candidate_identity_id"]:
            pending_by_identity[row["candidate_identity_id"]].append(row)
    evidence: list[dict[str, Any]] = []
    member_cards: list[dict[str, Any]] = []
    identity_by_person: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in identity_doc.get("candidates") or []:
        item = scrub(row)
        identity_id = row["candidate_identity_id"]
        item["pending_pull_evidence_refs"] = [event["evidence_id"] for event in pending_by_identity.get(identity_id, [])]
        identity_by_person[str(row.get("person_id"))].append(item)

    for profile_index, profile in sorted(enumerate(profiles_doc.get("profiles") or []), key=lambda item: str(item[1].get("person_id"))):
        person_id = str(profile["person_id"])
        pp = profile.get("people_portal") or {}
        role_ids: list[str] = []
        for index, role in enumerate(pp.get("currentRoles") or []):
            role_ids.append(
                add_evidence(
                    evidence,
                    person_id=person_id,
                    kind="people_portal_role",
                    suffix=index,
                    claim={"role": role},
                    ref=source_ref("member-profiles.json", f"/profiles/{profile_index}/people_portal/currentRoles/{index}", person_id),
                )
            )
        application_ids = application_evidence(profile, evidence, profile_index)
        interview_ids, resume_ids, recruiting_evidence_doc = recruiting_evidence(profile, recruiting_doc, evidence)
        interview_ids = [item["evidence_id"] for item in evidence if item["person_id"] == person_id and item["evidence_type"] == "interview_observation"]
        recruiting_evidence_doc["interview"]["evidence_ids"] = interview_ids
        application_ids = [item for item in application_ids if item not in interview_ids]
        pull_refs = member_pull_refs(profile, member_refs)
        gitea = profile.get("gitea") or {}
        canonical_metrics = scrub(metric_snapshot(gitea.get("metrics") or {}, unlinked=not gitea.get("matched")))
        canonical_metrics.pop("identity_aliases", None)
        canonical_metric_evidence_ids: list[str] = []
        candidate_metric_evidence_ids: list[str] = []

        def metric_claims(metrics: dict[str, Any], pointer: str, identity_id: str | None, records: list[dict[str, Any]]) -> list[str]:
            ids = []
            attribution = "candidate_only_pending_review" if identity_id else "canonical_member_linked" if gitea.get("matched") else "unlinked"
            for field in METRIC_FIELDS:
                item_id = add_evidence(
                    evidence, person_id=person_id,
                    kind="gitea_metric_candidate" if identity_id else "gitea_metric_canonical",
                    suffix=f"{identity_id or 'canonical'}:{field}",
                    claim={
                        "metric": field, "value": metrics.get(field),
                        "availability": metrics["availability"][field],
                        "observed_subtotal": metrics.get("observed_values", {}).get(field),
                        "definition": METRIC_SEMANTICS[field],
                        "attribution_status": attribution,
                        "candidate_identity_id": identity_id,
                        "scope": analytics_doc.get("history_scope"),
                    },
                    ref=source_ref("member-profiles.json", f"{pointer}/{field}", person_id),
                    status="pending_identity_review" if identity_id else metrics["availability"][field],
                )
                evidence[-1]["attribution_status"] = attribution
                evidence[-1]["eligible_for_canonical_scoring"] = not identity_id and bool(gitea.get("matched")) and metrics["availability"][field] == "complete"
                evidence[-1]["source_refs"].append(source_ref("member-profiles.json", f"{pointer}/availability/{field}"))
                for metric_record in records:
                    evidence[-1]["source_refs"].extend(metric_record.get("source_refs") or [])
                    for coverage_index in (metric_record.get("metric_coverage_refs") or {}).get(field, []):
                        evidence[-1]["source_refs"].append(source_ref("analytics.json", f"/coverage/{coverage_index}"))
                ids.append(item_id)
            return ids

        canonical_metric_evidence_ids = metric_claims(canonical_metrics, f"/profiles/{profile_index}/gitea/metrics", None, gitea.get("records") or [])
        candidate_metric_rows: list[dict[str, Any]] = []
        for index, record in enumerate(gitea.get("candidateRecords") or []):
            identity_id = candidate_identity_id(record)
            metrics = scrub(metric_snapshot(record))
            ids = metric_claims(metrics, f"/profiles/{profile_index}/gitea/candidateRecords/{index}", identity_id, [record])
            candidate_metric_evidence_ids.extend(ids)
            candidate_metric_rows.append({
                "attribution_status": "candidate_only_pending_review",
                "candidate_identity_id": identity_id,
                "included_in_canonical_metrics": False,
                "login": record.get("login"),
                "name": record.get("name"),
                "organizations": record.get("organizations") or [],
                "repositories": record.get("repositories") or [],
                "metrics": {field: metrics[field] for field in METRIC_FIELDS},
                "availability": metrics["availability"],
                "observed_values": metrics["observed_values"],
                "evidence_ids": ids,
                "pending_pull_evidence_count": len({event["pull_evidence_id"] for event in pending_by_identity.get(identity_id, [])}),
            })
        member_cards.append(
            {
                "schema": "horizon.llm-ranking.member-card.v2",
                "person_id": person_id,
                "member": member_identity(profile),
                "eligibility": {
                    "active_member": bool((profile.get("member") or {}).get("active")),
                    "application_outcome_is_not_membership_eligibility": pp.get("applicationOutcomeIsNotMembershipEligibility"),
                    "exclusion_status": "not_evaluated",
                    "identity_status": "pending_identity_review" if identity_by_person.get(person_id) else ("canonical_match" if gitea.get("matched") else "unmatched"),
                },
                "people_portal": {
                    "current_roles": pp.get("currentRoles") or [],
                    "application_team_names": pp.get("applicationTeamNames") or [],
                    "application_count": pp.get("applicationCount", 0),
                    "stage_counts": pp.get("stageCounts") or {},
                    "notes_count": pp.get("notesCount", 0),
                    "ratings_count": pp.get("ratingsCount", 0),
                    "resume_count": pp.get("resumeCount", 0),
                    "resume_retrieved_count": pp.get("resumeRetrievedCount", 0),
                    "applications": scrub(pp.get("applications") or []),
                    "resumes": scrub(pp.get("resumes") or []),
                },
                "recruiting_evidence": recruiting_evidence_doc,
                "gitea": {
                    "matched": gitea.get("matched"),
                    "match": scrub(gitea.get("match")),
                    "canonical_metrics": canonical_metrics,
                    "canonical_metric_evidence_ids": canonical_metric_evidence_ids,
                    "canonical_records": [{key: scrub(value) for key, value in record.items() if key != "identity_aliases"} for record in gitea.get("records") or []],
                    "candidate_identity_ids": [
                        row["candidate_identity_id"] for row in identity_by_person.get(person_id, [])
                    ],
                    "candidate_metric_evidence_ids": candidate_metric_evidence_ids,
                    "candidate_metrics": candidate_metric_rows,
                    "candidate_pull_evidence_count": len({event["pull_evidence_id"] for row in candidate_metric_rows for event in pending_by_identity.get(row["candidate_identity_id"], [])}),
                    "pull_evidence_refs": pull_refs,
                    "coverage": {"source_file": "coverage.json", "json_pointer": "/gitea_coverage"},
                },
                "evidence_refs": {
                    "people_portal_role_ids": role_ids,
                    "application_evidence_ids": application_ids,
                    "interview_evidence_ids": interview_ids,
                    "resume_evidence_ids": resume_ids,
                    "gitea_metric_evidence_ids": canonical_metric_evidence_ids + candidate_metric_evidence_ids,
                },
                "identity_review": [{"candidate_identity_id": row["candidate_identity_id"], "status": "pending_review"} for row in identity_by_person.get(person_id, [])],
                "provenance": {key: scrub(value) for key, value in (profile.get("provenance") or {}).items() if key != "giteaCoverage"},
            }
        )

    source_docs = {
        "member-profiles.json": profiles_doc, "recruiting-source.json": recruiting_doc,
        "analytics.json": analytics_doc,
    }
    validate_references([*evidence, *pulls, *pending_pulls], source_docs)
    for card in member_cards:
        # One pull can have multiple relationships; validate each citation.
        for ref in card["gitea"]["pull_evidence_refs"]:
            validate_references([ref], source_docs)
    member_path = output / "members.jsonl"
    evidence_path = output / "evidence.jsonl"
    pulls_path = output / "gitea-pulls.jsonl"
    identity_path = output / "identity-review.jsonl"
    for path, rows in (
        (member_path, member_cards),
        (evidence_path, sorted(evidence, key=lambda item: item["evidence_id"])),
        (pulls_path, sorted(pulls, key=lambda item: item["evidence_id"])),
        (identity_path, sorted([row for rows in identity_by_person.values() for row in rows], key=lambda item: (item["person_id"], item["candidate_identity_id"]))),
        (output / "pending-pull-identities.jsonl", sorted(pending_pulls, key=lambda item: item["evidence_id"])),
        (output / "unassigned-identities.jsonl", identity_doc.get("unassigned_candidates") or []),
    ):
        path.write_text(
            "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows),
            encoding="utf-8",
        )

    coverage = {
        "schema": "horizon.llm-ranking.coverage.v1",
        "generated_at": profiles_doc.get("generated_at"),
        "member_profiles_summary": profiles_doc.get("summary") or {},
        "gitea_coverage_summary": analytics_doc.get("coverage_summary") or {},
        "gitea_coverage": analytics_doc.get("coverage"),
        "gitea_coverage_status": "unknown" if analytics_doc.get("coverage") is None else "partial" if any(row.get("status") != "complete" for row in analytics_doc["coverage"]) else "complete",
        "gitea_warnings": analytics_doc.get("warnings") or [],
        "identity_review_summary": identity_doc.get("summary") or {},
        "pending_pull_identity_count": len(pending_pulls),
        "broad_pull_identity_count": sum(row["reason"] == "broad_candidate_set_rejected" for row in pending_pulls),
        "unavailable_organization_count": len((manifest_doc.get("organization_selection") or {}).get("unavailable") or []),
        "unavailable_organizations": (manifest_doc.get("organization_selection") or {}).get("unavailable") or [],
        "profile_warnings": profiles_doc.get("warnings") or [],
        "metric_semantics": METRIC_SEMANTICS,
        "known_export_caveats": [
            "resume.summary is compressed; evidence_truncated and extraction_status describe whether resume claims are complete",
            "heuristic_candidate_only Gitea identities are evidence for review only and are not canonical ranking inputs",
            "partial, failed, unavailable, and missing metrics remain explicitly represented and must not become zero ability",
        ],
    }
    write_json(output / "coverage.json", coverage)

    input_files = [
        "member-profiles.json",
        "recruiting-source.json",
        "analytics.json",
        "manifest.json",
        "identity-review.json",
    ]
    source_registry = {
        "schema": "horizon.llm-ranking.source-registry.v1",
        "generated_at": profiles_doc.get("generated_at"),
        "sources": [file_metadata(root, relative) for relative in input_files],
        "people_portal_archive": profiles_doc.get("source", {}).get("peoplePortalArchive"),
        "gitea_run_id": manifest_doc.get("run_id"),
    }
    write_json(output / "source-registry.json", source_registry)

    output_files = [
        "members.jsonl",
        "evidence.jsonl",
        "gitea-pulls.jsonl",
        "identity-review.jsonl",
        "pending-pull-identities.jsonl",
        "unassigned-identities.jsonl",
        "coverage.json",
        "source-registry.json",
    ]
    output_manifest = {
        "schema": "horizon.llm-ranking-export.v2",
        "generated_at": profiles_doc.get("generated_at"),
        "rubric_version": "leadership-weighted-35-35-30-v1",
        "input_root": ".",
        "member_count": len(member_cards),
        "evidence_count": len(evidence),
        "gitea_pull_evidence_count": len(pulls),
        "pending_pull_identity_count": len(pending_pulls),
        "broad_pull_identity_count": sum(row["reason"] == "broad_candidate_set_rejected" for row in pending_pulls),
        "canonical_pull_reference_count": sum(len(card["gitea"]["pull_evidence_refs"]) for card in member_cards),
        "metric_semantics": METRIC_SEMANTICS,
        "ranking_status": "awaiting_human_evidence_screening",
        "human_review_required": True,
        "unstructured_evidence_policy": "screen and redact protected/sensitive personal information before any model use",
        "decision_status": "discovery_only_no_employment_decisions",
        "identity_candidate_count": len(identity_doc.get("candidates") or []),
        "identity_candidate_member_count": len(identity_by_person),
        "files": [
            {"path": relative, "bytes": (output / relative).stat().st_size, "sha256": sha256(output / relative)}
            for relative in output_files
        ],
        "input_sources": source_registry["sources"],
        "scoring_policy": {
            "technical_execution": 0.35,
            "technical_leadership_and_engineering_judgment": 0.35,
            "app_dev_club_contribution_and_impact": 0.30,
            "missingness_policy": "unknown_is_not_zero",
            "candidate_identity_policy": "pending_human_review",
        },
        "llm_role": "extract_reconcile_explain_and_assign_component_scores",
        "deterministic_role": "calculate_versioned_combined_ranking_from_component_scores",
    }
    write_json(output / "manifest.json", output_manifest)
    return {
        "output": str(output),
        "members": len(member_cards),
        "evidence": len(evidence),
        "gitea_pull_evidence": len(pulls),
        "pending_pull_identities": len(pending_pulls),
        "broad_pull_identities_quarantined": sum(row["reason"] == "broad_candidate_set_rejected" for row in pending_pulls),
        "identity_candidates": len(identity_doc.get("candidates") or []),
        "identity_candidate_members": len(identity_by_person),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args), indent=2))


if __name__ == "__main__":
    main()
