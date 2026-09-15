"""FastAPI application factory for the TagForge metadata engine."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import audio, filesystem
from app.services.presets import config_dir

API_TITLE = "TagForge Engine"
API_VERSION = "0.2.0"


def create_app(lifespan=None) -> FastAPI:
    app = FastAPI(
        title=API_TITLE,
        version=API_VERSION,
        description=(
            "Local metadata engine for the TagForge desktop app "
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
                "rules_registry": "GET /api/rules/registry",
                "preview": "POST /api/preview {filename, folder, fields, rule}",
                "apply": "POST /api/apply {paths, ruleset, dry_run}",
                "presets": "GET /api/presets | PUT /api/presets | DELETE /api/presets/{id}",
            },
        }

    @app.get("/api/health", tags=["system"])
    async def health() -> dict:
        """Liveness + the paths the UI should not have to guess at.

        ``config_dir`` is where presets and the port file live; the UI shows
        it to the user, and the packaged build points it at the per-user
        app-support folder via TAGFORGE_CONFIG_DIR.
        """
        return {
            "status": "ok",
            "version": API_VERSION,
            "config_dir": str(config_dir()),
        }

    return app
