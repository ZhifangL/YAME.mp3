"""YAME engine entry point.

Run with (from this folder):
    .venv/bin/uvicorn main:app --port 8000
or directly:
    .venv/bin/python main.py

Port selection: YAME_PORT overrides the port. When the configured port
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
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

DEFAULT_PORT = 8000

_port: int | None = None
_log_path: "Path | None" = None


def _log(message: str) -> None:
    """Append a line to <config>/engine.log, and echo it on stdout.

    The packaged app runs without a console, so anything the engine prints is
    thrown away — which is why "Cannot reach the YAME engine" arrived with no
    explanation. This file is the engine's black box: it records the port, the
    parent PID, and a full traceback if startup fails, so a failure on a user's
    machine can be diagnosed from a file instead of a reproduction.
    """
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    print(line, flush=True)
    global _log_path
    try:
        if _log_path is None:
            from app.services.presets import config_dir

            _log_path = config_dir() / "engine.log"
        with open(_log_path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except Exception:  # noqa: BLE001 - logging must never break startup
        pass


def _port_is_free(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def _pick_port(default: int) -> int:
    env = os.environ.get("YAME_PORT")
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
    ``YAME_PORT`` when the port file must be authoritative.
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


def _parent_is_alive(parent_pid: int) -> bool:
    """True while the process that launched us still exists.

    Deliberately not ``os.kill(pid, 0)``: on POSIX that is a liveness probe, but
    on Windows ``os.kill`` calls ``OpenProcess(PROCESS_ALL_ACCESS)`` followed by
    ``TerminateProcess`` — so the "probe" would try to *kill YAME itself* every
    five seconds. Not a theoretical hazard either: it is the watchdog's whole
    loop.
    """
    if os.name == "nt":
        return _windows_parent_is_alive(parent_pid)
    try:
        os.kill(parent_pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        # Permission denied and friends mean the process is there but not ours.
        return True


def _windows_parent_is_alive(parent_pid: int) -> bool:
    """Ask Windows for the parent's exit code; STILL_ACTIVE means it is running.

    ``PROCESS_QUERY_LIMITED_INFORMATION`` is the least privilege that answers
    this question, so it succeeds on a process we could not otherwise open —
    which also means the check cannot terminate anything by accident.
    """
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]

    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, parent_pid)
    if not handle:
        # Could not open it: gone, or never ours to look at. Treat "gone" as
        # gone and let the next tick decide again — exiting on a transient
        # failure would kill the engine under a healthy app.
        return False
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _exit_with_parent(parent_pid: int) -> None:
    """Quit when the desktop shell that launched us goes away.

    The sidecar runs in its own process group so the app can signal all of it
    on a clean exit, but a crash or a force-quit never gets that far — the
    engine would linger and every later launch would start another one.
    """

    def watch() -> None:
        while True:
            time.sleep(5)
            if not _parent_is_alive(parent_pid):
                _log("parent process is gone; exiting")
                os._exit(0)

    threading.Thread(target=watch, name="parent-watchdog", daemon=True).start()


@asynccontextmanager
async def _lifespan(_app):
    port = engine_port()
    _publish_port(port)
    _log(
        f"engine started on 127.0.0.1:{port} "
        f"(python {sys.version.split()[0]}, pid {os.getpid()}, "
        f"parent {os.environ.get('YAME_PARENT_PID') or 'none'})"
    )
    parent = os.environ.get("YAME_PARENT_PID")
    if parent and parent.isdigit():
        _exit_with_parent(int(parent))
    yield
    _log("engine stopped")


def _run() -> None:
    """Start the server, recording any failure where it can be found later."""
    import uvicorn

    try:
        uvicorn.run(app, host="127.0.0.1", port=engine_port())
    except BaseException:
        # A frozen windowed app has no console, so an unhandled startup failure
        # is invisible from the outside: the window just says it cannot reach
        # the engine. Writing the traceback next to the log is the difference
        # between a diagnosable bug report and a guess.
        import traceback

        _log("engine failed to start:\n" + traceback.format_exc())
        raise


from app.api import create_app  # noqa: E402

app = create_app(lifespan=_lifespan)

if __name__ == "__main__":
    _run()
