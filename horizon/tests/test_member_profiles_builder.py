from __future__ import annotations

import json
import zipfile
from argparse import Namespace

from build_member_profiles import aggregate_gitea, build


def _write_json(archive: zipfile.ZipFile, name: str, value: object) -> None:
    archive.writestr(name, json.dumps(value))


def test_gitea_aggregate_preserves_partial_metrics_as_unknown():
    aggregate = aggregate_gitea([
        {"commits": 3, "pulls_merged": 1},
        {"commits": None, "pulls_merged": None},
    ])

    assert aggregate["commits"] is None
    assert aggregate["pulls_merged"] is None
    assert aggregate["availability"]["commits"] == "partial"
    assert aggregate["availability"]["pulls_merged"] == "partial"


def test_active_member_with_only_rejected_applications_is_retained(tmp_path):
    peopleportal_zip = tmp_path / "peopleportal.zip"
    with zipfile.ZipFile(peopleportal_zip, "w") as archive:
        _write_json(
            archive,
            "peopleportal/active-members.json",
            [{"email": "alice@example.com", "active": True, "name": "Alice"}],
        )
        _write_json(
            archive,
            "peopleportal/applications.json",
            [
                {
                    "memberEmail": "alice@example.com",
                    "applicationInfo": {"stage": "Rejected"},
                }
            ],
        )
        _write_json(archive, "peopleportal/teams.json", [])
        _write_json(
            archive,
            "peopleportal/manifest.json",
            {"generatedAt": "2026-09-07T20:06:24Z", "resumes": [], "summary": {}},
        )
        _write_json(archive, "peopleportal/failures.json", [])

    analytics = tmp_path / "analytics.json"
    analytics.write_text(
        json.dumps(
            {
                "generated_at": "2026-09-07T20:00:00Z",
                "members": [
                    {
                        "email": "alice@example.com",
                        "login": "alice",
                        "name": "Alice",
                        "commits": 3,
                    }
                ],
                "organizations": [],
                "coverage": [],
                "blame": {"status": "complete"},
            }
        )
    )
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({}))
    output_dir = tmp_path / "latest"

    artifact = build(
        Namespace(
            peopleportal_zip=peopleportal_zip,
            gitea_analytics=analytics,
            gitea_manifest=manifest,
            output_dir=output_dir,
        )
    )

    assert artifact["summary"]["profilesIncluded"] == 1
    assert artifact["summary"]["profilesExcludedCompletelyRejected"] == 0
    assert artifact["summary"]["profilesWithAllRejectedApplications"] == 1
    assert artifact["summary"]["giteaMatchedProfiles"] == 1
    profile = artifact["profiles"][0]
    assert profile["people_portal"]["allApplicationsRejected"] is True
    assert artifact["recruiting_source"]["candidate_count"] == 1
