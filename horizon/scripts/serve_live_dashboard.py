#!/usr/bin/env python3
"""Serve the dashboard API against the running Docker live-test stack."""

from __future__ import annotations

import asyncio

from run_live_stack_test import configure


async def refresh_raw_sources() -> None:
    from backend.config import get_settings
    from backend.db import close_db, get_active_repository, init_db
    from backend.jobs import run_nightly_sync
    from backend.seed import seed_demo_data

    get_settings.cache_clear()
    settings = get_settings()
    await init_db(settings)
    try:
        await seed_demo_data()
        result = await run_nightly_sync(
            settings=settings,
            database=get_active_repository(),
            lookback_days=14,
        )
        if result.get("status") not in {"ok", "partial"}:
            raise RuntimeError(f"live source refresh failed: {result.get('status')}")
        print(
            "Refreshed dashboard sources: "
            f"directory={result.get('directory_source')} "
            f"projects={result.get('project_catalog', {}).get('projects_refreshed', 0)} "
            f"gitea={result.get('gitea', {}).get('repos_seen', 0)} repos"
        )
    finally:
        await close_db()


if __name__ == "__main__":
    configure()
    asyncio.run(refresh_raw_sources())
    import uvicorn

    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000)
