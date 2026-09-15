#!/usr/bin/env python3
"""Propose commit-author identities for attribution to roster members.

Members frequently commit from an address that was never registered on their
Gitea account.  Gitea then resolves the commit's ``author`` to ``null``, the
collector records the work under a separate unmatched identity, and the roster
row is left at zero -- which downstream reads as "contributed nothing" rather
than "was never attributed".

The authoritative fix is upstream: the member adds that address under Gitea
Settings -> Emails, after which Gitea resolves the commits itself and no
mapping is needed.  This script exists for the history that has already
accumulated.

**It proposes; it never decides.**  Every entry is written with
``confirmed_by: null`` and is ignored by ``backend.member_analytics`` until a
person fills that field in.  That is deliberate: these numbers feed a
recruiting rank, so attributing one person's commits to another is a harm this
tool must not be able to cause on its own.

Evidence tiers, strongest first:

``exact_name_and_shared_org``
    The identity's full name equals exactly one roster member's full name, and
    the two share a Gitea organization.

``exact_name_only``
    Full names match uniquely, but no shared organization corroborates it.

``token_and_shared_org``
    Name/login/email-local-part tokens overlap exactly one roster member in a
    shared organization.  Weakest tier -- read the evidence before confirming.

Ambiguous identities (matching zero or several roster members) are reported as
skipped and never written, because the fold requires a unique target anyway.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TIERS = ("exact_name_and_shared_org", "exact_name_only", "token_and_shared_org")


def _normalized_name(value: Any) -> str:
    return re.sub(r"[^a-z]", "", str(value or "").casefold())


def _tokens(value: Any) -> set[str]:
    return {token for token in re.split(r"[^a-z0-9]+", str(value or "").casefold()) if len(token) > 2}


def _identity_tokens(member: dict[str, Any]) -> set[str]:
    local_part = str(member.get("email") or "").split("@")[0]
    return _tokens(member.get("name")) | _tokens(member.get("login")) | _tokens(local_part)


def _classify(alias: dict[str, Any], roster: list[dict[str, Any]]) -> tuple[str, dict[str, Any]] | None:
    """Return the strongest tier and its evidence, or ``None`` when ambiguous."""

    alias_orgs = set(alias.get("organizations") or [])
    alias_name = _normalized_name(alias.get("name"))

    if alias_name:
        exact = [member for member in roster if _normalized_name(member.get("name")) == alias_name]
        if len(exact) == 1:
            target = exact[0]
            shared = sorted(alias_orgs & set(target.get("organizations") or []))
            evidence = {
                "matched_full_name": target.get("name"),
                "shared_organizations": shared,
                "alias_commits": alias.get("commits"),
            }
            return ("exact_name_and_shared_org" if shared else "exact_name_only", evidence)

    alias_tokens = _identity_tokens(alias)
    candidates = [
        member
        for member in roster
        if (alias_orgs & set(member.get("organizations") or []))
        and (alias_tokens & (_tokens(member.get("name")) | _tokens(member.get("login"))))
    ]
    if len(candidates) == 1:
        target = candidates[0]
        return (
            "token_and_shared_org",
            {
                "matched_tokens": sorted(alias_tokens & (_tokens(target.get("name")) | _tokens(target.get("login")))),
                "shared_organizations": sorted(alias_orgs & set(target.get("organizations") or [])),
                "roster_name": target.get("name"),
                "alias_commits": alias.get("commits"),
            },
        )
    return None


def _target_for(alias: dict[str, Any], roster: list[dict[str, Any]], tier: str) -> dict[str, Any] | None:
    alias_orgs = set(alias.get("organizations") or [])
    alias_name = _normalized_name(alias.get("name"))
    if tier.startswith("exact_name"):
        matches = [member for member in roster if _normalized_name(member.get("name")) == alias_name]
        return matches[0] if len(matches) == 1 else None
    alias_tokens = _identity_tokens(alias)
    matches = [
        member
        for member in roster
        if (alias_orgs & set(member.get("organizations") or []))
        and (alias_tokens & (_tokens(member.get("name")) | _tokens(member.get("login"))))
    ]
    return matches[0] if len(matches) == 1 else None


def build_proposals(members: list[dict[str, Any]], tiers: tuple[str, ...]) -> dict[str, Any]:
    roster = [m for m in members if m.get("roster_member") and not m.get("service_or_admin")]
    unmatched = [m for m in members if not m.get("roster_member") and (m.get("commits") or 0) > 0]

    aliases: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for alias in sorted(unmatched, key=lambda m: -(m.get("commits") or 0)):
        classified = _classify(alias, roster)
        if classified is None:
            skipped.append({"alias_login": alias.get("login"), "reason": "no unique roster match",
                            "commits": alias.get("commits")})
            continue
        tier, evidence = classified
        if tier not in tiers:
            skipped.append({"alias_login": alias.get("login"), "reason": f"tier {tier} not requested",
                            "commits": alias.get("commits")})
            continue
        target = _target_for(alias, roster, tier)
        if target is None:
            skipped.append({"alias_login": alias.get("login"), "reason": "target became ambiguous",
                            "commits": alias.get("commits")})
            continue
        aliases.append({
            "alias_login": alias.get("login"),
            "alias_email": alias.get("email"),
            "alias_display_name": alias.get("name"),
            "target_login": target.get("login"),
            "target_name": target.get("name"),
            "evidence_tier": tier,
            "evidence": evidence,
            # Filled in by a person. Until then this entry does nothing.
            "confirmed_by": None,
            "confirmed_at": None,
        })
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "note": (
            "Proposals only. An entry takes effect once a reviewer sets confirmed_by "
            "to their own identifier. The durable fix is for the member to register "
            "the address under Gitea Settings -> Emails."
        ),
        "aliases": aliases,
        "skipped": skipped,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--analytics-json", required=True, help="analytics.json produced by scripts/member_analytics.py")
    parser.add_argument("--output", default="identity-aliases.json", help="proposal file to write")
    parser.add_argument("--tier", action="append", choices=TIERS,
                        help="evidence tiers to include; repeatable (default: the two name-exact tiers)")
    args = parser.parse_args()

    tiers = tuple(args.tier) if args.tier else ("exact_name_and_shared_org", "exact_name_only")
    payload = json.loads(Path(args.analytics_json).read_text(encoding="utf-8"))
    members = payload.get("members")
    if not isinstance(members, list):
        print("analytics payload has no members array", file=sys.stderr)
        return 1

    proposals = build_proposals(members, tiers)
    out = Path(args.output)
    if out.exists():
        # Never clobber reviewer decisions already recorded in the file.
        existing = json.loads(out.read_text(encoding="utf-8"))
        confirmed = {
            (entry.get("alias_login"), entry.get("alias_email")): entry
            for entry in existing.get("aliases", [])
            if isinstance(entry, dict) and entry.get("confirmed_by")
        }
        for entry in proposals["aliases"]:
            prior = confirmed.pop((entry["alias_login"], entry["alias_email"]), None)
            if prior:
                entry["confirmed_by"] = prior.get("confirmed_by")
                entry["confirmed_at"] = prior.get("confirmed_at")
        proposals["aliases"].extend(confirmed.values())

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(proposals, indent=2) + "\n", encoding="utf-8")

    by_tier: dict[str, int] = {}
    for entry in proposals["aliases"]:
        by_tier[entry["evidence_tier"]] = by_tier.get(entry["evidence_tier"], 0) + 1
    print(json.dumps({
        "output": str(out),
        "proposed": len(proposals["aliases"]),
        "confirmed": sum(1 for e in proposals["aliases"] if e.get("confirmed_by")),
        "by_tier": by_tier,
        "skipped": len(proposals["skipped"]),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
