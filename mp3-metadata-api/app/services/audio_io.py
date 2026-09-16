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
from dataclasses import dataclass, field
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

from app.fields import FIELD_BY_KEY, FIELDS, field_label

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


@dataclass
class WriteOutcome:
    """Where a write left the file, plus anything the user should know.

    ``path`` is the file's location *after* the write, so callers never have
    to guess whether a rename was applied or refused.
    """

    path: str
    warnings: list[str] = field(default_factory=list)
    renamed: bool = False
    #: True when the tag write reached disk (or nothing needed writing).
    saved: bool = False


def _load(path: Path):
    """Parse *path* with mutagen, translating its errors into ours.

    mutagen raises ``MutagenError`` (a plain ``Exception``) for missing and
    unreadable files alike; callers need a ``FileNotFoundError``/``MetadataError``
    split so the API can answer 404 vs 422, and so a single bad file can never
    escape as a 500 in the middle of a batch.
    """
    if not path.exists():
        raise FileNotFoundError("File does not exist: " + str(path))
    if not path.is_file():
        raise FileNotFoundError("Not a file: " + str(path))
    try:
        fileobj = mutagen.File(str(path))
    except Exception as exc:
        raise MetadataError("Could not parse audio stream: " + str(exc)) from exc
    if fileobj is None:
        raise MetadataError(path.name + " is not a readable audio file.")
    return fileobj


def _target_name(file_path: Path, requested: str) -> str:
    """File name to use for a requested rename, preserving a usable extension.

    Two rules keep the file reachable:

    * the extension never changes format. Renaming an MP3 to ".flac" does not
      convert it — it just makes the file unreadable to this app and to most
      players, so the real extension wins;
    * a name that merely *contains* a dot ("Mr. Brightside") keeps the original
      extension rather than being written with none at all and then vanishing
      from folder listings.
    """
    name = requested.strip().rstrip(".")
    if not name:
        return file_path.name

    requested_suffix = Path(name).suffix
    if requested_suffix.lower() in AUDIO_SUFFIXES:
        if requested_suffix.lower() == file_path.suffix.lower():
            return name
        # A different audio extension: drop it and keep the file's own.
        return name[: -len(requested_suffix)] + file_path.suffix
    return name + file_path.suffix


def _is_same_file(a: Path, b: Path) -> bool:
    """True when two differently-spelled paths are the same file on disk.

    macOS and Windows are case-insensitive, so "ONE.MP3" and "one.mp3" are one
    file; without this a case-only rename looked like a collision and was
    silently refused.
    """
    try:
        return a.samefile(b)
    except OSError:
        return False


def _unsafe_name_reason(name: str) -> Optional[str]:
    """Why *name* may not be used as a file name, or None when it is fine.

    Tag values routinely contain "/" (think "AC/DC"), and a rule that copies
    one into the File Name field must never move the file out of its folder.
    """
    if not name or name in (".", ".."):
        return "it is not a valid file name"
    if "/" in name or "\\" in name or "\0" in name:
        return "file names cannot contain path separators"
    return None


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
        # The user's own frame is the one with no description. iTunes and other
        # taggers park data in *described* COMM frames (iTunNORM, iTunSMPB) and
        # in per-language USLT frames; those are not the Comment field.
        if kind == "comment":
            for frame in frames:
                if (isinstance(frame, COMM) and not getattr(frame, "desc", "")
                        and getattr(frame, "text", None)):
                    return " / ".join(str(t) for t in frame.text)
            return ""
        if kind == "lyrics":
            for frame in frames:
                if (isinstance(frame, USLT) and not getattr(frame, "desc", "")
                        and getattr(frame, "text", None)):
                    return str(frame.text)
            return ""
        parts: list[str] = []
        for frame in frames:
            for value in getattr(frame, "text", None) or []:
                parts.append(str(value))
        return " / ".join(parts)

    def _drop_plain_frames(self, frame_id: str) -> None:
        """Delete only the undescribed frames of this type — ours, not theirs.

        A blanket `delall("COMM")` also throws away iTunNORM/iTunSMPB, which
        hold gapless-playback and normalisation data that cannot be recovered.
        """
        for key in list(self.id3.keys()):
            if key != frame_id and not key.startswith(frame_id + ":"):
                continue
            frame = self.id3.get(key)
            if frame is not None and not getattr(frame, "desc", ""):
                del self.id3[key]

    def set(self, field, value: str) -> None:
        if field.id3 is None:
            return
        frame_id = field.id3
        kind = field.id3_kind or "text"
        if kind in ("comment", "lyrics"):
            self._drop_plain_frames(frame_id)
            if not value:
                return
            if kind == "comment":
                self.id3.add(COMM(encoding=ID3_ENCODING, lang="eng", desc="", text=[value]))
            else:
                self.id3.add(USLT(encoding=ID3_ENCODING, lang="eng", desc="", text=value))
            return
        self.id3.delall(frame_id)
        if not value:
            return
        cls = Frames.get(frame_id)
        if cls is None:
            return
        try:
            frame = cls(encoding=ID3_ENCODING, text=[value])
        except TypeError:
            return
        self.id3.add(frame)

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

    def _tags(self):
        """The comment block, created on demand.

        A FLAC or Ogg stream can legitimately carry no VORBIS_COMMENT block;
        without this the write silently did nothing while still reporting
        success. ID3 and MP4 already create their containers lazily.
        """
        if self.fileobj.tags is None:
            try:
                self.fileobj.add_tags()
            except Exception:
                return None
        return self.fileobj.tags

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
        if field.vorbis is None:
            return
        tags = self._tags()
        if tags is None:
            return
        if not value:
            tags.pop(field.vorbis, None)
        else:
            tags[field.vorbis] = value

    def cover(self) -> Optional[tuple[str, bytes]]:
        if isinstance(self.fileobj, mutagen.flac.FLAC):
            for picture in getattr(self.fileobj, "pictures", None) or []:
                data = getattr(picture, "data", None)
                if data:
                    return getattr(picture, "mime", "image/jpeg") or "image/jpeg", bytes(data)
            return None
        # OGG / Opus: cover art travels as a FLAC-picture block base64-encoded
        # in a Vorbis comment (standard "METADATA_BLOCK_PICTURE", with the
        # legacy "coverart" key as a fallback).
        if self.fileobj.tags is None:
            return None
        for key in ("metadata_block_picture", "coverart"):
            value = self.fileobj.tags.get(key)
            if not value:
                continue
            encoded = str(value[0]) if isinstance(value, (list, tuple)) else str(value)
            try:
                raw = __import__("base64").b64decode(encoded)
            except Exception:
                continue
            if key == "metadata_block_picture":
                try:
                    picture = mutagen.flac.Picture(raw)
                    return getattr(picture, "mime", "image/jpeg") or "image/jpeg", bytes(picture.data)
                except Exception:
                    continue
            return "image/jpeg", raw
        return None

    def set_cover(self, mime: str, data: bytes) -> None:
        if isinstance(self.fileobj, mutagen.flac.FLAC):
            picture = mutagen.flac.Picture()
            picture.type = 3
            picture.mime = mime
            picture.desc = "Cover"
            picture.data = data
            self.fileobj.clear_pictures()
            self.fileobj.add_picture(picture)
            return
        # OGG / Opus: write the FLAC-picture block into a Vorbis comment.
        tags = self._tags()
        if tags is None:
            return
        picture = mutagen.flac.Picture()
        picture.type = 3
        picture.mime = mime
        picture.desc = "Cover"
        picture.data = data
        import base64 as _b64

        tags["metadata_block_picture"] = [_b64.b64encode(picture.write()).decode("ascii")]

    def remove_cover(self) -> None:
        if isinstance(self.fileobj, mutagen.flac.FLAC):
            self.fileobj.clear_pictures()
            return
        if self.fileobj.tags is None:
            return
        for key in ("metadata_block_picture", "coverart"):
            if key in self.fileobj.tags:
                del self.fileobj.tags[key]


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
    """WMA/ASF - mutagen can read but not write these tags.

    Read-only-ness is decided by ``_detect``'s save_kind, not by a flag here,
    because the no-op mutators below make ``hasattr`` checks lie.
    """

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
        bits = getattr(info, "bits_per_sample", None)
        out["codec_detail"] = f"{bits}-bit" if bits else None
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
    warnings: list[str] = []
    fileobj = _load(file_path)

    adapter, save_kind = _detect(fileobj)
    fields: dict[str, str] = {}
    for f in FIELDS:
        fields[f.key] = adapter.get(f) if adapter is not None else ""

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
        "cover": cover_info,
        "writable": save_kind in ("id3", "mp4", "vorbis", "ape"),
        "warnings": warnings,
    }


def write_fields(path: str, fields: dict[str, str], rename_to: Optional[str] = None) -> WriteOutcome:
    """Write canonical field values to one file; "" deletes the tag.

    Unknown keys are ignored. "rename_to", when given and different from the
    current name, renames the file on disk. A name that already carries a known
    audio extension is used verbatim; otherwise the original extension is kept,
    so "Mr. Brightside" becomes "Mr. Brightside.mp3" rather than an extensionless
    file that folder listings would no longer find.

    Returns a WriteOutcome whose ``path`` is where the file actually ended up --
    a refused rename (target already exists, empty name, OS error) leaves it at
    the original path with a warning, and the caller gets no wrong answers.
    """
    file_path = Path(path).expanduser()
    warnings: list[str] = []
    fileobj = _load(file_path)

    adapter, save_kind = _detect(fileobj)
    if fields and save_kind not in ("id3", "mp4", "vorbis", "ape"):
        warnings.append("Format is read-only; tags were not written.")

    if adapter is not None:
        for key, value in (fields or {}).items():
            f = FIELD_BY_KEY.get(key)
            if f is None:
                continue
            try:
                adapter.set(f, value or "")
            except Exception as exc:
                warnings.append("Could not write " + f.label + ": " + str(exc))

    saved = True
    if save_kind not in ("id3", "mp4", "vorbis", "ape"):
        saved = False
    elif fields:
        try:
            _save_file(fileobj, save_kind)
        except Exception as exc:
            warnings.append("Could not save tags: " + str(exc))
            saved = False

    final_path = file_path
    if rename_to and rename_to.strip() != file_path.name:
        requested = rename_to.strip()
        new_name = _target_name(file_path, requested)
        reason = _unsafe_name_reason(new_name)
        target = file_path.parent / new_name
        requested_suffix = Path(requested).suffix.lower()
        if requested_suffix in AUDIO_SUFFIXES and requested_suffix != file_path.suffix.lower():
            warnings.append(
                "Kept the original extension (" + file_path.suffix +
                "); renaming does not convert formats."
            )
        if reason is not None:
            warnings.append("Rename skipped: " + reason + ".")
        elif target.exists() and target != file_path and not _is_same_file(target, file_path):
            warnings.append("Rename skipped: " + new_name + " already exists.")
        else:
            try:
                file_path.rename(target)
                final_path = target
            except OSError as exc:
                warnings.append("Rename failed: " + str(exc))

    return WriteOutcome(
        path=str(final_path),
        warnings=warnings,
        renamed=final_path != file_path,
        saved=saved,
    )


def write_cover(path: str, mime: str, data_base64: str) -> list[str]:
    """Replace the embedded cover art of one file."""
    try:
        data = base64.b64decode(data_base64)
    except Exception as exc:
        raise MetadataError("Cover data is not valid base64: " + str(exc)) from exc
    if len(data) > 10 * 1024 * 1024:
        raise MetadataError("Cover image is larger than 10 MB.")

    file_path = Path(path).expanduser()
    fileobj = _load(file_path)
    adapter, save_kind = _detect(fileobj)
    warnings: list[str] = []
    if adapter is None or save_kind not in ("id3", "mp4", "vorbis", "ape"):
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
    fileobj = _load(file_path)
    adapter, save_kind = _detect(fileobj)
    warnings: list[str] = []
    if adapter is None or save_kind not in ("id3", "mp4", "vorbis", "ape"):
        warnings.append("Format is read-only; cover was not removed.")
        return warnings
    try:
        adapter.remove_cover()
        _save_file(fileobj, save_kind)
    except Exception as exc:
        warnings.append("Could not remove cover: " + str(exc))
    return warnings


# Cover images that arrive as a path on disk (a Finder drop or the native file
# picker) rather than as base64 from a browser file input.
_IMAGE_MIMES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}


def image_mime_for(path: Path) -> Optional[str]:
    """MIME type for an image file, or None when the extension is not one."""
    return _IMAGE_MIMES.get(path.suffix.lower())


def write_cover_from_file(path: str, image_path: str) -> list[str]:
    """Embed an image that is already on disk as the cover of one audio file.

    Saves the client a base64 round-trip and lets a dropped Finder file be used
    directly as artwork.

    Raises:
        FileNotFoundError: the audio file or the image is missing.
        MetadataError: the image is not a supported type or is too large.
    """
    image = Path(image_path).expanduser()
    if not image.exists() or not image.is_file():
        raise FileNotFoundError("Cover image does not exist: " + str(image))
    mime = image_mime_for(image)
    if mime is None:
        raise MetadataError(
            "Unsupported cover image type: " + (image.suffix or "(none)") +
            ". Use PNG, JPEG, WebP, GIF, BMP or TIFF."
        )
    try:
        size = image.stat().st_size
    except OSError as exc:
        raise MetadataError("Could not read the cover image: " + str(exc)) from exc
    # Check before reading: a huge TIFF should never be loaded just to be
    # rejected by write_cover's limit.
    if size > 10 * 1024 * 1024:
        raise MetadataError("Cover image is larger than 10 MB.")
    try:
        data = base64.b64encode(image.read_bytes()).decode("ascii")
    except OSError as exc:
        raise MetadataError("Could not read the cover image: " + str(exc)) from exc
    return write_cover(path, mime, data)


def apply_ruleset(paths: list[str], ruleset: dict, dry_run: bool) -> dict:
    """Run a ruleset over many files. dry_run=True only computes changes."""
    results: list[dict] = []
    for path in paths:
        try:
            results.append(_apply_to_file(path, ruleset, dry_run))
        except Exception as exc:  # noqa: BLE001 - one bad file must not sink the batch
            results.append({
                "path": path, "filename": Path(path).name, "error": str(exc),
                "changes": [], "warnings": [], "written": False,
            })

    changed = len([r for r in results if r["changes"]])
    return {
        "results": results,
        "total_files": len(paths),
        "changed_files": changed,
        "dry_run": bool(dry_run),
    }


def _apply_to_file(path: str, ruleset: dict, dry_run: bool) -> dict:
    """Compute (and unless dry_run, perform) one file's changes."""
    from app.services.rules import RuleContext, run_ruleset

    md = read_track(path)
    filename = md["file"]["filename"]
    parent_dir = str(Path(path).parent)
    rule_fields = dict(md["fields"])
    original_cover = md.get("cover")
    original_data = (original_cover or {}).get("data_base64", "") or ""
    original_mime = (original_cover or {}).get("mime") or "image/jpeg"
    rule_fields["__has_cover__"] = "1" if original_data else ""
    rule_fields["__cover_data__"] = original_data
    rule_fields["__cover_mime__"] = original_mime
    ctx = RuleContext(fields=rule_fields, filename=filename, parent_dir=parent_dir, path=path)
    final_fields, _changes = run_ruleset(ctx, ruleset.get("rules") or [])

    changes: list[dict] = []
    for key, value in final_fields.items():
        if key.startswith("__"):
            continue
        before = md["fields"].get(key) or ""
        if before != value:
            changes.append({
                "field": key,
                "label": field_label(key),
                "before": before,
                "after": value,
            })
    # Cover art composes sequentially inside the ruleset: report one
    # change record reflecting the NET effect of all cover rules.
    final_data = ctx.cover_state.get("data") or ""
    final_mime = ctx.cover_state.get("mime") or "image/jpeg"
    final_name = ctx.cover_state.get("name") or ""
    if final_data != original_data:
        if final_data:
            changes.append({
                "field": "__cover__",
                "label": "Cover Art",
                "before": "artwork present" if original_data else "no artwork",
                "after": final_name or (final_mime.split("/")[-1] + " image"),
                "_mime": final_mime,
                "_data_base64": final_data,
            })
        else:
            changes.append({
                "field": "__cover__",
                "label": "Cover Art",
                "before": "artwork present" if original_data else "no artwork",
                "after": "remove",
            })
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
    # Where the file lives now: the real path once a write has happened, or
    # the name the rules would produce while still previewing.
    final_filename = new_filename
    cover_action = next((c for c in changes if c.get("field") == "__cover__"), None)
    if not dry_run and (changes or rename):
        write_changes = {
            change["field"]: change["after"]
            for change in changes
            if change["field"] in FIELD_BY_KEY
        }
        # Field writes and the rename happen together, so the cover must be
        # applied to wherever the file ended up -- not to the original path,
        # which may no longer exist once the rename has gone through.
        target_path = path
        saved = True
        if write_changes or rename:
            outcome = write_fields(path, write_changes, rename_to=new_filename if rename else None)
            warnings.extend(outcome.warnings)
            target_path = outcome.path
            # A read-only format or a failed save must not be reported as a
            # successful write, or the UI says "applied" for a no-op.
            saved = outcome.saved
            # A refused rename (name taken, OS error) leaves the file put:
            # report the name it actually has so the UI never moves the row.
            final_filename = Path(outcome.path).name
        if cover_action:
            if cover_action.get("after") == "remove":
                warnings.extend(remove_cover(target_path))
            else:
                cover_warnings = write_cover(
                    target_path,
                    cover_action.get("_mime") or "image/jpeg",
                    cover_action.get("_data_base64") or "",
                )
                warnings.extend(cover_warnings)
                if cover_warnings:
                    saved = False
        written = saved

    return {
        "path": path,
        "filename": filename,
        "new_filename": final_filename,
        "error": None,
        "changes": changes,
        "warnings": warnings,
        "written": written,
    }

