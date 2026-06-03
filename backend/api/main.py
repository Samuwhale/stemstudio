import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from backend.api.routes.imports import router as imports_router
from backend.api.routes.storage import router as storage_router
from backend.api.routes.assets import router as assets_router
from backend.api.routes.exports import router as exports_router
from backend.api.routes.settings import router as settings_router
from backend.api.routes.system import router as system_router
from backend.api.routes.tracks import router as tracks_router
from backend.core.config import get_runtime_settings
from backend.db.session import SessionLocal, init_database, rollback_session
from backend.services.storage import apply_storage_retention
from backend.services.tracks import backfill_content_hashes, backfill_pipeline_run_deduplication

logger = logging.getLogger(__name__)
DESKTOP_TOKEN_HEADER = "x-stemstudio-desktop-token"


@asynccontextmanager
async def lifespan(_: FastAPI):
    runtime_settings = get_runtime_settings()
    runtime_settings.ensure_directories()
    init_database()
    with SessionLocal() as session:
        try:
            try:
                apply_storage_retention(session, runtime_settings)
            except (OSError, ValueError) as error:
                # Invalid local storage settings should not prevent the app from
                # starting; the settings screen can still be used to repair them.
                logger.warning("Skipped storage retention: %s", error)
            backfill_content_hashes(session)
            backfill_pipeline_run_deduplication(session)
        except Exception:
            rollback_session(session)
            raise
    yield


runtime_settings = get_runtime_settings()
app = FastAPI(
    title="StemStudio API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=runtime_settings.cors_allow_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_desktop_api_token(request: Request, call_next):
    if (
        request.method != "OPTIONS"
        and request.url.path.startswith("/api")
        and request.url.path != "/api/health"
    ):
        expected_token = runtime_settings.desktop_api_token
        if not expected_token:
            return JSONResponse(
                {"detail": "Desktop API token is not configured."},
                status_code=503,
            )
        if request.headers.get(DESKTOP_TOKEN_HEADER) != expected_token:
            return JSONResponse(
                {"detail": "Desktop API token is missing or invalid."},
                status_code=403,
            )

    return await call_next(request)


app.include_router(system_router, prefix="/api")
app.include_router(storage_router, prefix="/api")
app.include_router(settings_router, prefix="/api")
app.include_router(tracks_router, prefix="/api")
app.include_router(imports_router, prefix="/api")
app.include_router(exports_router, prefix="/api")
app.include_router(assets_router, prefix="/api")
