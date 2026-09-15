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
"""
from __future__ import annotations

import os
import socket
import sys


def _pick_port(default: int) -> int:
    env = os.environ.get("TAGFORGE_PORT")
    if env:
        return int(env)

    def free(port: int) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False

    if free(default):
        return default
    # Fall back to an ephemeral port.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])
    except OSError:
        return default


def _publish_port(port: int) -> None:
    from app.services.presets import config_dir

    port_file = config_dir() / "engine.port"
    port_file.write_text(str(port), "utf-8")
    print("ENGINE_PORT=" + str(port), flush=True)


PORT = _pick_port(8000)
_publish_port(PORT)

from app.api import create_app  # noqa: E402

app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT)
