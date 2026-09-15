"""TagForge engine entry point.

Run with (from this folder):
    .venv/bin/uvicorn main:app --port 8000
or directly:
    .venv/bin/python main.py

Port selection: TAGFORGE_PORT overrides the port. When the configured port
(8000 by default) is already in use, the engine falls back to an ephemeral
free port. The actual port is always written to <config>/engine.port and
printed as "ENGINE_PORT=<n>" so the frontend (Vite dev proxy now, the Tauri
sidecar launcher later) can find the engine without hard-coding a port.

Publishing happens when the server *starts* (see ``_lifespan``), not when this
module is imported, so importing ``main`` or ``app.api`` in a test no longer
writes to the user's config directory.
"""
from __future__ import annotations

import os
import socket
from contextlib import asynccontextmanager

DEFAULT_PORT = 8000

_port: int | None = None


def _port_is_free(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def _pick_port(default: int) -> int:
    env = os.environ.get("TAGFORGE_PORT")
    if env:
        return int(env)
    if _port_is_free(default):
        return default
    # Fall back to an ephemeral port.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])
    except OSError:
        return default


def engine_port() -> int:
    """The port this process will serve on (chosen once, then cached).

    Note: when the engine is started as ``uvicorn main:app --port N`` the CLI
    port wins and this value can disagree; use ``python main.py`` or
    ``TAGFORGE_PORT`` when the port file must be authoritative.
    """
    global _port
    if _port is None:
        _port = _pick_port(DEFAULT_PORT)
    return _port


def _publish_port(port: int) -> None:
    """Announce the port on stdout and in <config>/engine.port."""
    from app.services.presets import config_dir

    (config_dir() / "engine.port").write_text(str(port), "utf-8")
    print("ENGINE_PORT=" + str(port), flush=True)


@asynccontextmanager
async def _lifespan(_app):
    _publish_port(engine_port())
    yield


from app.api import create_app  # noqa: E402

app = create_app(lifespan=_lifespan)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=engine_port())
