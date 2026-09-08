"""Local filesystem browsing: navigate folders and find audio files.

In the final Tauri app the native "open file" dialog will live in the Rust
layer, but a path-based browser endpoint keeps the React UI fully testable
in a plain browser during development (the API runs on the same machine).
"""
from __future__ import annotations

from pathlib import Path

from app.services.audio_io import AUDIO_SUFFIXES


def list_directory(path: str | None = None, *, include_hidden: bool = False) -> dict:
    """List sub-folders and audio files inside *path* (default: home folder).

    Returns:
        {"path", "parent", "folders": [{name, path}],
         "audio_files": [{name, path, size_bytes, modified_unix}]}

    Raises:
        FileNotFoundError: folder does not exist.
        NotADirectoryError: path exists but is not a folder.
        PermissionError: folder cannot be read.
    """
    base = Path(path).expanduser() if path else Path.home()
    if not base.exists():
        raise FileNotFoundError("Folder does not exist: " + str(base))
    if not base.is_dir():
        raise NotADirectoryError("Not a folder: " + str(base))

    try:
        entries = list(base.iterdir())
    except PermissionError as exc:
        raise PermissionError("No permission to read folder: " + str(base)) from exc

    folders: list[dict] = []
    audio_files: list[dict] = []
    entries.sort(key=lambda entry: entry.name.casefold())

    for entry in entries:
        if entry.name.startswith(".") and not include_hidden:
            continue
        try:
            if entry.is_dir():
                folders.append({"name": entry.name, "path": str(entry)})
            elif entry.is_file() and entry.suffix.lower() in AUDIO_SUFFIXES:
                stat = entry.stat()
                audio_files.append(
                    {
                        "name": entry.name,
                        "path": str(entry),
                        "size_bytes": int(stat.st_size),
                        "modified_unix": float(stat.st_mtime),
                    }
                )
        except OSError:
            # Broken symlink / vanishing entry - skip it silently.
            continue

    parent = str(base.parent) if base.parent != base else None
    return {
        "path": str(base),
        "parent": parent,
        "folders": folders,
        "audio_files": audio_files,
    }
