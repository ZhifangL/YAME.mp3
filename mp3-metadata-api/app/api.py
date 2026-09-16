"""FastAPI application factory for the YAME metadata engine."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.routers import audio, filesystem
from app.services.presets import config_dir

API_TITLE = "YAME Engine"
API_VERSION = "1.0.0"

# The app shell's own origins. Tauri serves the webview from a custom scheme,
# and the Vite dev server from localhost.
APP_ORIGINS = {
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}


def _is_foreign_web_origin(origin: str) -> bool:
    """True for a browser page that is not part of the app.

    The engine is an unauthenticated local HTTP service that can rewrite and
    rename files anywhere the user can write. Without this, any web page the
    user happens to have open could POST to /api/apply and edit their library.

    Deliberately narrow: requests with no Origin (curl, the sidecar's own
    health checks) and non-web schemes (the Tauri custom scheme, opaque "null"
    origins) are left alone, so this can never lock the real app out.
    """
    if not origin or origin in APP_ORIGINS:
        return False
    return origin.startswith(("http://", "https://"))


def create_app(lifespan=None) -> FastAPI:
    app = FastAPI(
        title=API_TITLE,
        version=API_VERSION,
        description=(
            "Local metadata engine for the YAME desktop app "
            "(React frontend talks to it over localhost; in the packaged "
            "Tauri build it runs as a Python sidecar)."
        ),
        lifespan=lifespan,
    )

    # Dev-mode CORS: the Vite dev server (e.g. http://localhost:5173) and the
    # Tauri webview (tauri://localhost) both call this API. The API is meant
    # to run bound to 127.0.0.1 only, so a permissive origin list is fine.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Added last, so it sits OUTSIDE the CORS layer and runs first: a foreign
    # page's preflight is refused before CORS can answer it.
    @app.middleware("http")
    async def _block_foreign_web_origins(request: Request, call_next):
        origin = request.headers.get("origin", "")
        if _is_foreign_web_origin(origin):
            return JSONResponse({"detail": "Origin not allowed."}, status_code=403)
        return await call_next(request)

    app.include_router(filesystem.router)
    app.include_router(audio.router)

    @app.get("/", include_in_schema=False)
    async def root() -> dict:
        return {
            "app": API_TITLE,
            "version": API_VERSION,
            "docs": "/docs",
            "endpoints": {
                "browse": "GET /api/browse?path=<folder>",
                "metadata": "GET /api/metadata?path=<file>",
                "read_many": "POST /api/tracks/read {paths: []}",
                "write": "POST /api/tracks/write {path, fields, rename_to?}",
                "cover": "POST /api/tracks/cover {path, mime, data_base64}",
                "cover_from_file": "POST /api/tracks/cover-from-file {path, image_path}",
                "rules_registry": "GET /api/rules/registry",
                "preview": "POST /api/preview {filename, folder, fields, rule}",
                "preview_batch": "POST /api/preview-batch {candidates, rule}",
                "apply": "POST /api/apply {paths, ruleset, dry_run}",
                "expand_paths": "POST /api/paths/expand {paths}",
                "presets": "GET /api/presets | PUT /api/presets | DELETE /api/presets/{id}",
            },
        }

    @app.get("/api/health", tags=["system"])
    async def health() -> dict:
        """Liveness + the paths the UI should not have to guess at.

        ``config_dir`` is where presets and the port file live; the UI shows
        it to the user, and the packaged build points it at the per-user
        app-support folder via YAME_CONFIG_DIR.
        """
        return {
            "status": "ok",
            "version": API_VERSION,
            "config_dir": str(config_dir()),
        }

    return app
