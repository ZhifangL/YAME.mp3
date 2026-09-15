"""Metadata + rules + presets endpoints.

The frontend talks to this router over localhost. In the final Tauri
package this same FastAPI app runs as the Python sidecar.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from app.fields import RULE_FIELDS
from app.schemas import (
    ApplyRequest,
    ApplyResponse,
    CoverWriteRequest,
    FilesResolveRequest,
    FilesResolveResponse,
    FolderResolveRequest,
    FolderResolveResponse,
    MetadataResponse,
    PresetImportRequest,
    PresetModel,
    PresetUpsertRequest,
    PreviewBatchRequest,
    PreviewRequest,
    PreviewResponse,
    RegistryResponse,
    TrackWriteRequest,
    TrackWriteResponse,
    TracksReadRequest,
    TracksReadResponse,
)
from app.services.audio_io import (
    AUDIO_SUFFIXES,
    MetadataError,
    apply_ruleset,
    read_track,
    remove_cover,
    write_cover,
    write_fields,
)
from app.services.fs_browser import resolve_files, resolve_folder
from app.services.presets import delete_preset, list_presets, save_preset
from app.services.rules import REGISTRY, RuleContext, registry_specs

router = APIRouter(tags=["audio"])


@router.get("/api/rules/registry", response_model=RegistryResponse, tags=["rules"])
def rules_registry():
    """Self-describing rule catalog + field catalog for the rule editors."""
    return {
        "specs": registry_specs(),
        "fields": RULE_FIELDS,
        # So the UI's drop handling recognises exactly the formats the engine
        # does, instead of keeping its own copy of the list.
        "audio_suffixes": sorted(AUDIO_SUFFIXES),
    }


@router.get(
    "/api/metadata",
    response_model=MetadataResponse,
    summary="Read metadata of one audio file",
)
def get_metadata(
    path: str = Query(..., description="Absolute path of the audio file to read."),
):
    try:
        return read_track(path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except MetadataError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post(
    "/api/tracks/read",
    response_model=TracksReadResponse,
    summary="Read metadata of many audio files at once",
)
def read_tracks(request: TracksReadRequest):
    """Read many files; unreadable ones are reported in ``errors``, not fatal."""
    tracks = []
    errors = []
    for path in request.paths:
        try:
            tracks.append(read_track(path))
        except (FileNotFoundError, MetadataError) as exc:
            errors.append({"path": path, "error": str(exc)})
    return {"tracks": tracks, "errors": errors}


@router.post(
    "/api/tracks/write",
    response_model=TrackWriteResponse,
    summary="Write metadata fields of one audio file",
)
def write_track(request: TrackWriteRequest):
    try:
        outcome = write_fields(request.path, request.fields, rename_to=request.rename_to)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except MetadataError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"track": _read_or_none(outcome.path), "warnings": outcome.warnings}


def _read_or_none(path: str):
    """Read a file back for the response; a failure here is not an error."""
    try:
        return read_track(path)
    except (FileNotFoundError, MetadataError):
        return None


@router.post(
    "/api/tracks/cover",
    response_model=TrackWriteResponse,
    summary="Replace the embedded cover art of one audio file",
)
def set_cover(request: CoverWriteRequest):
    try:
        if request.remove:
            warnings = remove_cover(request.path)
        else:
            warnings = write_cover(request.path, request.mime, request.data_base64)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except MetadataError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"track": _read_or_none(request.path), "warnings": warnings}


@router.post(
    "/api/preview",
    response_model=PreviewResponse,
    summary="Dry-run one rule against given field values (never touches files)",
)
def preview(request: PreviewRequest):
    return _run_preview(request.filename, request.folder, request.fields, request.cover, request.rule)


@router.post(
    "/api/preview-batch",
    response_model=PreviewResponse,
    summary="Dry-run one rule against several tracks; returns the first that changes",
)
def preview_batch(request: PreviewBatchRequest):
    """Used by the rule builder: when many tracks are selected, the preview
    should show the change on the first track that actually matches instead
    of the first selected track (which may not change at all)."""
    for index, candidate in enumerate(request.candidates):
        result = _run_preview(
            candidate.filename, candidate.folder, candidate.fields, candidate.cover, request.rule
        )
        if result["changes"]:
            result["matched_index"] = index
            return result
    # Nothing matched: report the first candidate's context, unchanged.
    if request.candidates:
        candidate = request.candidates[0]
        result = _run_preview(
            candidate.filename, candidate.folder, candidate.fields, candidate.cover, request.rule
        )
        result["matched_index"] = None
        return result
    return {"changes": [], "fields": {}, "filename": "", "matched_index": None}


def _run_preview(filename: str, folder: str, fields: dict, cover, rule):
    cls = REGISTRY.get(rule.type)
    if cls is None:
        raise HTTPException(status_code=400, detail="Unknown rule type: " + rule.type)
    ctx_fields = dict(fields or {})
    ctx_fields["__has_cover__"] = "1" if cover and cover.data_base64 else ""
    ctx_fields["__cover_data__"] = cover.data_base64 if cover and cover.data_base64 else ""
    ctx = RuleContext(
        fields=ctx_fields,
        filename=filename,
        parent_dir=folder,
        path=(folder.rstrip("/") + "/" + filename) if folder else filename,
    )
    changes = cls().apply(ctx, rule.params or {})
    out_fields = {**fields, **{c["field"]: c["after"] for c in changes if not c["field"].startswith("__")}}
    return {"changes": changes, "fields": out_fields, "filename": ctx.filename}


@router.post(
    "/api/apply",
    response_model=ApplyResponse,
    summary="Run a ruleset over many files (dry_run computes changes only)",
)
def apply(request: ApplyRequest):
    if not request.paths:
        raise HTTPException(status_code=400, detail="No files selected.")
    if not request.ruleset.rules:
        raise HTTPException(status_code=400, detail="The ruleset has no rules.")
    return apply_ruleset(
        request.paths,
        {"name": request.ruleset.name, "rules": [r.model_dump() for r in request.ruleset.rules]},
        dry_run=request.dry_run,
    )


@router.post(
    "/api/resolve-folder",
    response_model=FolderResolveResponse,
    summary="Resolve a natively picked folder (name + relative entries) to an absolute path",
)
def resolve_picked_folder(request: FolderResolveRequest):
    path = resolve_folder(request.name, request.entries, previous_path=request.previous_path)
    return {"path": path}


@router.post(
    "/api/resolve-files",
    response_model=FilesResolveResponse,
    summary="Resolve individually picked files (exact names) to absolute paths",
)
def resolve_picked_files(request: FilesResolveRequest):
    paths = resolve_files(request.names, previous_path=request.previous_path)
    return {"paths": paths}


@router.get("/api/presets", response_model=list[PresetModel], tags=["presets"])
def presets():
    return list_presets()


@router.put("/api/presets", response_model=PresetModel, tags=["presets"])
def upsert_preset(request: PresetUpsertRequest):
    return save_preset(request.name, request.ruleset.model_dump(), preset_id=request.preset_id)


@router.delete("/api/presets/{preset_id}", tags=["presets"])
def remove_preset(preset_id: str):
    if not delete_preset(preset_id):
        raise HTTPException(status_code=404, detail="Preset not found.")
    return {"deleted": preset_id}


@router.post("/api/presets/import", response_model=list[PresetModel], tags=["presets"])
def import_presets(request: PresetImportRequest):
    """Import presets from an exported TagForge presets file."""
    imported = []
    for entry in request.presets:
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        ruleset = entry.get("ruleset") or {"name": entry.get("name"), "rules": []}
        imported.append(save_preset(str(entry["name"]), ruleset, preset_id=entry.get("id")))
    return imported
