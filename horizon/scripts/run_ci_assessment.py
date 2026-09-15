#!/usr/bin/env python3
"""Run the project-health CI assessment from a local checkout or CI runner.

By default the assessment uses the deterministic rule engine only, which
requires no API key.  Pass ``--llm`` to enable LLM enrichment; the
``PHI_GEMINI_API_KEY`` environment variable (or ``GEMINI_API_KEY``) must
be set and the ``google-genai`` package must be installed
(``pip install 'app-dev-horizon[llm]'``).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.ci_agent import CIEvidence, assessment_payload, normalize_spec  # noqa: E402
from backend.ci_llm import LLMAssessor, assess_project_llm  # noqa: E402


def git(*args: str) -> str:
    try:
        return subprocess.check_output(["git", *args], cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def local_evidence(project_id: str, week: int) -> CIEvidence:
    in_github_actions = bool(os.getenv("GITHUB_ACTIONS") or os.getenv("GITHUB_SHA"))
    sha = os.getenv("GITHUB_SHA") or git("rev-parse", "HEAD") or "local-uncommitted"
    branch = os.getenv("GITHUB_HEAD_REF") or os.getenv("GITHUB_REF_NAME") or git("branch", "--show-current") or None
    if in_github_actions:
        changed = git("diff", "--name-only", "HEAD~1", "HEAD").splitlines()
    else:
        changed = []
        for line in git("status", "--short", "--untracked-files=all").splitlines():
            if not line.strip():
                continue
            path = line[3:]
            if " -> " in path:
                path = path.rsplit(" -> ", 1)[-1]
            changed.append(path)
        changed.extend(git("diff", "--name-only").splitlines())
        changed.extend(git("diff", "--cached", "--name-only").splitlines())
    changed = list(dict.fromkeys(path for path in changed if path.strip()))
    return CIEvidence(project_id=project_id, commit_sha=sha, branch=branch, changed_files=changed, expected_week=week, observed_at=datetime.now(timezone.utc))


def _build_assessor(args: argparse.Namespace) -> LLMAssessor | None:
    """Build an ``LLMAssessor`` from CLI flags and environment variables."""
    if not args.llm:
        return None
    api_key = (
        args.gemini_api_key
        or os.getenv("PHI_GEMINI_API_KEY")
        or os.getenv("GEMINI_API_KEY")
    )
    if not api_key:
        print(
            "WARNING: --llm requested but no API key found. "
            "Set PHI_GEMINI_API_KEY or GEMINI_API_KEY. "
            "Falling back to deterministic assessment.",
            file=sys.stderr,
        )
        return None
    try:
        from backend.llm import GeminiStructuredLLM, LLMUnavailable
    except ImportError:
        print(
            "WARNING: google-genai SDK not installed. "
            "Run: pip install 'app-dev-horizon[llm]'. "
            "Falling back to deterministic assessment.",
            file=sys.stderr,
        )
        return None
    model = (
        args.llm_model
        or os.getenv("PHI_LLM_ASSESSMENT_MODEL")
        or os.getenv("PHI_GEMINI_MODEL", "gemini-2.5-flash")
    )
    try:
        llm = GeminiStructuredLLM(api_key=api_key, timeout_s=30.0)
        return LLMAssessor(llm, model=model)
    except LLMUnavailable as exc:
        print(f"WARNING: LLM unavailable ({exc}). Falling back to deterministic.", file=sys.stderr)
        return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the project-health CI assessment from a local checkout or CI runner."
    )
    parser.add_argument("--project-id", required=True, help="Stable project slug.")
    parser.add_argument("--spec", type=Path, required=True, help="Path to YAML or Markdown spec file.")
    parser.add_argument("--evidence", type=Path, help="Path to JSON evidence file (optional).")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("project-health-assessment.json"),
        help="Output path for the JSON assessment.",
    )
    parser.add_argument("--week", type=int, help="Override the assessment week number.")
    parser.add_argument("--ingest-url", help="Dashboard API URL for POSTing the assessment.")
    parser.add_argument("--token", help="Bearer token for the dashboard ingest endpoint.")
    parser.add_argument("--fail-on-risk", action="store_true", help="Exit 2 on at_risk or insufficient_data.")
    # LLM flags
    parser.add_argument(
        "--llm",
        action="store_true",
        default=False,
        help=(
            "Enable LLM enrichment (requires google-genai SDK and PHI_GEMINI_API_KEY). "
            "Falls back to deterministic on any failure."
        ),
    )
    parser.add_argument(
        "--gemini-api-key",
        default=None,
        help="Gemini API key (overrides PHI_GEMINI_API_KEY env var).",
    )
    parser.add_argument(
        "--llm-model",
        default=None,
        help="Model for weekly assessment (default: PHI_GEMINI_MODEL or gemini-2.5-flash).",
    )
    parser.add_argument(
        "--progress-summary",
        default=None,
        help=(
            "Free-form weekly progress update from the project lead. "
            "Included in the LLM prompt when --llm is set. "
            "Must not contain @handles, email addresses, or git co-author trailers."
        ),
    )
    args = parser.parse_args()

    spec = normalize_spec(args.spec, project_id=args.project_id)

    if args.evidence:
        evidence = CIEvidence.model_validate(json.loads(args.evidence.read_text(encoding="utf-8")))
        if args.week is not None:
            evidence.expected_week = args.week
    else:
        week = args.week if args.week is not None else int(os.getenv("PROJECT_HEALTH_WEEK", "2"))
        evidence = local_evidence(args.project_id, week)

    # Attach narrative progress summary if provided
    if args.progress_summary:
        evidence = evidence.model_copy(update={"progress_summary": args.progress_summary})

    assessor = _build_assessor(args)
    assessment = asyncio.run(assess_project_llm(spec, evidence, assessor=assessor))

    payload = assessment_payload(assessment)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    if args.ingest_url:
        body = json.dumps({
            "project_id": args.project_id,
            "spec": (
                yaml.safe_load(args.spec.read_text(encoding="utf-8"))
                if args.spec.suffix != ".md"
                else args.spec.read_text(encoding="utf-8")
            ),
            "spec_format": "markdown" if args.spec.suffix == ".md" else "yaml",
            "evidence": evidence.model_dump(mode="json"),
        }).encode()
        headers = {"Content-Type": "application/json"}
        if args.token:
            headers["Authorization"] = f"Bearer {args.token}"
        request = Request(args.ingest_url, data=body, headers=headers, method="POST")
        with urlopen(request, timeout=20) as response:
            if response.status >= 300:
                raise RuntimeError(f"dashboard ingest returned HTTP {response.status}")

    print(json.dumps(payload, indent=2))
    return 2 if args.fail_on_risk and assessment.status.value in {"at_risk", "insufficient_data"} else 0


if __name__ == "__main__":
    raise SystemExit(main())
