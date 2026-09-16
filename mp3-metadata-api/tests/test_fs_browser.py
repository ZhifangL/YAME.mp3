"""Filesystem browsing and drop-path expansion."""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.api import create_app
from app.services.fs_browser import expand_paths, list_directory


def test_expand_paths_passes_through_audio_files(make_audio, tmp_path: Path):
    song = make_audio(tmp_path / "song.wav")
    result = expand_paths([str(song)])
    assert result["files"] == [str(song)]
    assert result["skipped"] == []


def test_expand_paths_walks_folders_recursively(make_audio, tmp_path: Path):
    root = tmp_path / "Album"
    top = make_audio(root / "one.wav")
    nested = make_audio(root / "CD2" / "two.wav")
    deeper = make_audio(root / "CD2" / "Bonus" / "three.wav")

    result = expand_paths([str(root)])
    assert set(result["files"]) == {str(top), str(nested), str(deeper)}
    assert result["skipped"] == []


def test_expand_paths_handles_a_mixed_selection(make_audio, tmp_path: Path):
    """The whole point: one drop carrying files AND folders."""
    root = tmp_path / "Album"
    in_folder = make_audio(root / "inside.wav")
    loose = make_audio(tmp_path / "loose.wav")
    not_audio = tmp_path / "notes.txt"
    not_audio.write_text("hello")

    result = expand_paths([str(loose), str(root), str(not_audio)])
    assert set(result["files"]) == {str(loose), str(in_folder)}
    # The loose non-audio file is reported, not silently dropped.
    assert result["skipped"] == [str(not_audio)]


def test_expand_paths_skips_missing_paths(tmp_path: Path):
    missing = str(tmp_path / "gone")
    result = expand_paths([missing])
    assert result["files"] == []
    assert result["skipped"] == [missing]


def test_expand_paths_deduplicates(make_audio, tmp_path: Path):
    root = tmp_path / "Album"
    song = make_audio(root / "one.wav")
    result = expand_paths([str(song), str(root), str(root)])
    assert result["files"] == [str(song)]


def test_expand_paths_ignores_hidden_directories(make_audio, tmp_path: Path):
    root = tmp_path / "Album"
    visible = make_audio(root / "one.wav")
    make_audio(root / ".hidden" / "secret.wav")
    result = expand_paths([str(root)])
    assert result["files"] == [str(visible)]


def test_expand_paths_of_an_empty_list():
    assert expand_paths([]) == {"files": [], "skipped": [], "truncated": False}


def test_recursive_browse_and_expand_agree(make_audio, tmp_path: Path):
    root = tmp_path / "Album"
    make_audio(root / "one.wav")
    make_audio(root / "CD2" / "two.wav")

    browsed = {f["path"] for f in list_directory(str(root), recursive=True)["audio_files"]}
    expanded = set(expand_paths([str(root)])["files"])
    assert browsed == expanded


def test_recursive_browse_is_alphabetical(make_audio, tmp_path: Path):
    root = tmp_path / "Album"
    make_audio(root / "b.wav")
    make_audio(root / "a.wav")
    make_audio(root / "CD2" / "c.wav")
    names = [f["name"] for f in list_directory(str(root), recursive=True)["audio_files"]]
    assert names == sorted(names)


def test_expand_endpoint_accepts_an_empty_selection():
    client = TestClient(create_app())
    body = client.post("/api/paths/expand", json={"paths": []}).json()
    assert body == {"files": [], "skipped": [], "truncated": False}


def test_expand_endpoint_with_a_mixed_selection(make_audio, tmp_path: Path):
    client = TestClient(create_app())
    root = tmp_path / "Album"
    inside = make_audio(root / "inside.wav")
    loose = make_audio(tmp_path / "loose.wav")

    body = client.post("/api/paths/expand", json={"paths": [str(loose), str(root)]}).json()
    assert set(body["files"]) == {str(loose), str(inside)}
    assert body["truncated"] is False
