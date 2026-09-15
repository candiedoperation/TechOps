#!/usr/bin/env python3
"""Initialize the Docker live stack, then serve the intelligence API."""

from __future__ import annotations

import asyncio
import os
import sys
import time
import urllib.error
import urllib.request


def _wait_for_http(url: str, *, timeout_seconds: int) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if 200 <= response.status < 500:
                    return
        except (OSError, urllib.error.URLError) as error:
            last_error = error
        time.sleep(2)
    raise RuntimeError(f"timed out waiting for {url}: {last_error}")


def _configure_gitea_token() -> None:
    if os.getenv("PHI_GITEA_API_TOKEN"):
        return
    token_file = os.getenv("PHI_GITEA_TOKEN_FILE", "/run/secrets/gitea_api_token")
    try:
        with open(token_file, encoding="utf-8") as handle:
            token = handle.read().strip()
    except OSError as error:
        raise RuntimeError(
            f"could not read the Gitea token at {token_file}; run scripts/seed_live_gitea.py first"
        ) from error
    if not token:
        raise RuntimeError(f"the Gitea token file at {token_file} is empty")
    os.environ["PHI_GITEA_API_TOKEN"] = token


async def _refresh_sources() -> None:
    from backend.config import get_settings
    from backend.db import close_db, get_active_repository, init_db
    from backend.jobs import run_nightly_sync, run_weekly_backfill

    get_settings.cache_clear()
    settings = get_settings()
    await init_db(settings)
    try:
        database = get_active_repository()
        nightly = await run_nightly_sync(
            settings=settings,
            database=database,
            lookback_days=14,
        )
        if nightly.get("status") not in {"ok", "partial"}:
            raise RuntimeError(f"nightly source refresh failed: {nightly.get('status')}")

        weeks = max(1, int(os.getenv("PHI_BACKFILL_WEEKS", "10")))
        backfill = await run_weekly_backfill(
            settings=settings,
            database=database,
            weeks=weeks,
        )
        if backfill.get("status") not in {"ok", "partial"}:
            raise RuntimeError(f"historical source refresh failed: {backfill.get('status')}")

        catalog = nightly.get("project_catalog") or {}
        project_count = int(catalog.get("projects_written", 0) or 0) + int(catalog.get("projects_refreshed", 0) or 0)
        print(
            "Project Health Intelligence sources refreshed: "
            f"directory={nightly.get('directory_source')} "
            f"projects={project_count} "
            f"gitea={nightly.get('gitea', {}).get('repos_seen', 0)} repos "
            f"backfill={backfill.get('snapshots_written', 0)} snapshots"
        )
    finally:
        await close_db()


def main() -> None:
    _configure_gitea_token()
    timeout = max(10, int(os.getenv("PHI_UPSTREAM_TIMEOUT_SECONDS", "120")))
    _wait_for_http(
        f"{os.getenv('PHI_PEOPLE_PORTAL_URL', 'http://people-portal-server:3000')}/api/docs/swagger.json",
        timeout_seconds=timeout,
    )
    _wait_for_http(
        f"{os.getenv('PHI_GITEA_URL', 'http://gitea:3000')}/api/healthz",
        timeout_seconds=timeout,
    )
    asyncio.run(_refresh_sources())

    port = os.getenv("PORT", "8000")
    os.execv(
        sys.executable,
        [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", port],
    )


if __name__ == "__main__":
    main()
