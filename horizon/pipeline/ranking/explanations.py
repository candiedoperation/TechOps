"""T4.6 explanations: a plain-language summary of one member's stored scores.

The model sees only this member's own numbers (``explanation_input``): no
names, ids, other members, survey answers or evidence. Its answer is
validated; after a second invalid answer, or when the API is unavailable, a
deterministic fallback built from the numbers is stored with
``generated = false``, so publishing is never blocked.

The tool is offered with ``tool_choice = auto`` and the answer validated,
because some current models reject a forced tool choice.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import time
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

from .members import RankedMember
from .read_models import StoredMetric, StoredScore, comparison_group_label
from .rubric import RoleRubric

PROMPT_VERSION = "explain-v1"
PROMPT_PATH = Path(__file__).parent / "prompts" / "explain_v1.md"
DEFAULT_MODEL = "claude-sonnet-5-5"
FALLBACK_MODEL = "deterministic-fallback"
MAX_CONCURRENT = 4
TOOL_NAME = "member_explanation"
_WORD = re.compile(r"\S+")


def _words(text: str) -> int:
    return len(_WORD.findall(text))


class ToolOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str
    bucket_notes: dict[str, str]
    data_gaps: list[str]

    @field_validator("summary")
    @classmethod
    def _summary(cls, value: str) -> str:
        if not value.strip() or _words(value) > 120:
            raise ValueError("summary must be 1 to 120 words")
        return value.strip()

    @field_validator("bucket_notes")
    @classmethod
    def _notes(cls, value: dict[str, str]) -> dict[str, str]:
        if any(not note.strip() or _words(note) > 40 for note in value.values()):
            raise ValueError("each bucket note must be 1 to 40 words")
        return {key: note.strip() for key, note in value.items()}


def explanation_input(
    member: RankedMember, role_rubric: RoleRubric, score: StoredScore,
    metrics: Mapping[str, StoredMetric], group_size: int,
) -> dict[str, Any]:
    """Everything the model may see about one member, and nothing else."""

    weights = role_rubric.effective_weights(member.excluded_buckets)
    return {
        "role": member.role,
        "comparison_group": comparison_group_label(member),
        "comparison_group_size": group_size,
        "status": score.status,
        "overall_score": score.overall_score,
        "coverage": score.coverage,
        "buckets": {
            bucket.key: {
                "label": bucket.label,
                "weight": weights[bucket.key] / 100,
                "score": score.buckets.get(bucket.key, {}).get("score"),
                "metrics": [
                    {"label": metric.label, "unit": metric.unit,
                     "raw_value": metrics[metric.key].raw_value,
                     "percentile": metrics[metric.key].percentile,
                     "missing_reason": metrics[metric.key].missing_reason}
                    for metric in bucket.metrics
                ],
            }
            for bucket in role_rubric.buckets if bucket.key in weights
        },
    }


def input_sha256(data: Mapping[str, Any]) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def fallback(data: Mapping[str, Any]) -> dict[str, Any]:
    """An explanation that only restates the numbers."""

    if data["overall_score"] is None:
        headline = f"No overall score: the status is {data['status'].replace('_', ' ')}."
    else:
        headline = f"Overall score {data['overall_score']:.1f}."
    summary = (f"{headline} Compared with {data['comparison_group']} ({data['comparison_group_size']} people); "
               f"coverage is {data['coverage']:.0%}. Missing data lowers coverage and is not low performance.")
    notes, gaps = {}, []
    for key, bucket in data["buckets"].items():
        notes[key] = (f"Bucket score {bucket['score']:.1f}." if bucket["score"] is not None
                      else "No score: none of its metrics has data.")
        for metric in bucket["metrics"]:
            if metric["missing_reason"]:
                gaps.append(f"{metric['label']}: {metric['missing_reason'].replace('_', ' ')}")
    return {"summary": summary, "bucket_notes": notes, "data_gaps": gaps,
            "model": FALLBACK_MODEL, "generated": False}


def _tool(bucket_keys: Sequence[str]) -> dict[str, Any]:
    return {
        "name": TOOL_NAME,
        "description": "Explain the member's existing ranking numbers without changing them.",
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["summary", "bucket_notes", "data_gaps"],
            "properties": {
                "summary": {"type": "string", "description": "At most 120 words."},
                "bucket_notes": {
                    "type": "object", "additionalProperties": False, "required": list(bucket_keys),
                    "properties": {key: {"type": "string", "description": "At most 40 words."}
                                   for key in bucket_keys},
                },
                "data_gaps": {"type": "array", "items": {"type": "string"}},
            },
        },
    }


def _ask(client, model: str, data: Mapping[str, Any]) -> tuple[ToolOutput, str]:
    keys = list(data["buckets"])
    response = client.messages.create(
        model=model, max_tokens=800, system=PROMPT_PATH.read_text(),
        messages=[{"role": "user", "content": json.dumps(data, sort_keys=True)}],
        tools=[_tool(keys)], tool_choice={"type": "auto"},
    )
    calls = [block for block in response.content
             if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == TOOL_NAME]
    if len(calls) != 1:
        raise ValueError("the response did not call the explanation tool exactly once")
    output = ToolOutput.model_validate(calls[0].input)
    if set(output.bucket_notes) != set(keys):
        raise ValueError("bucket notes do not match the member's buckets")
    return output, getattr(response, "model", None) or model


def _is_rate_limit(error: Exception) -> bool:
    return getattr(error, "status_code", None) in (429, 529) or type(error).__name__ in (
        "RateLimitError", "OverloadedError")


def explain(
    client, model: str, data: Mapping[str, Any], *,
    sleep: Callable[[float], None] = time.sleep, rate_limit_retries: int = 4,
) -> dict[str, Any]:
    """One member's explanation: two tries at a valid answer, then the fallback.

    Rate limits back off and do not use up a try; any other error does.
    """

    if client is None:
        return fallback(data)
    tries, waits = 0, 0
    while tries < 2:
        try:
            output, used_model = _ask(client, model, data)
            return {**output.model_dump(), "model": used_model, "generated": True}
        except Exception as error:  # noqa: BLE001 -- any failure falls back
            if _is_rate_limit(error) and waits < rate_limit_retries:
                waits += 1
                sleep(min(30.0, 2 ** waits) + random.random())
                continue
            tries += 1
    return fallback(data)


def explain_all(client, model: str, inputs: Sequence[Mapping[str, Any]], **options) -> list[dict[str, Any]]:
    """Explanations in input order, with at most four requests in flight."""

    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT) as pool:
        return list(pool.map(lambda data: explain(client, model, data, **options), inputs))


def make_client(api_key: str | None, timeout_seconds: float = 120.0):
    """An Anthropic client, or None when no key is configured (fallbacks only)."""

    if not api_key or not api_key.strip():
        return None
    from anthropic import Anthropic

    return Anthropic(api_key=api_key.strip(), timeout=timeout_seconds, max_retries=0)
