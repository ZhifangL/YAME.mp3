"""Named ruleset presets, persisted as JSON in the app config directory.

Storage: $TAGFORGE_CONFIG_DIR/presets.json (default ~/.config/tagforge/).
The bundled Tauri build will point TAGFORGE_CONFIG_DIR at the per-user
app-support folder; the format stays the same.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Optional


def config_dir() -> Path:
    env = os.environ.get("TAGFORGE_CONFIG_DIR")
    base = Path(env).expanduser() if env else Path.home() / ".config" / "tagforge"
    base.mkdir(parents=True, exist_ok=True)
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
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")
    tmp.replace(path)


def list_presets() -> list[dict]:
    return _load()["presets"]


def get_preset(preset_id: str) -> Optional[dict]:
    for preset in list_presets():
        if preset.get("id") == preset_id:
            return preset
    return None


def save_preset(name: str, ruleset: dict, preset_id: Optional[str] = None) -> dict:
    """Create a new preset, or update the one with preset_id."""
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
    data = _load()
    before = len(data["presets"])
    data["presets"] = [p for p in data["presets"] if p.get("id") != preset_id]
    if len(data["presets"]) == before:
        return False
    _save(data)
    return True
