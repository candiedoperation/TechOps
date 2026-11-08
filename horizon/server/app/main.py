from contextlib import asynccontextmanager

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from psycopg_pool import PoolTimeout

from .auth import JwtVerifier
from .config import Settings
from .db import ReadDatabase
from .errors import PublicationNotFound, ReadUnavailable
from .routers import router


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(application):
        database = (
            ReadDatabase(settings.database_url.get_secret_value())
            if settings.database_url
            else None
        )
        application.state.database = database
        if database:
            database.open()
        try:
            yield
        finally:
            if database:
                database.close()

    application = FastAPI(title="Horizon read API", version="0.1.0", lifespan=lifespan)
    application.state.verifier = JwtVerifier(settings)

    @application.middleware("http")
    async def no_store(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @application.exception_handler(HTTPException)
    async def http_error(request, error):
        return JSONResponse(
            {"error": {"code": f"http_{error.status_code}", "message": error.detail}},
            status_code=error.status_code,
            headers=error.headers,
        )

    @application.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        # Validation errors must not echo input tokens, identities, or unsafe query content.
        return JSONResponse(
            {
                "error": {
                    "code": "invalid_request",
                    "message": "Invalid request parameters.",
                }
            },
            status_code=422,
        )

    @application.exception_handler(PublicationNotFound)
    async def missing(request, error):
        return JSONResponse(
            {
                "error": {
                    "code": "not_found",
                    "message": "No completed publication matches this selection.",
                }
            },
            status_code=404,
        )

    async def unavailable(request, error):
        return JSONResponse(
            {
                "error": {
                    "code": "read_unavailable",
                    "message": "This Horizon read is not available.",
                }
            },
            status_code=503,
        )

    for error_type in (ReadUnavailable, psycopg.Error, PoolTimeout):
        application.add_exception_handler(error_type, unavailable)

    application.include_router(router)

    @application.get("/")
    def read_root():
        return {"Hello": "World from Horizon Server"}

    return application


app = create_app()
