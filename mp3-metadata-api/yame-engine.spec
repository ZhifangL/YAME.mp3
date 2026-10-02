"""PyInstaller spec for the YAME engine sidecar.

Bundled into the Tauri app via `externalBin`. One file on purpose: Tauri's
sidecar mechanism copies a single executable, and a one-file build keeps the
bundle layout identical on macOS, Windows and Linux.

    pyinstaller yame-engine.spec --noconfirm    # from mp3-metadata-api/

The result lands in dist/yame-engine and is copied next to src-tauri by
scripts/build-sidecar.sh, which also appends the Rust target-triple suffix
Tauri requires.
"""
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

# uvicorn resolves its loop/protocol/lifespan implementations by string at
# runtime, so PyInstaller's static analysis cannot see them.
hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("anyio")
    + [
        "app",
        "app.api",
        "app.fields",
        "app.schemas",
        "app.routers.audio",
        "app.routers.filesystem",
        "app.services.audio_io",
        "app.services.fs_browser",
        "app.services.presets",
        "app.services.rules",
        # mutagen loads format modules by name as well.
        "mutagen.mp3",
        "mutagen.mp4",
        "mutagen.flac",
        "mutagen.oggvorbis",
        "mutagen.oggopus",
        "mutagen.wave",
        "mutagen.aiff",
        "mutagen.apev2",
        "mutagen.asf",
        "mutagen.id3",
    ]
)

a = Analysis(
    ["main.py"],
    pathex=[str(Path(".").resolve())],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # Trim the parts of the stdlib a headless JSON API never touches.
    excludes=[
        "tkinter", "unittest", "pydoc", "doctest", "test",
        "distutils", "setuptools", "pip", "wheel",
        "PIL", "numpy", "pandas", "matplotlib",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

# The app icon, shared with the desktop shell so the taskbar shows one product
# rather than a nameless console. Optional: a spec that fails to build because
# an icon is missing would be worse than an icon-less engine, and the icon lives
# in the frontend tree, which this build does not otherwise need.
_icon = Path("..") / "mp3-desktop-frontend" / "src-tauri" / "icons" / "icon.ico"
APP_ICON = str(_icon) if _icon.is_file() else None

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="yame-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    # Windowed, not a console application. A console build makes Windows open a
    # terminal window titled "yame-engine" on every launch — a second window and
    # a second taskbar entry for what is meant to be one app. The engine has no
    # user-facing output: it talks over loopback HTTP and writes diagnostics to
    # <config>/engine.log, so nothing is lost by having no console.
    console=False,
    icon=APP_ICON,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
