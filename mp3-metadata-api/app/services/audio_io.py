"""Read + write audio metadata for every format mutagen understands.

Read support: MP3, M4A/AAC, FLAC, OGG/Opus/Vorbis, WAV, AIFF, WMA/ASF,
MusePack, Monkey's Audio, WavPack, TrueAudio - mutagen's full lineup.
Write support: ID3 formats (MP3/AIFF/WAV), MP4 atoms (M4A/AAC),
Vorbis comments (FLAC/OGG/Opus) and APEv2 (MPC/Monkey's/WavPack/TTA).
Other formats degrade gracefully with a warning.

One canonical value model: every field is a string, "" means absent.
"""
from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Optional

import mutagen
import mutagen.aiff
import mutagen.apev2
import mutagen.asf
import mutagen.flac
import mutagen.mp3
import mutagen.mp4
import mutagen.oggopus
import mutagen.oggvorbis
import mutagen.wave
from mutagen.id3 import APIC, COMM, Frames, ID3, USLT

from app.fields import FIELD_BY_KEY, FIELDS

ID3_ENCODING = 3  # UTF-8

AUDIO_SUFFIXES = {
    ".mp3", ".m4a", ".aac", ".mp4", ".flac", ".ogg", ".oga", ".opus",
    ".wav", ".wave", ".aiff", ".aif", ".wma", ".asf", ".mpc", ".ape",
    ".wv", ".tta", ".m4b",
}

MPEG_VERSION_NAMES = {1: "MPEG 1", 2: "MPEG 2", 2.5: "MPEG 2.5"}
MPEG_LAYER_NAMES = {1: "Layer I", 2: "Layer II", 3: "Layer III"}
MPEG_MODE_NAMES = {0: "Stereo", 1: "Joint stereo", 2: "Dual channel", 3: "Mono"}

MP4_CODEC_NAMES = {
    "mp4a.40.2": "AAC LC",
    "mp4a.40.5": "AAC HE",
    "mp4a.40.29": "AAC HEv2",
    "alac": "ALAC",
    "ac-3": "AC-3",
    "ec-3": "E-AC-3",
    "mp3": "MP3",
}

ASF_FIELD_KEYS = {
    "Title": "title",
    "Author": "artist",
    "WM/AlbumTitle": "album",
    "WM/AlbumArtist": "album_artist",
    "WM/Composer": "composer",
    "WM/Genre": "genre",
    "WM/Year": "date",
    "WM/TrackNumber": "track_number",
    "WM/PartOfSet": "disc_number",
    "Description": "comment",
    "WM/BeatsPerMinute": "bpm",
    "Copyright": "copyright",
    "WM/Publisher": "publisher",
    "WM/ISRC": "isrc",
}


class MetadataError(ValueError):
    """Raised for files that cannot be read as audio."""


# ------------------------------------------------------------------ adapters

class Id3Adapter:
    """ID3v2 tags (MP3 / AIFF / WAV)."""

    def __init__(self, id3: ID3):
        self.id3 = id3

    def get(self, field) -> str:
        if field.id3 is None:
            return ""
        frames = self.id3.getall(field.id3)
        if not frames:
            return ""
        kind = field.id3_kind
        if kind == "comment":
            for frame in frames:
                if isinstance(frame, COMM) and getattr(frame, "text", None):
                    return " / ".join(str(t) for t in frame.text)
            return ""
        if kind == "lyrics":
            for frame in frames:
                if isinstance(frame, USLT) and getattr(frame, "text", None):
                    return str(frame.text)
            return ""
        parts: list[str] = []
        for frame in frames:
            for value in getattr(frame, "text", None) or []:
                parts.append(str(value))
        return " / ".join(parts)

    def set(self, field, value: str) -> None:
        if field.id3 is None:
            return
        frame_id = field.id3
        self.id3.delall(frame_id)
        if not value:
            return
        kind = field.id3_kind or "text"
        if kind == "comment":
            self.id3.add(COMM(encoding=ID3_ENCODING, lang="eng", desc="", text=[value]))
            return
        if kind == "lyrics":
            self.id3.add(USLT(encoding=ID3_ENCODING, lang="eng", desc="", text=value))
            return
        cls = Frames.get(frame_id)
        if cls is None:
            return
        try:
            frame = cls(encoding=ID3_ENCODING, text=[value])
        except TypeError:
            return
        self.id3.add(frame)

    def frames(self) -> list[dict]:
        out: list[dict] = []
        for key, frame in self.id3.items():
            values: list[str] = []
            if isinstance(frame, APIC):
                values = [getattr(frame, "mime", "image") + " (cover)"]
            elif isinstance(frame, (COMM, USLT)):
                text = getattr(frame, "text", None)
                if isinstance(text, (list, tuple)):
                    values = [str(t) for t in text]
                elif text:
                    values = [str(text)]
            else:
                values = [str(t) for t in (getattr(frame, "text", None) or [])]
            out.append({"id": key, "description": "", "values": values})
        return out

    def cover(self) -> Optional[tuple[str, bytes]]:
        for frame in self.id3.getall("APIC"):
            data = getattr(frame, "data", None)
            if data:
                return getattr(frame, "mime", "image/jpeg") or "image/jpeg", bytes(data)
        return None

    def set_cover(self, mime: str, data: bytes) -> None:
        self.id3.delall("APIC")
        self.id3.add(APIC(encoding=0, mime=mime, type=3, desc="Cover", data=data))

    def remove_cover(self) -> None:
        self.id3.delall("APIC")


class Mp4Adapter:
    """MP4 atoms (M4A / AAC / M4B)."""

    def __init__(self, fileobj):
        self.mp4 = fileobj

    def _tags(self):
        if self.mp4.tags is None:
            self.mp4.add_tags()
        return self.mp4.tags

    def get(self, field) -> str:
        if field.mp4 is None or self.mp4.tags is None:
            return ""
        value = self.mp4.tags.get(field.mp4)
        if value is None:
            return ""
        if field.key in ("track_number", "disc_number"):
            if isinstance(value, (list, tuple)) and value:
                first = value[0]
                if isinstance(first, (tuple, list)) and first:
                    number = int(first[0])
                    total = int(first[1]) if len(first) > 1 and first[1] else 0
                    return str(number) if not total else str(number) + "/" + str(total)
                return str(first)
        if isinstance(value, (list, tuple)):
            return " / ".join(str(x) for x in value if x is not None)
        if isinstance(value, bytes):
            return value.decode("utf-8", "replace")
        return str(value)

    def set(self, field, value: str) -> None:
        if field.mp4 is None:
            return
        tags = self._tags()
        key = field.mp4
        if not value:
            tags.pop(key, None)
            return
        if field.key in ("track_number", "disc_number"):
            parts = value.split("/")
            number = int(parts[0]) if parts[0].strip().lstrip("-").isdigit() else 0
            total = 0
            if len(parts) > 1 and parts[1].strip().isdigit():
                total = int(parts[1])
            else:
                existing = tags.get(key)
                if isinstance(existing, (list, tuple)) and existing and \
                        isinstance(existing[0], (tuple, list)) and len(existing[0]) > 1:
                    total = int(existing[0][1] or 0)
            tags[key] = [(number, total)]
            return
        tags[key] = [value]

    def cover(self) -> Optional[tuple[str, bytes]]:
        if self.mp4.tags is None:
            return None
        covr = self.mp4.tags.get("covr")
        if not covr:
            return None
        cover = covr[0]
        image_format = getattr(cover, "imageformat", None)
        mime = "image/png" if image_format == mutagen.mp4.MP4Cover.FORMAT_PNG else "image/jpeg"
        return mime, bytes(cover)

    def set_cover(self, mime: str, data: bytes) -> None:
        tags = self._tags()
        image_format = mutagen.mp4.MP4Cover.FORMAT_PNG if mime == "image/png" else mutagen.mp4.MP4Cover.FORMAT_JPEG
        tags["covr"] = [mutagen.mp4.MP4Cover(data, imageformat=image_format)]

    def remove_cover(self) -> None:
        if self.mp4.tags is not None:
            self.mp4.tags.pop("covr", None)


class VorbisAdapter:
    """Vorbis comments (FLAC / OGG / Opus)."""

    def __init__(self, fileobj):
        self.fileobj = fileobj

    def get(self, field) -> str:
        if field.vorbis is None or self.fileobj.tags is None:
            return ""
        value = self.fileobj.tags.get(field.vorbis)
        if value is None:
            return ""
        if isinstance(value, (list, tuple)):
            return " / ".join(str(x) for x in value)
        return str(value)

    def set(self, field, value: str) -> None:
        if field.vorbis is None or self.fileobj.tags is None:
            return
        if not value:
            self.fileobj.tags.pop(field.vorbis, None)
        else:
            self.fileobj.tags[field.vorbis] = value

    def cover(self) -> Optional[tuple[str, bytes]]:
        if isinstance(self.fileobj, mutagen.flac.FLAC):
            for picture in getattr(self.fileobj, "pictures", None) or []:
                data = getattr(picture, "data", None)
                if data:
                    return getattr(picture, "mime", "image/jpeg") or "image/jpeg", bytes(data)
        return None

    def set_cover(self, mime: str, data: bytes) -> None:
        if not isinstance(self.fileobj, mutagen.flac.FLAC):
            return
        picture = mutagen.flac.Picture()
        picture.type = 3
        picture.mime = mime
        picture.desc = "Cover"
        picture.data = data
        self.fileobj.clear_pictures()
        self.fileobj.add_picture(picture)

    def remove_cover(self) -> None:
        if isinstance(self.fileobj, mutagen.flac.FLAC):
            self.fileobj.clear_pictures()


class ApeAdapter:
    """APEv2 tags (MusePack / Monkey's Audio / WavPack / TrueAudio)."""

    def __init__(self, ape):
        self.ape = ape

    def get(self, field) -> str:
        if field.ape is None:
            return ""
        item = self.ape.get(field.ape)
        if item is None:
            return ""
        value = item.value
        if isinstance(value, bytes):
            try:
                return value.decode("utf-8")
            except UnicodeDecodeError:
                return value.decode("latin-1", "replace")
        if isinstance(value, (list, tuple)):
            return " / ".join(str(x) for x in value)
        return str(value)

    def set(self, field, value: str) -> None:
        if field.ape is None:
            return
        if not value:
            self.ape.pop(field.ape, None)
        else:
            self.ape[field.ape] = value

    def cover(self) -> Optional[tuple[str, bytes]]:
        for key in ("Cover Art (Front)", "Cover Art (front)"):
            item = self.ape.get(key)
            if item is not None and isinstance(item.value, bytes):
                return "image/jpeg", item.value
        return None

    def set_cover(self, mime: str, data: bytes) -> None:
        self.ape["Cover Art (Front)"] = data

    def remove_cover(self) -> None:
        self.ape.pop("Cover Art (Front)", None)
        self.ape.pop("Cover Art (front)", None)


class AsfAdapter:
    """WMA/ASF - mutagen can read but not write these tags."""

    writable = False

    def __init__(self, fileobj):
        self.fileobj = fileobj

    def get(self, field) -> str:
        if self.fileobj.tags is None:
            return ""
        key = next((k for k, v in ASF_FIELD_KEYS.items() if v == field.key), None)
        if key is None:
            return ""
        value = self.fileobj.tags.get(key)
        if value is None:
            return ""
        if isinstance(value, (list, tuple)):
            return " / ".join(str(x) for x in value)
        return str(value)

    def set(self, field, value: str) -> None:
        return

    def cover(self) -> Optional[tuple[str, bytes]]:
        if self.fileobj.tags is None:
            return None
        pictures = self.fileobj.tags.get("WM/Picture")
        if not pictures:
            return None
        picture = pictures[0]
        try:
            mime = picture.mime
            data = bytes(picture.value)
        except Exception:
            return None
        if data:
            return mime or "image/jpeg", data
        return None

    def set_cover(self, mime: str, data: bytes) -> None:
        return


def _detect(fileobj) -> tuple[Optional[Any], Optional[str]]:
    """Return (adapter, save_kind) for a parsed mutagen file object.

    save_kind is one of "id3", "mp4", "vorbis", "ape", "asf" or None
    (read-only/unknown). The adapter may be None when no tags exist yet
    but the format is writable - callers create tags lazily via the
    per-format save path.
    """
    if isinstance(fileobj, (mutagen.mp3.MP3, mutagen.aiff.AIFF, mutagen.wave.WAVE)):
        tags = getattr(fileobj, "tags", None)
        if not isinstance(tags, ID3):
            # AIFF/WAV: create the tag container lazily and attach it to the
            # file object so save() persists it.
            try:
                if hasattr(fileobj, "add_tags"):
                    fileobj.add_tags()
                tags = fileobj.tags
            except Exception:
                tags = None
        if isinstance(tags, ID3):
            return Id3Adapter(tags), "id3"
        # Last resort: read a detached ID3 header (read-only view).
        try:
            id3 = ID3(str(fileobj.filename))
        except Exception:
            id3 = None
        if id3 is not None:
            return Id3Adapter(id3), "id3"
        return None, "id3"
    if isinstance(fileobj, mutagen.mp4.MP4):
        return Mp4Adapter(fileobj), "mp4"
    if isinstance(fileobj, (mutagen.flac.FLAC, mutagen.oggvorbis.OggVorbis, mutagen.oggopus.OggOpus)):
        return VorbisAdapter(fileobj), "vorbis"
    if isinstance(fileobj, mutagen.apev2.APEv2File):
        tags = getattr(fileobj, "tags", None)
        if tags is not None:
            return ApeAdapter(tags), "ape"
        try:
            ape = mutagen.apev2.APEv2(str(fileobj.filename))
        except Exception:
            ape = None
        if ape is not None:
            return ApeAdapter(ape), "ape"
        return None, "ape"
    if isinstance(fileobj, mutagen.asf.ASF):
        return AsfAdapter(fileobj), "asf"
    return None, None


def _save_file(fileobj, save_kind: Optional[str]) -> None:
    """Persist tag changes with format-appropriate options."""
    if save_kind == "id3":
        if isinstance(fileobj, mutagen.mp3.MP3):
            # v1=0: never write ID3v1; v2_version=3: keep broadly compatible ID3v2.3
            fileobj.save(v1=0, v2_version=3)
        else:
            fileobj.save()
    elif save_kind == "mp4":
        fileobj.save()
    elif save_kind == "vorbis":
        fileobj.save()
    elif save_kind == "ape":
        fileobj.save()
    elif save_kind == "asf":
        raise MetadataError("This format (WMA/ASF) is read-only in mutagen.")


# ------------------------------------------------------------------ audio info

def _audio_info(fileobj, warnings: list[str]) -> dict:
    info = getattr(fileobj, "info", None)
    if info is None:
        return {}
    out: dict[str, Any] = {
        "duration_seconds": None,
        "bitrate_kbps": None,
        "sample_rate_hz": None,
        "channels": None,
        "codec": None,
        "codec_detail": None,
        "mode": None,
        "bitrate_mode": None,
    }
    try:
        length = getattr(info, "length", None)
        out["duration_seconds"] = round(float(length), 2) if length else None
    except Exception:
        out["duration_seconds"] = None
    try:
        bitrate = getattr(info, "bitrate", None)
        out["bitrate_kbps"] = int(bitrate // 1000) if bitrate else None
    except Exception:
        out["bitrate_kbps"] = None
    out["sample_rate_hz"] = getattr(info, "sample_rate", None)
    out["channels"] = getattr(info, "channels", None)

    if isinstance(fileobj, mutagen.mp3.MP3):
        out["codec"] = "MP3"
        version = MPEG_VERSION_NAMES.get(getattr(info, "version", None))
        layer = MPEG_LAYER_NAMES.get(getattr(info, "layer", None))
        out["codec_detail"] = " ".join(x for x in [version, layer] if x) or None
        out["mode"] = MPEG_MODE_NAMES.get(getattr(info, "mode", None))
        try:
            bitrate_mode = getattr(info, "bitrate_mode", None)
            out["bitrate_mode"] = str(bitrate_mode).rsplit(".", 1)[-1] if bitrate_mode is not None else None
        except Exception:
            out["bitrate_mode"] = None
        if getattr(info, "sketchy", False):
            warnings.append("The audio stream looks malformed/incomplete; some values may be estimates.")
    elif isinstance(fileobj, mutagen.mp4.MP4):
        codec = getattr(info, "codec", None) or ""
        out["codec"] = MP4_CODEC_NAMES.get(codec, codec.upper() or None)
        out["codec_detail"] = None
    elif isinstance(fileobj, mutagen.flac.FLAC):
        out["codec"] = "FLAC"
        out["codec_detail"] = str(getattr(info, "bits_per_sample", "") or "") + "-bit" or None
    elif isinstance(fileobj, mutagen.oggvorbis.OggVorbis):
        out["codec"] = "Vorbis"
    elif isinstance(fileobj, mutagen.oggopus.OggOpus):
        out["codec"] = "Opus"
    elif isinstance(fileobj, mutagen.wave.WAVE):
        out["codec"] = "WAV"
        out["codec_detail"] = "PCM" if getattr(info, "bits_per_sample", None) else None
    elif isinstance(fileobj, mutagen.aiff.AIFF):
        out["codec"] = "AIFF"
    elif isinstance(fileobj, mutagen.apev2.APEv2File):
        kind = fileobj.__class__.__name__
        out["codec"] = {"Musepack": "Musepack", "MonkeysAudio": "Monkey's Audio",
                        "WavPack": "WavPack", "TrueAudio": "True Audio"}.get(kind, kind)
    elif isinstance(fileobj, mutagen.asf.ASF):
        out["codec"] = "WMA"
    return out


# ------------------------------------------------------------------ public API

def read_track(path: str) -> dict:
    """Read stream info + tags + cover for one audio file.

    Raises:
        FileNotFoundError: path does not exist or is not a file.
        MetadataError: the file cannot be parsed as audio.
    """
    file_path = Path(path).expanduser()
    if not file_path.exists():
        raise FileNotFoundError("File does not exist: " + str(file_path))
    if not file_path.is_dir() is False and not file_path.is_file():
        raise FileNotFoundError("Not a file: " + str(file_path))

    warnings: list[str] = []
    try:
        fileobj = mutagen.File(str(file_path))
    except Exception as exc:
        raise MetadataError("Could not parse audio stream: " + str(exc)) from exc
    if fileobj is None:
        raise MetadataError(file_path.name + " is not a readable audio file.")

    adapter, save_kind = _detect(fileobj)
    fields: dict[str, str] = {}
    for field in FIELDS:
        value = adapter.get(field) if adapter is not None else ""
        fields[field.key] = value

    frames: list[dict] = []
    if isinstance(adapter, Id3Adapter):
        frames = adapter.frames()

    cover_info: Optional[dict] = None
    if adapter is not None:
        cover = adapter.cover()
        if cover:
            mime, data = cover
            cover_info = {"mime": mime, "data_base64": base64.b64encode(data).decode("ascii")}

    stat = file_path.stat()
    created = getattr(stat, "st_birthtime", None) or stat.st_ctime
    return {
        "file": {
            "path": str(file_path),
            "filename": file_path.name,
            "size_bytes": int(stat.st_size),
            "modified_unix": float(stat.st_mtime),
            "created_unix": float(created),
        },
        "audio": _audio_info(fileobj, warnings),
        "fields": fields,
        "frames": frames,
        "cover": cover_info,
        "writable": save_kind in ("id3", "mp4", "vorbis", "ape"),
        "warnings": warnings,
    }


def write_fields(path: str, fields: dict[str, str], rename_to: Optional[str] = None) -> list[str]:
    """Write canonical field values to one file; "" deletes the tag.

    Unknown keys are ignored. "rename_to", when given and different from the
    current name, renames the file on disk (extension is kept when the new
    name has none). Returns a list of warnings.
    """
    file_path = Path(path).expanduser()
    warnings: list[str] = []

    try:
        fileobj = mutagen.File(str(file_path))
    except Exception as exc:
        raise MetadataError("Could not parse audio stream: " + str(exc)) from exc
    if fileobj is None:
        raise MetadataError(file_path.name + " is not a readable audio file.")

    adapter, save_kind = _detect(fileobj)
    if save_kind not in ("id3", "mp4", "vorbis", "ape"):
        warnings.append("Format is read-only; tags were not written.")

    if adapter is not None:
        for key, value in (fields or {}).items():
            field = FIELD_BY_KEY.get(key)
            if field is None:
                continue
            try:
                adapter.set(field, value or "")
            except Exception as exc:
                warnings.append("Could not write " + field.label + ": " + str(exc))

    if save_kind in ("id3", "mp4", "vorbis", "ape") and fields:
        try:
            _save_file(fileobj, save_kind)
        except Exception as exc:
            warnings.append("Could not save tags: " + str(exc))

    if rename_to and rename_to != file_path.name:
        new_name = rename_to.strip()
        if not new_name:
            warnings.append("Refusing to rename to an empty file name.")
        else:
            if "." not in new_name:
                new_name += file_path.suffix
            target = file_path.parent / new_name
            if target.exists() and target != file_path:
                warnings.append("Rename skipped: " + new_name + " already exists.")
            else:
                try:
                    file_path.rename(target)
                except OSError as exc:
                    warnings.append("Rename failed: " + str(exc))

    return warnings


def write_cover(path: str, mime: str, data_base64: str) -> list[str]:
    """Replace the embedded cover art of one file."""
    try:
        data = base64.b64decode(data_base64)
    except Exception as exc:
        raise MetadataError("Cover data is not valid base64: " + str(exc)) from exc
    if len(data) > 10 * 1024 * 1024:
        raise MetadataError("Cover image is larger than 10 MB.")

    file_path = Path(path).expanduser()
    fileobj = mutagen.File(str(file_path))
    if fileobj is None:
        raise MetadataError(file_path.name + " is not a readable audio file.")
    adapter, save_kind = _detect(fileobj)
    warnings: list[str] = []
    if adapter is None or not hasattr(adapter, "set_cover"):
        warnings.append("Format is read-only; cover was not written.")
        return warnings
    try:
        adapter.set_cover(mime, data)
        _save_file(fileobj, save_kind)
    except Exception as exc:
        warnings.append("Could not save cover: " + str(exc))
    return warnings


def remove_cover(path: str) -> list[str]:
    """Delete the embedded cover art of one file."""
    file_path = Path(path).expanduser()
    fileobj = mutagen.File(str(file_path))
    if fileobj is None:
        raise MetadataError(file_path.name + " is not a readable audio file.")
    adapter, save_kind = _detect(fileobj)
    warnings: list[str] = []
    if adapter is None or not hasattr(adapter, "remove_cover"):
        warnings.append("Format is read-only; cover was not removed.")
        return warnings
    try:
        adapter.remove_cover()
        _save_file(fileobj, save_kind)
    except Exception as exc:
        warnings.append("Could not remove cover: " + str(exc))
    return warnings


def apply_ruleset(paths: list[str], ruleset: dict, dry_run: bool) -> dict:
    """Run a ruleset over many files. dry_run=True only computes changes."""
    from app.services.rules import RuleContext, run_ruleset

    results: list[dict] = []
    for path in paths:
        try:
            md = read_track(path)
        except (FileNotFoundError, MetadataError) as exc:
            results.append({
                "path": path, "filename": Path(path).name, "error": str(exc),
                "changes": [], "warnings": [], "written": False,
            })
            continue

        filename = md["file"]["filename"]
        parent_dir = str(Path(path).parent)
        rule_fields = dict(md["fields"])
        rule_fields["__has_cover__"] = "1" if md.get("cover") else ""
        ctx = RuleContext(fields=rule_fields, filename=filename, parent_dir=parent_dir, path=path)
        final_fields, _rule_changes = run_ruleset(ctx, ruleset.get("rules") or [])

        changes: list[dict] = []
        for key, value in final_fields.items():
            if key.startswith("__"):
                continue
            before = md["fields"].get(key) or ""
            if before != value:
                changes.append({
                    "field": key,
                    "label": FIELD_BY_KEY[key].label if key in FIELD_BY_KEY else key,
                    "before": before,
                    "after": value,
                })
        # Cover art changes ride along as special change records.
        cover_changes = [c for c in _rule_changes if c.get("field") == "__cover__"]
        if cover_changes:
            changes.extend({k: v for k, v in c.items() if k in ("field", "label", "before", "after")} for c in cover_changes)
        new_filename = ctx.filename
        rename = new_filename != filename
        if rename:
            changes.append({
                "field": "filename",
                "label": "File Name",
                "before": filename,
                "after": new_filename,
            })

        warnings: list[str] = []
        written = False
        if not dry_run and (changes or rename):
            try:
                write_changes = {
                    change["field"]: change["after"]
                    for change in changes
                    if change["field"] in FIELD_BY_KEY
                }
                if write_changes:
                    warnings.extend(write_fields(path, write_changes, rename_to=new_filename if rename else None))
                elif rename:
                    warnings.extend(write_fields(path, {}, rename_to=new_filename))
                cover_action = next((c for c in _rule_changes if c.get("field") == "__cover__"), None)
                if cover_action:
                    if cover_action.get("after") == "remove":
                        warnings.extend(remove_cover(path))
                    else:
                        warnings.extend(write_cover(path, cover_action.get("_mime") or "image/jpeg", cover_action.get("_data_base64") or ""))
                written = True
            except (MetadataError, OSError) as exc:
                warnings.append(str(exc))

        results.append({
            "path": path,
            "filename": filename,
            "new_filename": new_filename,
            "changes": changes,
            "warnings": warnings,
            "written": written,
        })

    changed = len([r for r in results if r["changes"]])
    return {
        "results": results,
        "total_files": len(paths),
        "changed_files": changed,
        "dry_run": bool(dry_run),
    }
