"""Canonical metadata field catalog.

One field id per concept, mapped to the native tag keys of each supported
format. Rules operate on canonical ids, so a ruleset written against an MP3
applies unchanged to an M4A, FLAC, OGG or WAV file.

Pseudo-fields (filename, stem, ...) are readable in every rule but only
"filename" is writable (it renames the file on disk).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    kind: str = "text"               # "text" | "number"
    id3: Optional[str] = None        # ID3 frame id (mp3 / aiff / wav)
    id3_kind: Optional[str] = None   # "text" | "comment" | "lyrics"
    mp4: Optional[str] = None        # MP4 atom key (m4a / aac)
    vorbis: Optional[str] = None     # Vorbis comment key (flac / ogg / opus)
    ape: Optional[str] = None        # APEv2 key (mpc / wv / tta)

    @property
    def writable(self) -> bool:
        return any([self.id3, self.mp4, self.vorbis, self.ape])


FIELDS: list[Field] = [
    Field("title", "Title", id3="TIT2", mp4="\xa9nam", vorbis="title", ape="Title"),
    Field("artist", "Artist", id3="TPE1", mp4="\xa9ART", vorbis="artist", ape="Artist"),
    Field("album", "Album", id3="TALB", mp4="\xa9alb", vorbis="album", ape="Album"),
    Field("album_artist", "Album Artist", id3="TPE2", mp4="aART", vorbis="albumartist", ape="Album Artist"),
    Field("composer", "Composer", id3="TCOM", mp4="\xa9wrt", vorbis="composer", ape="Composer"),
    Field("genre", "Genre", id3="TCON", mp4="\xa9gen", vorbis="genre", ape="Genre"),
    Field("date", "Year", id3="TDRC", mp4="\xa9day", vorbis="date", ape="Year"),
    Field("track_number", "Track Number", kind="number", id3="TRCK", mp4="trkn", vorbis="tracknumber", ape="Track"),
    Field("disc_number", "Disc Number", kind="number", id3="TPOS", mp4="disk", vorbis="discnumber", ape="Disc"),
    Field("comment", "Comment", id3="COMM", id3_kind="comment", mp4="\xa9cmt", vorbis="comment", ape="Comment"),
    Field("lyrics", "Lyrics", id3="USLT", id3_kind="lyrics", mp4="\xa9lyr", vorbis="lyrics", ape="Lyrics"),
    Field("grouping", "Grouping", id3="TIT1", mp4="\xa9grp", vorbis="grouping", ape="Grouping"),
    Field("bpm", "BPM", kind="number", id3="TBPM", mp4="tmpo", vorbis="bpm", ape="BPM"),
    Field("copyright", "Copyright", id3="TCOP", mp4="cprt", vorbis="copyright", ape="Copyright"),
    Field("publisher", "Publisher", id3="TPUB", vorbis="publisher", ape="Publisher"),
    Field("isrc", "ISRC", id3="TSRC", vorbis="isrc"),
    Field("language", "Language", id3="TLAN", vorbis="language"),
    Field("encoded_by", "Encoded By", id3="TENC", mp4="\xa9too", vorbis="encodedby"),
    Field("initial_key", "Initial Key", id3="TKEY", vorbis="key"),
    Field("original_artist", "Original Artist", id3="TOPE", vorbis="originalartist"),
    Field("original_date", "Original Date", id3="TDOR", vorbis="originaldate"),
    Field("compilation", "Compilation", id3="TCMP", mp4="cpil", vorbis="compilation"),
    Field("sort_title", "Sort Title", id3="TSOT", vorbis="titlesort"),
    Field("sort_artist", "Sort Artist", id3="TSOP", vorbis="artistsort"),
    Field("sort_album", "Sort Album", id3="TSOA", vorbis="albumsort"),
]

FIELD_BY_KEY: dict[str, Field] = {f.key: f for f in FIELDS}

# Pseudo-fields: (key, label, writable)
PSEUDO_FIELDS: list[tuple[str, str, bool]] = [
    ("filename", "File Name", True),
    ("stem", "File Name (no extension)", False),
    ("ext", "Extension", False),
    ("folder_name", "Folder Name", False),
    ("folder_path", "Folder Path", False),
]

# Pseudo/sort fields that only make sense internally — hidden from the
# rule field dropdowns to keep the picker focused on real metadata.
EXCLUDE_FROM_RULES: set[str] = {
    "ext",
    "folder_name",
    "folder_path",
    "sort_title",
    "sort_artist",
    "sort_album",
}

# Fields a rule may never blank. The file name is the only one: an empty name
# is not a valid file, so a rule that would clear it is refused outright (see
# RuleContext.set). Rules may still *rename* — they just cannot empty it.
MUST_NOT_BE_EMPTY: set[str] = {"filename"}

# Fields offered as rule targets / sources: writable tag fields first,
# then pseudo-fields ("filename" is the only writable pseudo-field).
RULE_FIELDS: list[dict] = [
    {
        "key": f.key,
        "label": f.label,
        "kind": f.kind,
        "pseudo": False,
        "writable": f.writable,
        "must_not_be_empty": f.key in MUST_NOT_BE_EMPTY,
    }
    for f in FIELDS
    if f.writable and f.key not in EXCLUDE_FROM_RULES
] + [
    {
        "key": key,
        "label": label,
        "kind": "text",
        "pseudo": True,
        "writable": writable,
        "must_not_be_empty": key in MUST_NOT_BE_EMPTY,
    }
    for key, label, writable in PSEUDO_FIELDS
    if key not in EXCLUDE_FROM_RULES
]

RULE_FIELD_KEYS: set[str] = {f["key"] for f in RULE_FIELDS}


def field_label(key: str) -> str:
    """Human-readable label for a canonical or pseudo field id."""
    if key in FIELD_BY_KEY:
        return FIELD_BY_KEY[key].label
    for k, label, _ in PSEUDO_FIELDS:
        if k == key:
            return label
    return key
