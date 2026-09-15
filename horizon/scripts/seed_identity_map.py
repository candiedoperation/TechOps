#!/usr/bin/env python3
"""Privacy-safe identity-map seed proposal.

The original phase plan predates the stricter privacy contract and describes a
durable ``identity_map`` containing Gitea usernames and Authentik user IDs.
That collection is intentionally not populated here: a username, user ID,
email, hash, or pseudonymous identity reference would still be a contributor
identifier.  This script performs any requested join in memory only and can
persist aggregate run metadata for operators.  It never writes an identity
mapping or prints a candidate match.

Input files are JSON arrays or objects with a ``results``/``users``/``accounts``
array.  Their contents are not echoed, logged, or included in the result.
"""

from __future__ import annotations

import argparse
import json
import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    # Keep the script aligned with the backend's foundation-model bridge when
    # this file is used inside the complete service.
    from backend.ingestion import DatabaseLike, _collection
    try:
        from backend.models import IdentityMapDocument
    except ImportError:  # pragma: no cover - dependency-free mock checkout
        IdentityMapDocument = None  # type: ignore[assignment,misc]
except ImportError:  # pragma: no cover - allows direct use from this mock
    DatabaseLike = Any  # type: ignore[misc,assignment]
    _collection = None  # type: ignore[assignment]
    IdentityMapDocument = None  # type: ignore[assignment,misc]


SEED_RUN_COLLECTION = "identity_map_seed_runs"


@dataclass(frozen=True)
class SeedResult:
    status: str
    run_id: str
    inspected_gitea_records: int
    inspected_directory_records: int
    confirmed_candidates: int
    ambiguous_candidates: int
    unmatched_records: int
    rejected_records: int
    persisted_mapping_records: int = 0
    message: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _rows(value: Any) -> list[Mapping[str, Any]]:
    if isinstance(value, Mapping):
        for key in ("results", "users", "accounts", "records", "items"):
            candidate = value.get(key)
            if isinstance(candidate, Sequence) and not isinstance(candidate, (str, bytes)):
                return [row for row in candidate if isinstance(row, Mapping)]
        return [value]
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return [row for row in value if isinstance(row, Mapping)]
    return []


def _normal(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip().casefold()
    return cleaned or None


def _emails(row: Mapping[str, Any]) -> set[str]:
    values: list[Any] = [row.get("email"), row.get("primary_email")]
    raw_emails = row.get("emails")
    if isinstance(raw_emails, Sequence) and not isinstance(raw_emails, (str, bytes)):
        values.extend(raw_emails)
    return {normalized for value in values if (normalized := _normal(value))}


def _names(row: Mapping[str, Any]) -> set[str]:
    values = [
        row.get("login"),
        row.get("username"),
        row.get("gitea_username"),
        row.get("gitea_login"),
        row.get("slug"),
    ]
    return {normalized for value in values if (normalized := _normal(value))}


def _candidate_keys(row: Mapping[str, Any]) -> set[str]:
    # Keys are transient join keys only.  They are never returned or persisted.
    return {f"email:{value}" for value in _emails(row)} | {f"name:{value}" for value in _names(row)}


def _ephemeral_join(gitea_rows: Sequence[Mapping[str, Any]], directory_rows: Sequence[Mapping[str, Any]]) -> tuple[int, int, int, int]:
    directory_by_key: dict[str, set[int]] = defaultdict(set)
    for index, row in enumerate(directory_rows):
        for key in _candidate_keys(row):
            directory_by_key[key].add(index)

    confirmed = ambiguous = unmatched = rejected = 0
    for row in gitea_rows:
        keys = _candidate_keys(row)
        if not keys:
            rejected += 1
            continue
        candidates: set[int] = set()
        for key in keys:
            candidates.update(directory_by_key.get(key, set()))
        if len(candidates) == 1:
            confirmed += 1
        elif len(candidates) > 1:
            ambiguous += 1
        else:
            unmatched += 1
    return confirmed, ambiguous, unmatched, rejected


def _metadata_document(result: SeedResult) -> dict[str, Any]:
    return {
        "_id": f"identity_seed_{uuid.uuid4().hex}",
        "run_id": result.run_id,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": result.status,
        "inspected_gitea_records": result.inspected_gitea_records,
        "inspected_directory_records": result.inspected_directory_records,
        "confirmed_candidates": result.confirmed_candidates,
        "ambiguous_candidates": result.ambiguous_candidates,
        "unmatched_records": result.unmatched_records,
        "rejected_records": result.rejected_records,
        "persisted_mapping_records": 0,
        "data_quality_flags": [
            "identity_mapping_persistence_disabled",
        ],
    }


def _identity_guard_document() -> dict[str, Any]:
    """Build the foundation model's explicit aggregate-only guard row."""

    if IdentityMapDocument is not None:
        # The local/demo path intentionally has no initialized Beanie
        # collection, so construct the guard model without collection access.
        model = IdentityMapDocument.model_construct()
        dumper = getattr(model, "model_dump", None)
        if dumper is not None:
            try:
                payload = dict(dumper(mode="json", exclude_none=True))
            except TypeError:
                payload = dict(dumper(exclude_none=True))
            payload["_id"] = f"identity_guard_{uuid.uuid4().hex}"
            return payload
    return {
        "_id": f"identity_guard_{uuid.uuid4().hex}",
        "record_type": "aggregate_only_guard",
        "mapping_enabled": False,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def seed_identity_map(
    gitea_records: Iterable[Mapping[str, Any]] | None = None,
    directory_records: Iterable[Mapping[str, Any]] | None = None,
    *,
    db: DatabaseLike | Mapping[str, Any] | None = None,
) -> SeedResult:
    """Perform a transient match and never persist an identity mapping."""

    gitea_rows = [row for row in (gitea_records or ()) if isinstance(row, Mapping)]
    directory_rows = [row for row in (directory_records or ()) if isinstance(row, Mapping)]
    confirmed, ambiguous, unmatched, rejected = _ephemeral_join(gitea_rows, directory_rows)
    result = SeedResult(
        status="privacy_disabled",
        run_id=f"identity_seed_{uuid.uuid4().hex}",
        inspected_gitea_records=len(gitea_rows),
        inspected_directory_records=len(directory_rows),
        confirmed_candidates=confirmed,
        ambiguous_candidates=ambiguous,
        unmatched_records=unmatched,
        rejected_records=rejected,
        message="Identity mappings are not stored; only aggregate seed-run metadata may be written.",
    )

    if db is not None:
        if _collection is None:
            raise RuntimeError("backend collection support is unavailable")
        _collection(db, "identity_map").insert_one(_identity_guard_document())
        # This is deliberately a separate aggregate metadata collection, never
        # the identity_map collection.  It contains no join keys or identities.
        _collection(db, SEED_RUN_COLLECTION).insert_one(_metadata_document(result))
    return result


def _load(path: Path) -> list[Mapping[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        return _rows(json.load(handle))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run an ephemeral, privacy-safe identity-map proposal.")
    parser.add_argument("--gitea-export", type=Path, help="JSON export of Gitea account records")
    parser.add_argument("--directory-export", type=Path, help="JSON export of Authentik/People Portal records")
    parser.add_argument(
        "--metadata-output",
        type=Path,
        help="Optional file for aggregate seed-run metadata; no mapping rows are written",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    gitea_rows = _load(args.gitea_export) if args.gitea_export else []
    directory_rows = _load(args.directory_export) if args.directory_export else []
    result = seed_identity_map(gitea_rows, directory_rows)
    payload = result.as_dict()
    if args.metadata_output:
        args.metadata_output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    raise SystemExit(main())
