"""Focused tests for the optional Gemini structured-output transport."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from backend.llm import GeminiStructuredLLM, LLMUnavailable


class FakeModels:
    def __init__(self, response: Any = None, error: Exception | None = None) -> None:
        self.response = response
        self.error = error
        self.calls: list[dict[str, Any]] = []

    async def generate_content(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.response


class FakeClient:
    def __init__(self, response: Any = None, error: Exception | None = None) -> None:
        self.aio = SimpleNamespace(models=FakeModels(response=response, error=error))


TOOL = {
    "name": "emit_signal",
    "description": "Emit a structured signal.",
    "input_schema": {
        "type": "object",
        "properties": {"status": {"type": "string"}},
        "required": ["status"],
    },
}


@pytest.mark.asyncio
async def test_gemini_transport_returns_structured_json_without_network() -> None:
    client = FakeClient(SimpleNamespace(text=json.dumps({"status": "watch"})))
    llm = GeminiStructuredLLM("test-key", client=client)

    result = await llm.call_tool(
        system="Return only the requested JSON.",
        user="Assess this evidence.",
        tool=TOOL,
        model="gemini-2.5-flash",
        max_tokens=256,
    )

    assert result == {"status": "watch"}
    request = client.aio.models.calls[0]
    assert request["model"] == "gemini-2.5-flash"
    assert request["contents"] == "Assess this evidence."
    assert request["config"].system_instruction == "Return only the requested JSON."
    assert request["config"].response_mime_type == "application/json"
    assert request["config"].response_schema == TOOL["input_schema"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [SimpleNamespace(text=""), SimpleNamespace(text="not-json"), SimpleNamespace(text="[]")],
)
async def test_gemini_transport_fails_closed_on_unusable_output(response: Any) -> None:
    llm = GeminiStructuredLLM("test-key", client=FakeClient(response))

    with pytest.raises(LLMUnavailable):
        await llm.call_tool(system="system", user="user", tool=TOOL, model="test", max_tokens=32)


@pytest.mark.asyncio
async def test_gemini_transport_wraps_provider_errors() -> None:
    llm = GeminiStructuredLLM("test-key", client=FakeClient(error=RuntimeError("network")))

    with pytest.raises(LLMUnavailable, match="provider request failed"):
        await llm.call_tool(system="system", user="user", tool=TOOL, model="test", max_tokens=32)
