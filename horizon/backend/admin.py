"""Token-gated HTTP triggers for the pull-only ingestion jobs.

``backend.jobs`` deliberately starts no scheduler of its own -- ``scripts/run_jobs.py``
is the supported entrypoint for cron/systemd/a Kubernetes CronJob. On a host where a
second process can't share the SQLite file with the web service (e.g. Render, where a
persistent disk attaches to exactly one service), these endpoints let an external
scheduler trigger the same jobs in-process on the service that owns the database
connection instead.

Every route requires the ``X-Admin-Sync-Token`` header to match ``PHI_ADMIN_SYNC_TOKEN``.
When that setting is unset, the routes refuse every request -- there is no default-open
mode, since a sync job both writes data and makes outbound calls to the configured Gitea
org.
"""

from __future__ import annotations

import secrets
from pathlib import Path
from datetime import date
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field

from .config import get_settings
from .db import get_active_repository
from .llm import GeminiStructuredLLM, LLMUnavailable
from .member_analytics import ingest_file, ingest_payload
from .people_portal import PeoplePortalApiError, PeoplePortalRecruitingClient
from .recruiting import RecruitingSignalJudge, persist_people_portal_payload, run_recruiting_pipeline
from .jobs import run_nightly_sync, run_weekly_backfill, run_weekly_snapshot_job

router = APIRouter(prefix="/admin/sync", tags=["admin"])


def _check_token(provided: str | None) -> None:
    settings = get_settings()
    if not settings.admin_sync_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="PHI_ADMIN_SYNC_TOKEN is not configured; sync endpoints are disabled",
        )
    if not provided or not secrets.compare_digest(provided.encode(), settings.admin_sync_token.encode()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or missing sync token")


@router.post("/nightly")
async def trigger_nightly_sync(
    lookback_days: int = Query(default=14, ge=1, le=90),
    x_admin_sync_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_token(x_admin_sync_token)
    return await run_nightly_sync(
        settings=get_settings(),
        database=get_active_repository(),
        lookback_days=lookback_days,
    )


@router.post("/weekly")
async def trigger_weekly_snapshot(
    week_start: date | None = Query(default=None),
    engine: str | None = Query(default=None, description="'llm' or 'rules'; defaults to 'llm' when configured, else 'rules'."),
    x_admin_sync_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_token(x_admin_sync_token)
    try:
        return await run_weekly_snapshot_job(
            settings=get_settings(),
            database=get_active_repository(),
            week_start=week_start,
            engine=engine,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/backfill")
async def trigger_backfill(
    weeks: int = Query(default=10, ge=1, le=52),
    through: date | None = Query(
        default=None,
        description="Replay the N weeks ending on this date, instead of ending today. "
        "Lets a large backfill be split into smaller sequential HTTP calls "
        "(e.g. weeks=4 with `through` stepping back 4 weeks each call) so no "
        "single request runs long enough to risk a client/proxy timeout.",
    ),
    x_admin_sync_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_token(x_admin_sync_token)
    return await run_weekly_backfill(
        settings=get_settings(),
        database=get_active_repository(),
        through=through,
        weeks=weeks,
    )


@router.post("/reset")
async def trigger_reset(
    confirm: str = Query(description="Must be exactly 'erase-all-data' to proceed."),
    x_admin_sync_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Wipe every row in every collection, including immutable weekly snapshots.

    Intended as a one-time step to clear the bundled demo fixtures before
    pointing the service at a real Gitea org, so leftover mock projects don't
    sit alongside real ones. Irreversible; the ``confirm`` query param exists
    so it can't be triggered by an accidental request.
    """
    _check_token(x_admin_sync_token)
    if confirm != "erase-all-data":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="pass ?confirm=erase-all-data to proceed",
        )
    await get_active_repository().clear()
    return {"status": "reset"}


@router.get("/diagnostics/gitea-diff")
async def diagnose_gitea_diff(
    org: str,
    repo: str,
    sha: str,
    x_admin_sync_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """One-off check that the deployed Gitea instance/token can serve raw commit diffs.

    Exists to verify ``GET /repos/{org}/{repo}/git/commits/{sha}.diff`` (the
    endpoint the lazy LLM-signal feature depends on for real code evidence)
    without ever exposing ``PHI_GITEA_API_TOKEN`` to the caller -- the token
    stays server-side, only a status code and a content preview come back.
    """
    _check_token(x_admin_sync_token)
    settings = get_settings()
    if not settings.gitea_url or not settings.gitea_api_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="PHI_GITEA_URL and PHI_GITEA_API_TOKEN must both be set",
        )
    import httpx

    url = f"{settings.gitea_url.rstrip('/')}/api/v1/repos/{org}/{repo}/git/commits/{sha}.diff"
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            response = await client.get(
                url, headers={"Authorization": f"token {settings.gitea_api_token}"}
            )
        except Exception as exc:
            return {"ok": False, "url": url, "error": str(exc)}
    body = response.text
    result = {
        "ok": response.status_code == 200 and "diff --git" in body,
        "url": url,
        "status_code": response.status_code,
        "content_type": response.headers.get("content-type"),
        "byte_length": len(body.encode("utf-8", errors="replace")),
        "preview": body[:300],
    }
    meta_url = f"{settings.gitea_url.rstrip('/')}/api/v1/repos/{org}/{repo}/git/commits/{sha}?stat=true&files=true"
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            meta_response = await client.get(
                meta_url, headers={"Authorization": f"token {settings.gitea_api_token}"}
            )
            meta = meta_response.json()
            result["commit_meta_keys"] = sorted(meta.keys())
            result["stats"] = meta.get("stats")
            files = meta.get("files")
            result["files_sample"] = files[:2] if isinstance(files, list) else files
        except Exception as exc:
            result["commit_meta_error"] = str(exc)
    return result


class MemberAnalyticsIngestRequest(BaseModel):
    """Either a path to a run on disk, or the analytics payload itself."""

    model_config = ConfigDict(extra="forbid")

    path: str | None = Field(
        default=None,
        description="analytics.json file, or a pipeline run directory containing one",
    )
    payload: dict[str, Any] | None = Field(default=None, description="Inline analytics payload")
    run_id: str | None = Field(default=None, max_length=64)


class RecruitingSyncRequest(BaseModel):
    """Optional inline People Portal export for tests and controlled backfills."""

    model_config = ConfigDict(extra="forbid")
    payload: dict[str, Any] | None = None
    source_run_id: str | None = Field(default=None, max_length=100)
    member_analytics_run_id: str | None = Field(default=None, max_length=64)
    ranking: dict[str, Any] | None = Field(default=None, description="Bounded shared People Portal + Gitea ranking snapshot")


def _recruiting_judge(settings: Any) -> RecruitingSignalJudge | None:
    if not settings.llm_active:
        return None
    try:
        return RecruitingSignalJudge(
            GeminiStructuredLLM(
                api_key=settings.gemini_api_key,
                timeout_s=settings.llm_recruiting_timeout_seconds,
            ),
            model=settings.recruiting_model,
        )
    except LLMUnavailable:
        return None


@router.post("/member-analytics")
async def ingest_member_analytics(
    request: MemberAnalyticsIngestRequest,
    x_admin_sync_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Load one Gitea member-analytics run into the store.

    Re-ingesting a run replaces its rows rather than adding duplicates, so an
    external scheduler can call this after every collection without pruning.
    """
    _check_token(x_admin_sync_token)
    if bool(request.path) == bool(request.payload):
        raise HTTPException(status_code=422, detail="provide exactly one of 'path' or 'payload'")
    try:
        if request.path:
            path = Path(request.path).resolve()
            if not path.is_relative_to(Path(get_settings().artifact_root).resolve()):
                raise ValueError("analytics path must be inside PHI_ARTIFACT_ROOT")
            return await ingest_file(path, request.run_id)
        return await ingest_payload(request.payload or {}, request.run_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/recruiting")
async def sync_recruiting(
    request: RecruitingSyncRequest,
    x_admin_sync_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Pull People Portal's authenticated generated SDK APIs and run the signal pipeline.

    The live path uses the generated organization directory and ATS operations.
    An inline payload is still accepted for local
    tests and controlled historical imports. Raw resume files are never
    accepted here.
    """
    _check_token(x_admin_sync_token)
    settings = get_settings()
    payload = request.payload
    if payload is None:
        if not settings.people_portal_url:
            raise HTTPException(status_code=503, detail="PHI_PEOPLE_PORTAL_URL is not configured")
        if not settings.people_portal_api_token:
            raise HTTPException(status_code=503, detail="PHI_PEOPLE_PORTAL_API_TOKEN is not configured")
        client = PeoplePortalRecruitingClient(
            base_url=settings.people_portal_url,
            token=settings.people_portal_api_token,
            timeout=settings.llm_recruiting_timeout_seconds,
        )
        try:
            payload = await client.fetch_source()
        except PeoplePortalApiError as exc:
            raise HTTPException(status_code=502, detail="People Portal recruiting export failed") from exc
        finally:
            await client.close()
    try:
        source_result = await persist_people_portal_payload(
            get_active_repository(), payload, source_run_id=request.source_run_id, ranking=request.ranking,
        )
        run = await run_recruiting_pipeline(
            get_active_repository(),
            settings=settings,
            judge=_recruiting_judge(settings),
            source_run_id=source_result["source_run_id"],
            member_analytics_run_id=request.member_analytics_run_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "source": source_result,
        "run": {"run_id": run.run_id, "candidate_count": run.candidate_count, "llm_used": run.llm_used} if run else None,
    }
