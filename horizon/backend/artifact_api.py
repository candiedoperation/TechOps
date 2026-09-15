"""Authenticated access to complete pipeline runs; never serve the repository."""
from pathlib import Path
import re

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from .auth import AuthUser, get_current_user
from .config import Settings, get_settings

router = APIRouter()
ARTIFACTS = {"analytics.json", "member-analytics.md", "manifest.json", "pipeline-manifest.json", "member-profiles.json",
             "member-profiles-manifest.json", "identity-review.json", "recruiting-source.json",
             "llm-ranking-export/manifest.json", "llm-ranking-export/members.jsonl",
             "llm-ranking-export/evidence.jsonl", "llm-ranking-export/coverage.json",
             "llm-ranking-export/source-registry.json"}


@router.get("/artifacts/{run_id}/{artifact_path:path}")
async def artifact(run_id: str, artifact_path: str, user: AuthUser = Depends(get_current_user),
                   settings: Settings = Depends(get_settings)):
    root = Path(settings.artifact_root).resolve()
    if run_id != "latest" and not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", run_id):
        raise HTTPException(status_code=404, detail="artifact run not found")
    run = (root / run_id).resolve()
    path = (run / artifact_path).resolve()
    allowed = artifact_path in ARTIFACTS or (
        artifact_path.startswith("llm-ranking-export/")
        and path.suffix.lower() in {".json", ".jsonl"}
    ) or (
        artifact_path.startswith("resumes/") and path.suffix.lower() == ".pdf")
    if not allowed or not run.is_relative_to(root) or not path.is_relative_to(run) or not path.is_file():
        raise HTTPException(status_code=404, detail="artifact not found")
    return FileResponse(path, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                      "Content-Security-Policy": "sandbox"})
