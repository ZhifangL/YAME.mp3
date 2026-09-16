"""Named ruleset presets, persisted as JSON in the app config directory.

Storage: $YAME_CONFIG_DIR/presets.json (default ~/.config/yame/).
Set YAME_CONFIG_DIR to relocate it — the packaged build uses the default.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

# FastAPI runs these sync handlers in a thread pool, so two requests can
# interleave a read-modify-write on the same file.
_lock = threading.RLock()

# The app shipped as "TagForge" before the rebrand; presets live there for
# anyone upgrading from that build.
LEGACY_CONFIG_DIR_NAME = "tagforge"

_migrated = False


def _adopt_legacy_presets(base: Path) -> None:
    """Copy presets saved under the old app name into *base*, once.

    Non-destructive: the old file is left in place, and an existing store in
    the new location always wins.
    """
    global _migrated
    if _migrated:
        return
    _migrated = True

    legacy = Path.home() / ".config" / LEGACY_CONFIG_DIR_NAME
    old_store = legacy / "presets.json"
    new_store = base / "presets.json"
    if legacy == base or not old_store.is_file() or new_store.exists():
        return
    try:
        shutil.copy2(old_store, new_store)
    except OSError:
        pass  # a failed migration must never stop the engine from starting


def config_dir() -> Path:
    env = os.environ.get("YAME_CONFIG_DIR") or os.environ.get("TAGFORGE_CONFIG_DIR")
    base = Path(env).expanduser() if env else Path.home() / ".config" / "yame"
    base.mkdir(parents=True, exist_ok=True)
    if not env:
        _adopt_legacy_presets(base)
    return base


def _store_path() -> Path:
    return config_dir() / "presets.json"


def _load() -> dict:
    path = _store_path()
    if not path.exists():
        return {"version": 1, "presets": []}
    try:
        data = json.loads(path.read_text("utf-8"))
        if isinstance(data, dict) and isinstance(data.get("presets"), list):
            return data
    except (OSError, ValueError):
        pass
    return {"version": 1, "presets": []}


def _save(data: dict) -> None:
    path = _store_path()
    # A per-writer temp name: a shared one lets two concurrent saves race, and
    # the loser's replace() fails because the winner already moved the file.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def normalise_ruleset(raw: Any, fallback_name: str = "Untitled ruleset") -> dict:
    """Coerce an untrusted ruleset into the stored shape.

    Everything reaching here may come from a file the user was handed. A
    malformed value used to be written verbatim, after which every subsequent
    GET /api/presets failed response validation — the preset list could never
    load again, so the bad entry could not even be deleted from the UI.
    """
    if not isinstance(raw, dict):
        return {"name": fallback_name, "rules": []}

    rules: list[dict] = []
    raw_rules = raw.get("rules")
    if isinstance(raw_rules, list):
        for rule in raw_rules:
            if not isinstance(rule, dict):
                continue
            rule_type = rule.get("type")
            if not isinstance(rule_type, str) or not rule_type:
                continue
            params = rule.get("params")
            rules.append({
                "type": rule_type,
                "params": params if isinstance(params, dict) else {},
                "enabled": rule.get("enabled") is not False,
            })

    name = raw.get("name")
    return {"name": name if isinstance(name, str) and name else fallback_name, "rules": rules}


def _sanitise(preset: Any) -> Optional[dict]:
    """Make one stored entry safe to serve, or drop it."""
    if not isinstance(preset, dict):
        return None
    name = preset.get("name")
    if not isinstance(name, str) or not name:
        return None
    preset_id = preset.get("id")
    updated = preset.get("updated_unix")
    return {
        "id": preset_id if isinstance(preset_id, str) and preset_id else uuid.uuid4().hex[:12],
        "name": name,
        "ruleset": normalise_ruleset(preset.get("ruleset"), name),
        "updated_unix": float(updated) if isinstance(updated, (int, float)) else 0.0,
    }


def list_presets() -> list[dict]:
    with _lock:
        entries = _load()["presets"]
    # Tolerate a file written by an older build rather than failing the whole
    # list on one bad entry.
    return [clean for clean in (_sanitise(p) for p in entries) if clean is not None]


def get_preset(preset_id: str) -> Optional[dict]:
    for preset in list_presets():
        if preset.get("id") == preset_id:
            return preset
    return None


def save_preset(name: str, ruleset: dict, preset_id: Optional[str] = None) -> dict:
    """Create a new preset, or update the one with preset_id."""
    ruleset = normalise_ruleset(ruleset, name)
    with _lock:
        return _save_preset_locked(name, ruleset, preset_id)


def _save_preset_locked(name: str, ruleset: dict, preset_id: Optional[str]) -> dict:
    data = _load()
    now = time.time()
    if preset_id:
        for preset in data["presets"]:
            if preset.get("id") == preset_id:
                preset["name"] = name
                preset["ruleset"] = ruleset
                preset["updated_unix"] = now
                _save(data)
                return preset
        # id given but unknown: fall through and create with that id
    preset = {
        "id": preset_id or uuid.uuid4().hex[:12],
        "name": name,
        "ruleset": ruleset,
        "updated_unix": now,
    }
    data["presets"].append(preset)
    _save(data)
    return preset


def delete_preset(preset_id: str) -> bool:
    with _lock:
        data = _load()
        before = len(data["presets"])
        data["presets"] = [p for p in data["presets"] if p.get("id") != preset_id]
        if len(data["presets"]) == before:
            return False
        _save(data)
        return True
