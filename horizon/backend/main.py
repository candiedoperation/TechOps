from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .admin import router as admin_router
from .api import router
from .artifact_api import router as artifact_router
from .config import get_settings
from .db import close_db, init_db
from .seed import seed_demo_data


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    await init_db(settings)
    # The bundled fixtures are for local/demo runs only. A production
    # deployment ingests real projects through /boundaries and the
    # /admin/sync/* jobs, so seeding mock data there would just leave it
    # sitting alongside (or after a reset, reappearing next to) real data.
    seed_demo = os.getenv("PHI_SEED_DEMO_DATA", "true").strip().lower() in {"1", "true", "yes", "on"}
    if settings.environment in {"local", "test", "demo"} and seed_demo:
        await seed_demo_data()
    try:
        yield
    finally:
        await close_db()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Admin-Sync-Token", "X-Reviewer-Id", "X-Agent-Ingest-Token"],
    )
    app.include_router(router)
    app.include_router(admin_router)
    app.include_router(artifact_router)
    return app


app = create_app()
