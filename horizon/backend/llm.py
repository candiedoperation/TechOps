"""LLM provider transport for Horizon's optional qualitative analysis.

The concrete implementation uses Google's GenAI SDK structured JSON output.
The rest of Horizon depends only on :class:`StructuredLLM`, so provider
transport remains isolated from prompts, evidence extraction, and deterministic
scoring.

The ``google-genai`` package is an *optional* dependency (``pip install
'app-dev-horizon[llm]'``). Importing this module remains safe when the optional
package is absent; the missing dependency is converted to ``LLMUnavailable``
only when an enabled provider is constructed.
"""

from __future__ import annotations

import json
from typing import Any, Protocol

from .errors import ProjectHealthError


class LLMUnavailable(ProjectHealthError):
    """The LLM provider was unreachable, misconfigured, or returned unusable output."""


class StructuredLLM(Protocol):
    """Minimal interface for a provider that returns one structured JSON object."""

    async def call_tool(
        self,
        *,
        system: str,
        user: str,
        tool: dict[str, Any],
        model: str,
        max_tokens: int,
    ) -> dict[str, Any]: ...


class GeminiStructuredLLM:
    """Google GenAI implementation of :class:`StructuredLLM`.

    Existing callers describe their desired response as a named tool with an
    ``input_schema``. Gemini receives that schema as structured JSON output,
    which keeps the provider boundary small and preserves the existing prompt
    and validation behavior.

    Args:
        api_key: Gemini API key (``PHI_GEMINI_API_KEY``).
        timeout_s: Per-request timeout in seconds. Defaults to 20 s for weekly
            assessments; use a higher value (≤120 s) for spec decomposition.
        max_retries: SDK-level retry attempts on transient network errors.
        client: Optional injected client for tests; production callers use the
            SDK client created from ``api_key``.
    """

    def __init__(
        self,
        api_key: str,
        *,
        timeout_s: float = 20.0,
        max_retries: int = 1,
        client: Any | None = None,
    ) -> None:
        if client is not None:
            self._client = client
            return
        try:
            from google import genai
            from google.genai import types
        except ModuleNotFoundError as exc:
            raise LLMUnavailable(
                "google-genai SDK is not installed; run: pip install 'app-dev-horizon[llm]'"
            ) from exc
        try:
            self._client = genai.Client(
                api_key=api_key,
                http_options=types.HttpOptions(
                    timeout=max(1, int(timeout_s * 1_000)),
                    retry_options=types.HttpRetryOptions(attempts=max(1, max_retries + 1)),
                ),
            )
        except Exception as exc:
            raise LLMUnavailable("Gemini provider could not be configured") from exc

    async def call_tool(
        self,
        *,
        system: str,
        user: str,
        tool: dict[str, Any],
        model: str,
        max_tokens: int = 2_048,
    ) -> dict[str, Any]:
        """Call the provider and return the tool's argument dict.

        Raises:
            LLMUnavailable: On any provider error, timeout, or if the model
                returns unusable structured output.
        """
        schema = tool.get("input_schema", tool.get("parameters", {}))
        try:
            from google.genai import types

            response = await self._client.aio.models.generate_content(
                model=model,
                contents=user,
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    response_mime_type="application/json",
                    response_schema=schema,
                    temperature=0,
                    max_output_tokens=max_tokens,
                ),
            )
        except Exception as exc:
            # Carry the provider's own wording. A retired model, a revoked key
            # and a network timeout all arrive here, and the caller degrades to
            # deterministic scoring for each; without the reason on the message
            # a misconfiguration is indistinguishable from an outage.
            raise LLMUnavailable(f"LLM provider request failed ({type(exc).__name__}: {exc})") from exc

        text = getattr(response, "text", None)
        if not isinstance(text, str) or not text.strip():
            raise LLMUnavailable("Gemini response was empty or truncated")
        try:
            result = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMUnavailable("Gemini returned invalid JSON") from exc
        if not isinstance(result, dict):
            raise LLMUnavailable("Gemini response must be a JSON object")
        return result
