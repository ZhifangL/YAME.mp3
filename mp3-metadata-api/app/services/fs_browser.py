"""Local filesystem browsing: navigate folders and find audio files.

In the final Tauri app the native "open file" dialog will live in the Rust
layer, but a path-based browser endpoint keeps the React UI fully testable
in a plain browser during development (the API runs on the same machine).
"""
from __future__ import annotations

import os
from pathlib import Path

from app.services.audio_io import AUDIO_SUFFIXES


_SKIP_DIR_NAMES = {"node_modules", "__pycache__", ".git"}

# Bounds so a drop of "/" or a huge tree cannot hang the request.
_MAX_DIRS = 5000
_MAX_FILES = 20000


def _iter_audio_files(base: Path, *, include_hidden: bool = False,
                      max_dirs: int = _MAX_DIRS, max_files: int = _MAX_FILES):
    """Yield audio files in *base*'s tree, depth-first, folders alphabetically.

    Shared by recursive browsing and by drop expansion so both agree on what
    counts as an audio file and which folders are skipped.
    """
    stack: list[Path] = [base]
    seen_dirs = 0
    found = 0
    while stack:
        current = stack.pop()
        seen_dirs += 1
        if seen_dirs > max_dirs or found >= max_files:
            return
        try:
            children = sorted(current.iterdir(), key=lambda entry: entry.name.casefold())
        except OSError:
            continue
        # Push directories in reverse so the LIFO stack pops them alphabetically.
        subdirs: list[Path] = []
        for entry in children:
            if entry.name.startswith(".") and not include_hidden:
                continue
            try:
                if entry.is_dir():
                    if entry.name not in _SKIP_DIR_NAMES:
                        subdirs.append(entry)
                elif entry.is_file() and entry.suffix.lower() in AUDIO_SUFFIXES:
                    found += 1
                    if found > max_files:
                        return
                    yield entry
            except OSError:
                # Broken symlink / vanishing entry - skip it silently.
                continue
        stack.extend(reversed(subdirs))


def expand_paths(paths: list[str], *, include_hidden: bool = False) -> dict:
    """Flatten a mixed selection of files and folders into audio file paths.

    Finder and Explorer hand over whatever the user dragged, so a single drop
    can contain audio files, folders, and things that are neither. Folders are
    walked recursively; loose files are kept only when they look like audio;
    everything else is reported in ``skipped`` so the UI can say what it left
    out instead of silently ignoring it.
    """
    files: list[str] = []
    skipped: list[str] = []
    seen: set[str] = set()

    for raw in paths or []:
        if not raw:
            continue
        candidate = Path(raw).expanduser()
        try:
            if candidate.is_dir():
                for entry in _iter_audio_files(candidate, include_hidden=include_hidden):
                    key = str(entry)
                    if key not in seen:
                        seen.add(key)
                        files.append(key)
            elif candidate.is_file() and candidate.suffix.lower() in AUDIO_SUFFIXES:
                key = str(candidate)
                if key not in seen:
                    seen.add(key)
                    files.append(key)
            else:
                skipped.append(str(candidate))
        except OSError:
            skipped.append(str(candidate))

    return {"files": files, "skipped": skipped, "truncated": len(files) >= _MAX_FILES}


def list_directory(path: str | None = None, *, include_hidden: bool = False, recursive: bool = False) -> dict:
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

    if recursive:
        # Gather every audio file in the tree below *base* (bounded depth,
        # hidden/system directories skipped).
        for entry in _iter_audio_files(base, include_hidden=include_hidden):
            try:
                stat = entry.stat()
            except OSError:
                continue
            audio_files.append(
                {
                    "name": entry.name,
                    "path": str(entry),
                    "size_bytes": int(stat.st_size),
                    "modified_unix": float(stat.st_mtime),
                }
            )
    else:
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


# ---------------------------------------------------------------------------
# Dev-mode native folder picker support
#
# A browser cannot read the absolute path of a folder the user picked with
# the OS dialog (privacy), but it does get the relative paths. This search
# resolves the folder name + relative entry list to an absolute path on the
# local machine. The packaged Tauri app skips this entirely and passes the
# absolute path straight from the native dialog plugin.
# ---------------------------------------------------------------------------
_PRUNED_DIR_NAMES = {
    "Library", ".git", "node_modules", ".venv", "__pycache__",
    "Applications", "System", "private", "dev", "usr", "bin", "sbin",
    "opt", "etc", "var", "Volumes", ".Trash", "cores",
}

_SEARCH_ROOTS: list[Path] = []


def _search_roots() -> list[Path]:
    if _SEARCH_ROOTS:
        return _SEARCH_ROOTS
    home = Path.home()
    roots = [home]
    for name in ("Music", "Downloads", "Documents", "Desktop", "Movies", "Pictures", "Public"):
        candidate = home / name
        if candidate.is_dir():
            roots.append(candidate)
    # Mounted volumes: /Volumes on macOS, /media and /mnt on Linux. Windows has
    # drive letters instead, so each drive is searched from its root — the
    # resolver below is dev-only, but a Windows developer should still find
    # their music without setting YAME_CONFIG_DIR by hand.
    for mount in ("/Volumes", "/media", "/mnt"):
        volumes = Path(mount)
        if volumes.is_dir():
            try:
                roots.extend(p for p in volumes.iterdir() if p.is_dir())
            except OSError:
                pass
    users = Path("/Users")
    if users.is_dir():
        roots.append(users)
    if os.name == "nt":
        for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
            drive = Path(f"{letter}:\\")
            if drive.is_dir():
                roots.append(drive)
    _SEARCH_ROOTS.extend(roots)
    return roots


def _walk_dirs(roots: list[Path], max_dirs: int = 40000, max_depth: int = 6):
    """Depth-first walk over *roots*, yielding (dir_path, depth).

    Prunes hidden and system directories to keep the search fast. Depth is
    relative to each root.
    """
    visited = 0
    for root in roots:
        if not root.is_dir():
            continue
        stack = [(root, 0)]
        while stack:
            current, depth = stack.pop()
            visited += 1
            if visited > max_dirs:
                return
            yield current, depth
            if current.name.startswith(".") or current.name in _PRUNED_DIR_NAMES:
                continue
            if depth >= max_depth:
                continue
            try:
                children = list(current.iterdir())
            except OSError:
                continue
            for child in children:
                try:
                    if child.is_dir() and not child.is_symlink():
                        stack.append((child, depth + 1))
                except OSError:
                    continue


def resolve_folder(name: str, entries: list[str], previous_path: str | None = None) -> str | None:
    """Find an absolute path for a folder picked via the native dialog.

    The browser reports relative paths that start with the picked folder's
    name ("MyFolder/sub/file.mp3"), so that leading segment is stripped
    before matching against each candidate directory.
    """
    if not name:
        return None
    wanted: list[str] = []
    for entry in entries:
        rel = entry.replace("\\", "/")
        parts = rel.split("/")
        if parts and parts[0] == name:
            parts = parts[1:]
        if parts:
            wanted.append("/".join(parts))

    def matches(base: Path) -> bool:
        # Signature check: every reported entry must exist under the folder.
        return all((base / rel).exists() for rel in wanted)

    roots: list[Path] = []
    if previous_path:
        prev = Path(previous_path).expanduser()
        roots.append(prev.parent if prev.is_file() else prev)
    roots.extend(_search_roots())
    for candidate, _depth in _walk_dirs(roots):
        if candidate.name == name and matches(candidate):
            return str(candidate)
    return None


def resolve_files(names: list[str], previous_path: str | None = None) -> list[str]:
    """Find absolute paths for individually picked files by exact file name.

    Dev-mode only (browsers hide absolute paths from file inputs); the
    packaged Tauri app gets paths straight from the native dialog.
    Returns one path per wanted name (or fewer when a name is not found).
    """
    wanted = [n for n in (names or []) if n and "/" not in n]
    if not wanted:
        return []
    remaining = {name.casefold(): name for name in wanted}
    found: dict[str, str] = {}

    roots: list[Path] = []
    if previous_path:
        prev = Path(previous_path).expanduser()
        roots.append(prev.parent if prev.is_file() else prev)
    roots.extend(_search_roots())

    for directory, _depth in _walk_dirs(roots):
        try:
            entries = list(directory.iterdir())
        except OSError:
            continue
        for entry in entries:
            try:
                if not entry.is_file():
                    continue
            except OSError:
                continue
            key = entry.name.casefold()
            if key in remaining:
                found[remaining.pop(key)] = str(entry)
                if not remaining:
                    return [found[name] for name in wanted if name in found]
    return [found[name] for name in wanted if name in found]
