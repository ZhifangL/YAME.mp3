"""Pydantic request/response models shared by the API routers."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


# ------------------------------------------------------------------ filesystem

class FolderEntry(BaseModel):
    name: str
    path: str


class FileEntry(BaseModel):
    name: str
    path: str
    size_bytes: int
    modified_unix: float


class BrowseResponse(BaseModel):
    path: str
    parent: Optional[str] = None
    folders: list[FolderEntry] = []
    audio_files: list[FileEntry] = []


# ------------------------------------------------------------------ metadata

class FileInfo(BaseModel):
    path: str
    filename: str
    size_bytes: int
    modified_unix: float
    created_unix: Optional[float] = None


class AudioInfo(BaseModel):
    duration_seconds: Optional[float] = None
    bitrate_kbps: Optional[int] = None
    sample_rate_hz: Optional[int] = None
    channels: Optional[int] = None
    codec: Optional[str] = None
    codec_detail: Optional[str] = None
    mode: Optional[str] = None
    bitrate_mode: Optional[str] = None


class TagFrame(BaseModel):
    id: str
    description: str = ""
    values: list[str] = []


class CoverInfo(BaseModel):
    mime: str
    data_base64: str


class MetadataResponse(BaseModel):
    file: FileInfo
    audio: AudioInfo = AudioInfo()
    fields: dict[str, str] = {}
    frames: list[TagFrame] = []
    cover: Optional[CoverInfo] = None
    writable: bool = True
    warnings: list[str] = []


# ------------------------------------------------------------------ rules

class RuleParamSpec(BaseModel):
    name: str
    label: str
    kind: str  # field | text | choice | bool | separator | parse_pattern | parse_assignments
    choices: list[dict] = []
    default: Any = None
    placeholder: Optional[str] = None
    help: Optional[str] = None


class RuleSpec(BaseModel):
    type: str
    label: str
    description: str
    params: list[RuleParamSpec] = []


class RegistryResponse(BaseModel):
    specs: list[RuleSpec] = []
    fields: list[dict] = []  # {key, label, kind, pseudo, writable}


class RuleInstance(BaseModel):
    type: str
    params: dict[str, Any] = {}
    enabled: bool = True


class Ruleset(BaseModel):
    name: str = "Untitled ruleset"
    rules: list[RuleInstance] = []


class ChangeRecord(BaseModel):
    field: str
    label: str
    before: str = ""
    after: str = ""
    rule_type: Optional[str] = None
    rule_label: Optional[str] = None


class PreviewRequest(BaseModel):
    filename: str
    folder: str = ""
    fields: dict[str, str] = {}
    cover: Optional[CoverInfo] = None
    rule: RuleInstance

class PreviewCandidate(BaseModel):
    filename: str
    folder: str = ""
    fields: dict[str, str] = {}
    cover: Optional[CoverInfo] = None

class PreviewBatchRequest(BaseModel):
    candidates: list[PreviewCandidate] = []
    rule: RuleInstance


class PreviewResponse(BaseModel):
    changes: list[ChangeRecord] = []
    fields: dict[str, str] = {}
    filename: str = ""
    matched_index: Optional[int] = None


class FolderResolveRequest(BaseModel):
    name: str
    entries: list[str] = []
    previous_path: Optional[str] = None


class FolderResolveResponse(BaseModel):
    path: Optional[str] = None


class FilesResolveRequest(BaseModel):
    names: list[str] = []
    previous_path: Optional[str] = None


class FilesResolveResponse(BaseModel):
    paths: list[str] = []


class TracksReadRequest(BaseModel):
    paths: list[str] = []


class TracksReadResponse(BaseModel):
    tracks: list[MetadataResponse] = []


class TrackWriteRequest(BaseModel):
    path: str
    fields: dict[str, str] = {}
    rename_to: Optional[str] = None


class TrackWriteResponse(BaseModel):
    track: Optional[MetadataResponse] = None
    warnings: list[str] = []


class CoverWriteRequest(BaseModel):
    path: str
    mime: str = "image/jpeg"
    data_base64: str = ""
    remove: bool = False


class PresetImportRequest(BaseModel):
    presets: list[dict] = []  # each: {id?, name, ruleset} (export file format)


class ApplyRequest(BaseModel):
    paths: list[str] = []
    ruleset: Ruleset
    dry_run: bool = False


class ApplyFileResult(BaseModel):
    path: str
    filename: str
    new_filename: str = ""
    error: Optional[str] = None
    changes: list[ChangeRecord] = []
    warnings: list[str] = []
    written: bool = False


class ApplyResponse(BaseModel):
    results: list[ApplyFileResult] = []
    total_files: int = 0
    changed_files: int = 0
    dry_run: bool = False


# ------------------------------------------------------------------ presets

class PresetModel(BaseModel):
    id: str
    name: str
    ruleset: Ruleset
    updated_unix: float


class PresetUpsertRequest(BaseModel):
    name: str
    ruleset: Ruleset
    preset_id: Optional[str] = None
