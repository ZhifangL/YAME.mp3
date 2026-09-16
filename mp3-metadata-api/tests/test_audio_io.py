"""Read/write, rename and cover-art tests against real (generated) audio files."""
from __future__ import annotations

import base64
from pathlib import Path

import pytest

from app.services.audio_io import (
    MetadataError,
    _target_name,
    _unsafe_name_reason,
    apply_ruleset,
    read_track,
    remove_cover,
    write_cover,
    write_fields,
)


# ------------------------------------------------------------------ rename names

@pytest.mark.parametrize(("requested", "expected"), [
    ("Artist - Title", "Artist - Title.mp3"),
    ("Mr. Brightside", "Mr. Brightside.mp3"),      # a dot is not an extension
    ("Track 1.5", "Track 1.5.mp3"),
    ("NoExtension", "NoExtension.mp3"),
    ("  padded  ", "padded.mp3"),
    ("trailing.", "trailing.mp3"),
    ("song.flac", "song.mp3"),                     # renaming cannot convert formats
    ("UPPER.MP3", "UPPER.MP3"),
    ("a.b.c", "a.b.c.mp3"),
    ("", "song.mp3"),
    ("   ", "song.mp3"),
    ("...", "song.mp3"),
])
def test_target_name_always_keeps_a_usable_extension(requested, expected):
    assert _target_name(Path("/music/song.mp3"), requested) == expected


@pytest.mark.parametrize("unsafe", ["AC/DC", "back\\slash", "..", ".", "a\0b", ""])
def test_unsafe_names_are_rejected(unsafe):
    assert _unsafe_name_reason(unsafe) is not None


@pytest.mark.parametrize("safe", ["Normal Name.mp3", "Mr. Brightside.mp3", "AC+DC.mp3"])
def test_safe_names_are_accepted(safe):
    assert _unsafe_name_reason(safe) is None


# ------------------------------------------------------------------ read / write

def test_write_then_read_round_trip(audio_file: Path):
    outcome = write_fields(str(audio_file), {
        "title": "Probe Title",
        "artist": "Probe Artist",
        "album": "Probe Album",
        "date": "2024",
        "genre": "Rock",
        "track_number": "7",
        "comment": "hello",
    })
    assert outcome.warnings == []
    assert outcome.path == str(audio_file)
    assert not outcome.renamed

    md = read_track(str(audio_file))
    assert md["fields"]["title"] == "Probe Title"
    assert md["fields"]["artist"] == "Probe Artist"
    assert md["fields"]["track_number"] == "7"
    assert md["writable"] is True


def test_empty_value_deletes_the_tag(audio_file: Path):
    write_fields(str(audio_file), {"comment": "hi"})
    write_fields(str(audio_file), {"comment": ""})
    assert read_track(str(audio_file))["fields"]["comment"] == ""


def test_unknown_field_keys_are_ignored(audio_file: Path):
    outcome = write_fields(str(audio_file), {"not_a_field": "x", "title": "Kept"})
    assert outcome.warnings == []
    assert read_track(str(audio_file))["fields"]["title"] == "Kept"


def test_write_to_a_missing_file_raises_file_not_found(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        write_fields(str(tmp_path / "missing.mp3"), {"title": "x"})


def test_reading_a_non_audio_file_raises_metadata_error(tmp_path: Path):
    bogus = tmp_path / "notaudio.mp3"
    bogus.write_text("definitely not audio")
    with pytest.raises(MetadataError):
        read_track(str(bogus))


# ------------------------------------------------------------------ renames

def test_rename_keeps_the_extension(audio_file: Path):
    # A dot inside the name is not an extension change, so nothing to warn about.
    outcome = write_fields(str(audio_file), {}, rename_to="Mr. Brightside")
    assert outcome.renamed
    assert outcome.warnings == []
    assert Path(outcome.path).name == "Mr. Brightside.wav"
    assert Path(outcome.path).exists()
    assert not audio_file.exists()


def test_rename_without_an_extension(audio_file: Path):
    outcome = write_fields(str(audio_file), {}, rename_to="Artist - Title")
    assert Path(outcome.path).name == "Artist - Title.wav"


def test_rename_refused_when_the_target_exists(audio_file: Path):
    blocker = audio_file.parent / "taken.wav"
    blocker.write_bytes(b"x")
    outcome = write_fields(str(audio_file), {}, rename_to="taken.wav")
    assert not outcome.renamed
    assert outcome.path == str(audio_file)
    assert audio_file.exists()
    assert "already exists" in outcome.warnings[0]


def test_rename_refuses_to_escape_the_folder(audio_file: Path):
    outcome = write_fields(str(audio_file), {}, rename_to="../escaped")
    assert not outcome.renamed
    assert outcome.path == str(audio_file)
    assert audio_file.exists()
    assert not (audio_file.parent.parent / "escaped.mp3").exists()
    assert "path separators" in outcome.warnings[0]


def test_rename_refuses_a_slash_from_a_tag_value(audio_file: Path):
    outcome = write_fields(str(audio_file), {}, rename_to="AC/DC")
    assert not outcome.renamed
    assert audio_file.exists()


def test_fields_and_rename_together(audio_file: Path):
    outcome = write_fields(str(audio_file), {"title": "New"}, rename_to="Renamed")
    assert Path(outcome.path).name == "Renamed.wav"
    assert read_track(outcome.path)["fields"]["title"] == "New"


# ------------------------------------------------------------------ cover art

def test_cover_set_and_remove(audio_file: Path, png_bytes: bytes):
    assert read_track(str(audio_file))["cover"] is None
    encoded = base64.b64encode(png_bytes).decode()

    assert write_cover(str(audio_file), "image/png", encoded) == []
    cover = read_track(str(audio_file))["cover"]
    assert cover is not None
    assert cover["mime"] == "image/png"
    assert base64.b64decode(cover["data_base64"]) == png_bytes

    assert remove_cover(str(audio_file)) == []
    assert read_track(str(audio_file))["cover"] is None


def test_cover_rejects_oversized_images(audio_file: Path):
    oversized = base64.b64encode(b"\0" * (10 * 1024 * 1024 + 1)).decode()
    with pytest.raises(MetadataError):
        write_cover(str(audio_file), "image/png", oversized)


def test_cover_rejects_invalid_base64(audio_file: Path):
    with pytest.raises(MetadataError):
        write_cover(str(audio_file), "image/png", "not base64!!")


# ------------------------------------------------------------------ apply

def _ruleset(*rules: dict) -> dict:
    return {"name": "test", "rules": list(rules)}


def test_apply_dry_run_reports_changes_without_writing(audio_file: Path):
    result = apply_ruleset([str(audio_file)], _ruleset(
        {"type": "WRITE", "params": {"field": "title", "value": "Dry"}, "enabled": True},
    ), dry_run=True)

    assert result["dry_run"] is True
    assert result["changed_files"] == 1
    assert result["results"][0]["written"] is False
    assert result["results"][0]["changes"][0]["after"] == "Dry"
    assert result["results"][0]["changes"][0]["label"] == "Title"
    assert read_track(str(audio_file))["fields"]["title"] == ""


def test_apply_writes_fields(audio_file: Path):
    result = apply_ruleset([str(audio_file)], _ruleset(
        {"type": "WRITE", "params": {"field": "title", "value": "Applied"}, "enabled": True},
    ), dry_run=False)
    assert result["results"][0]["written"] is True
    assert read_track(str(audio_file))["fields"]["title"] == "Applied"


def test_apply_reports_the_new_name_when_a_rule_renames_the_file(audio_file: Path):
    result = apply_ruleset([str(audio_file)], _ruleset(
        {"type": "WRITE", "params": {"field": "title", "value": "New Name"}, "enabled": True},
        {"type": "COPY FROM", "params": {"source": "title", "field": "filename"}, "enabled": True},
    ), dry_run=False)

    row = result["results"][0]
    assert row["new_filename"] == "New Name.wav"
    assert Path(row["path"]).parent.joinpath("New Name.wav").exists()


def test_apply_keeps_the_reported_name_when_a_rename_is_refused(audio_file: Path):
    (audio_file.parent / "Taken.wav").write_bytes(b"x")
    result = apply_ruleset([str(audio_file)], _ruleset(
        {"type": "WRITE", "params": {"field": "title", "value": "Taken"}, "enabled": True},
        {"type": "COPY FROM", "params": {"source": "title", "field": "filename"}, "enabled": True},
    ), dry_run=False)

    row = result["results"][0]
    # The file never moved, so the row must not claim a new name.
    assert row["new_filename"] == audio_file.name
    assert audio_file.exists()
    assert any("already exists" in w for w in row["warnings"])


def test_apply_can_rename_and_set_cover_in_one_ruleset(audio_file: Path, png_bytes: bytes):
    """Regression: the cover was written to the pre-rename path, which made
    mutagen raise and turned the whole /api/apply request into a 500."""
    encoded = base64.b64encode(png_bytes).decode()
    result = apply_ruleset([str(audio_file)], _ruleset(
        {"type": "WRITE", "params": {"field": "title", "value": "Both"}, "enabled": True},
        {"type": "COPY FROM", "params": {"source": "title", "field": "filename"}, "enabled": True},
        {"type": "SET COVER", "params": {"image": {"mime": "image/png", "data_base64": encoded, "name": "art.png"}}, "enabled": True},
    ), dry_run=False)

    row = result["results"][0]
    assert row["error"] is None
    assert row["warnings"] == []
    assert row["written"] is True
    assert row["new_filename"] == "Both.wav"

    moved = audio_file.parent / "Both.wav"
    assert moved.exists()
    assert read_track(str(moved))["fields"]["title"] == "Both"
    assert read_track(str(moved))["cover"] is not None


def test_apply_can_rename_and_remove_cover_in_one_ruleset(audio_file: Path, png_bytes: bytes):
    write_cover(str(audio_file), "image/png", base64.b64encode(png_bytes).decode())
    result = apply_ruleset([str(audio_file)], _ruleset(
        {"type": "WRITE", "params": {"field": "title", "value": "Moved"}, "enabled": True},
        {"type": "COPY FROM", "params": {"source": "title", "field": "filename"}, "enabled": True},
        {"type": "REMOVE COVER", "params": {}, "enabled": True},
    ), dry_run=False)

    moved = audio_file.parent / "Moved.wav"
    assert result["results"][0]["warnings"] == []
    assert moved.exists()
    assert read_track(str(moved))["cover"] is None


def test_one_unreadable_file_does_not_sink_the_batch(audio_file: Path, tmp_path: Path):
    """A bad row must be reported, not raised: a 500 would lose the whole run."""
    bogus = tmp_path / "broken.mp3"
    bogus.write_text("not audio")
    result = apply_ruleset([str(bogus), str(audio_file)], _ruleset(
        {"type": "WRITE", "params": {"field": "title", "value": "Fine"}, "enabled": True},
    ), dry_run=False)

    assert result["total_files"] == 2
    assert result["results"][0]["error"] is not None
    assert result["results"][1]["written"] is True


def test_apply_reports_an_error_for_a_missing_file(tmp_path: Path):
    result = apply_ruleset([str(tmp_path / "gone.mp3")], _ruleset(
        {"type": "CLEAR", "params": {"field": "comment"}, "enabled": True},
    ), dry_run=False)
    assert result["results"][0]["error"] is not None
    assert result["changed_files"] == 0
