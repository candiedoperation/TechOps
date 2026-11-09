import pytest
import yaml
from pydantic import ValidationError

from pipeline.ranking.rubric import RUBRICS_DIR, load_rubric
from pipeline.ranking.store import RubricChangedError, upsert_rubric

UNITS = {"lines", "files", "commits", "PRs", "hours", "ratio", "rating_1_3", "semesters"}


def _weights(role):
    return {bucket.key: bucket.weight for bucket in role.buckets}


def _shares(role):
    return {
        (bucket.key, metric.key): metric.share
        for bucket in role.buckets
        for metric in bucket.metrics
    }


def test_v1_loads_with_the_card_weights():
    loaded = load_rubric("v1")
    rubric = loaded.rubric

    assert loaded.version == "v1"
    assert rubric.rules.min_coverage == 0.60
    assert rubric.rules.min_group_size == 2
    assert rubric.roles["engineer"].comparison_group == "project"
    assert rubric.roles["tech_lead"].comparison_group == "club"
    assert _weights(rubric.roles["engineer"]) == {
        "code_ownership": 30,
        "delivery": 20,
        "consistency": 15,
        "review_collaboration": 15,
        "peer_ratings": 10,
        "club_engagement": 10,
    }
    assert _weights(rubric.roles["tech_lead"]) == {
        "team_delivery": 30,
        "review_unblocking": 25,
        "leadership_ratings": 25,
        "team_consistency": 10,
        "own_code": 5,
        "club_engagement": 5,
    }
    engineer = _shares(rubric.roles["engineer"])
    assert engineer[("code_ownership", "files_majority_owned")] == 40
    assert engineer[("code_ownership", "non_boundary_lines")] == 35
    assert engineer[("code_ownership", "surviving_commits")] == 25
    assert engineer[("delivery", "verified_completion")] == 70
    assert engineer[("consistency", "active_week_ratio")] == 62.5
    assert engineer[("consistency", "end_loading")] == 37.5
    assert engineer[("review_collaboration", "prs_reviewed")] == 40
    assert engineer[("club_engagement", "tenure_semesters")] == 100
    assert {key for (bucket, key) in engineer if bucket == "peer_ratings"} == {
        "eng_timeliness", "eng_proactiveness", "eng_design", "eng_collaboration",
    }
    tech_lead = _shares(rubric.roles["tech_lead"])
    assert tech_lead[("review_unblocking", "team_prs_reviewed")] == 35
    assert tech_lead[("review_unblocking", "review_spread")] == 30
    assert tech_lead[("own_code", "files_majority_owned")] == 50
    assert tech_lead[("team_consistency", "team_end_loading")] == 100


def test_every_metric_has_a_label_and_a_known_unit():
    rubric = load_rubric("v1").rubric

    for role in rubric.roles.values():
        for bucket in role.buckets:
            assert bucket.label.strip()
            for metric in bucket.metrics:
                assert metric.label.strip(), metric.key
                assert metric.unit in UNITS, metric.key


def test_only_the_card_metrics_are_lower_is_better():
    rubric = load_rubric("v1").rubric

    lower = {
        metric.key
        for role in rubric.roles.values()
        for bucket in role.buckets
        for metric in bucket.metrics
        if metric.direction == "lower_is_better"
    }
    assert lower == {"end_loading", "review_turnaround_hours", "team_end_loading"}


def _write_variant(tmp_path, edit):
    data = yaml.safe_load((RUBRICS_DIR / "v1.yaml").read_text())
    edit(data)
    path = tmp_path / "v1.yaml"
    path.write_text(yaml.safe_dump(data))
    return path


def test_bucket_weights_summing_to_99_are_rejected(tmp_path):
    def drop_one_point(data):
        data["roles"]["engineer"]["buckets"][0]["weight"] = 29

    with pytest.raises(ValidationError, match="bucket weights sum to 99"):
        load_rubric("v1", _write_variant(tmp_path, drop_one_point))


def test_metric_shares_not_summing_to_100_are_rejected(tmp_path):
    def bump_share(data):
        data["roles"]["tech_lead"]["buckets"][1]["metrics"][0]["share"] = 36

    with pytest.raises(ValidationError, match="'review_unblocking' sum to 101"):
        load_rubric("v1", _write_variant(tmp_path, bump_share))


def test_an_unknown_unit_is_rejected(tmp_path):
    def bad_unit(data):
        data["roles"]["engineer"]["buckets"][0]["metrics"][0]["unit"] = "widgets"

    with pytest.raises(ValidationError):
        load_rubric("v1", _write_variant(tmp_path, bad_unit))


def test_a_blank_label_is_rejected(tmp_path):
    def blank_label(data):
        data["roles"]["engineer"]["buckets"][0]["metrics"][0]["label"] = "   "

    with pytest.raises(ValidationError, match="label must not be blank"):
        load_rubric("v1", _write_variant(tmp_path, blank_label))


def test_the_hash_is_stable_and_tracks_the_file_bytes(tmp_path):
    first, second = load_rubric("v1"), load_rubric("v1")
    assert first.sha256 == second.sha256
    assert len(first.sha256) == 64

    copy = tmp_path / "v1.yaml"
    copy.write_bytes((RUBRICS_DIR / "v1.yaml").read_bytes() + b"\n# edited\n")
    assert load_rubric("v1", copy).sha256 != first.sha256


class _FakeConnection:
    """Answers the rubric read-back with whatever sha256 is already stored."""

    def __init__(self, stored_sha256):
        self.stored_sha256 = stored_sha256
        self.statements = []

    def execute(self, statement, params=None):
        self.statements.append(" ".join(statement.split()))
        return self

    def fetchone(self):
        return (self.stored_sha256,)


def test_upsert_rubric_is_a_no_op_when_the_stored_hash_matches():
    loaded = load_rubric("v1")
    connection = _FakeConnection(loaded.sha256)

    upsert_rubric(connection, loaded)

    assert "ON CONFLICT (rubric_version) DO NOTHING" in connection.statements[0]
    assert not any(s.startswith("UPDATE") for s in connection.statements)


def test_upsert_rubric_refuses_a_changed_file_under_the_same_version():
    loaded = load_rubric("v1")
    connection = _FakeConnection("0" * 64)

    with pytest.raises(
        RubricChangedError, match="rubric v1 changed; create a new version instead"
    ):
        upsert_rubric(connection, loaded)
    assert not any(s.startswith("UPDATE") for s in connection.statements)
