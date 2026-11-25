import json
from datetime import date
from types import SimpleNamespace

import pytest

from pipeline.ranking import explanations
from pipeline.ranking.members import RankedMember
from pipeline.ranking.read_models import StoredMetric, StoredScore
from pipeline.ranking.rubric import load_rubric
from pipeline.ranking.scoring import scored_metric_keys

ROLE = load_rubric("v1").rubric.roles["engineer"]
BUCKETS = [bucket.key for bucket in ROLE.buckets]
MEMBER = RankedMember("42", "proj-x", "engineer", "Ada Lovelace", "Engineer", "Project X",
                      "project:proj-x:engineer", 3, date(2026, 8, 31), date(2026, 12, 11))


def _input():
    metrics = {key: StoredMetric(2.0, None, 50.0, 4, {"pull_requests": ["org/api#12"]})
               for key in scored_metric_keys(ROLE)}
    metrics["verified_completion"] = StoredMetric(None, "no_owned_tasks", None, 3, {})
    score = StoredScore({key: {"score": 50.0, "metricCoverage": 1.0} for key in BUCKETS},
                        61.2, 0.8, "ranked", 2, 4)
    return explanations.explanation_input(MEMBER, ROLE, score, metrics, group_size=4)


def _answer(notes=None, summary="Ada's numbers are in the middle of the group."):
    return {"summary": summary, "bucket_notes": notes or {key: "Middle of the group." for key in BUCKETS},
            "data_gaps": ["No owned SOW tasks yet."]}


class FakeClient:
    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []
        self.messages = self

    def create(self, **request):
        self.calls.append(request)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return SimpleNamespace(model="claude-test", content=[
            SimpleNamespace(type="text", text="Here you go."),
            SimpleNamespace(type="tool_use", name="member_explanation", input=answer),
        ])


def test_input_has_only_this_members_numbers():
    data = _input()
    text = json.dumps(data)
    assert "Ada" not in text and "42" not in text and "org/api#12" not in text
    assert data["comparison_group"] == "Engineers on Project X"
    assert data["comparison_group_size"] == 4
    assert set(data["buckets"]) == set(BUCKETS)
    metric = data["buckets"]["delivery"]["metrics"][0]
    assert set(metric) == {"label", "unit", "raw_value", "percentile", "missing_reason"}
    assert explanations.input_sha256(data) == explanations.input_sha256(json.loads(text))


def test_a_valid_answer_is_stored_with_the_model():
    client = FakeClient(_answer())
    result = explanations.explain(client, "claude-sonnet-5-5", _input())
    assert result["generated"] is True and result["model"] == "claude-test"
    assert result["bucket_notes"]["delivery"] == "Middle of the group."
    request = client.calls[0]
    assert request["tool_choice"] == {"type": "auto"}
    assert request["tools"][0]["input_schema"]["properties"]["bucket_notes"]["required"] == BUCKETS


def test_an_invalid_answer_is_retried_once_then_falls_back():
    too_long = _answer(summary="word " * 121)
    wrong_buckets = _answer(notes={"delivery": "Only one bucket."})
    client = FakeClient(too_long, wrong_buckets)
    result = explanations.explain(client, "m", _input())
    assert len(client.calls) == 2
    assert result["generated"] is False and result["model"] == explanations.FALLBACK_MODEL
    assert "Overall score 61.2" in result["summary"]
    assert set(result["bucket_notes"]) == set(BUCKETS)
    assert result["data_gaps"] == ["Verified task completion: no owned tasks"]


def test_rate_limits_back_off_without_using_a_try():
    limited = RuntimeError("slow down")
    limited.status_code = 429
    waits = []
    client = FakeClient(limited, limited, _answer())
    result = explanations.explain(client, "m", _input(), sleep=waits.append)
    assert result["generated"] is True and len(waits) == 2


def test_no_api_key_means_fallbacks_and_no_client():
    assert explanations.make_client(None) is None and explanations.make_client("  ") is None
    assert explanations.explain(None, "m", _input())["generated"] is False


def test_explain_all_keeps_input_order():
    client = FakeClient(*[_answer(summary=f"Member {i}.") for i in range(6)])
    results = explanations.explain_all(client, "m", [_input()] * 6)
    assert len(results) == 6 and all(r["generated"] for r in results)
    assert sorted(r["summary"] for r in results) == [f"Member {i}." for i in range(6)]


def test_fallback_for_an_unranked_member():
    data = {**_input(), "status": "insufficient_data", "overall_score": None}
    data["buckets"]["delivery"]["score"] = None
    result = explanations.fallback(data)
    assert result["summary"].startswith("No overall score: the status is insufficient data.")
    assert result["bucket_notes"]["delivery"] == "No score: none of its metrics has data."


@pytest.mark.parametrize("words", [120])
def test_summary_limit_is_inclusive(words):
    assert explanations.ToolOutput(summary="w " * words, bucket_notes={}, data_gaps=[])
