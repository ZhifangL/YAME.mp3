"""API-level tests: the JSON contract the React frontend depends on."""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def test_health_reports_the_config_dir(client: TestClient, monkeypatch, tmp_path: Path):
    monkeypatch.setenv("YAME_CONFIG_DIR", str(tmp_path / "cfg"))
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["config_dir"] == str(tmp_path / "cfg")


def test_registry_describes_rules_and_fields(client: TestClient):
    body = client.get("/api/rules/registry").json()
    assert {s["type"] for s in body["specs"]} >= {
        "CLEAR", "REPLACE", "WRITE", "APPEND", "COPY FROM",
        "PARSE FILENAME", "CHANGE CASE", "SET COVER", "REMOVE COVER",
    }
    assert {f["key"] for f in body["fields"]} >= {"title", "artist", "filename"}


def test_read_many_reports_unreadable_files_instead_of_hiding_them(
    client: TestClient, audio_file: Path, tmp_path: Path
):
    """Regression: TracksReadResponse had no `errors` field, so FastAPI
    dropped the list and the UI could never warn about skipped files."""
    missing = str(tmp_path / "missing.mp3")
    body = client.post("/api/tracks/read", json={"paths": [str(audio_file), missing]}).json()

    assert len(body["tracks"]) == 1
    assert len(body["errors"]) == 1
    assert body["errors"][0]["path"] == missing
    assert body["errors"][0]["error"]


def test_metadata_returns_canonical_fields(client: TestClient, audio_file: Path):
    body = client.get("/api/metadata", params={"path": str(audio_file)}).json()
    assert body["file"]["filename"] == audio_file.name
    assert "title" in body["fields"]
    assert body["writable"] is True
    # `frames` was dead weight, removed from the contract on purpose.
    assert "frames" not in body


def test_metadata_missing_file_is_404(client: TestClient, tmp_path: Path):
    res = client.get("/api/metadata", params={"path": str(tmp_path / "nope.mp3")})
    assert res.status_code == 404


def test_metadata_non_audio_is_422(client: TestClient, tmp_path: Path):
    bogus = tmp_path / "fake.mp3"
    bogus.write_text("not audio")
    assert client.get("/api/metadata", params={"path": str(bogus)}).status_code == 422


def test_write_then_read(client: TestClient, audio_file: Path):
    body = client.post("/api/tracks/write", json={
        "path": str(audio_file), "fields": {"title": "API Title", "artist": "API Artist"},
    }).json()
    assert body["warnings"] == []
    assert body["track"]["fields"]["title"] == "API Title"


def test_write_with_a_dotted_rename_keeps_the_extension(client: TestClient, audio_file: Path):
    body = client.post("/api/tracks/write", json={
        "path": str(audio_file), "fields": {}, "rename_to": "Mr. Brightside",
    }).json()

    assert body["warnings"] == []
    assert body["track"] is not None
    assert Path(body["track"]["file"]["path"]).name == "Mr. Brightside.wav"
    assert not audio_file.exists()


def test_write_returns_the_original_file_when_a_rename_is_refused(client: TestClient, audio_file: Path):
    """Regression: the response used to read back the *target* path, so a
    refused rename made the UI adopt the wrong file."""
    taken = audio_file.parent / "taken.wav"
    taken.write_bytes(b"x")

    body = client.post("/api/tracks/write", json={
        "path": str(audio_file), "fields": {}, "rename_to": "taken.wav",
    }).json()

    assert body["warnings"] and "already exists" in body["warnings"][0]
    assert Path(body["track"]["file"]["path"]) == audio_file
    assert audio_file.exists()


def test_apply_dry_run_and_write(client: TestClient, audio_file: Path):
    ruleset = {"name": "t", "rules": [
        {"type": "WRITE", "params": {"field": "title", "value": "Batch"}, "enabled": True},
    ]}
    dry = client.post("/api/apply", json={"paths": [str(audio_file)], "ruleset": ruleset, "dry_run": True}).json()
    assert dry["dry_run"] is True
    assert dry["results"][0]["written"] is False

    real = client.post("/api/apply", json={"paths": [str(audio_file)], "ruleset": ruleset, "dry_run": False}).json()
    assert real["results"][0]["written"] is True
    assert client.get("/api/metadata", params={"path": str(audio_file)}).json()["fields"]["title"] == "Batch"


def test_apply_rename_plus_cover_does_not_500(client: TestClient, audio_file: Path, png_bytes: bytes):
    """Regression: this combination raised mutagen.MutagenError out of the
    endpoint, half-applying the batch and returning a 500."""
    ruleset = {"name": "t", "rules": [
        {"type": "WRITE", "params": {"field": "title", "value": "Both"}, "enabled": True},
        {"type": "COPY FROM", "params": {"source": "title", "field": "filename"}, "enabled": True},
        {"type": "SET COVER", "params": {"image": {
            "mime": "image/png",
            "data_base64": base64.b64encode(png_bytes).decode(),
            "name": "art.png",
        }}, "enabled": True},
    ]}
    res = client.post("/api/apply", json={"paths": [str(audio_file)], "ruleset": ruleset, "dry_run": False})
    assert res.status_code == 200

    row = res.json()["results"][0]
    assert row["warnings"] == []
    assert row["new_filename"] == "Both.wav"
    moved = audio_file.parent / "Both.wav"
    assert client.get("/api/metadata", params={"path": str(moved)}).json()["cover"] is not None


def test_apply_rejects_an_empty_ruleset(client: TestClient, audio_file: Path):
    res = client.post("/api/apply", json={
        "paths": [str(audio_file)], "ruleset": {"name": "x", "rules": []}, "dry_run": True,
    })
    assert res.status_code == 400


def test_apply_rejects_an_empty_path_list(client: TestClient):
    res = client.post("/api/apply", json={
        "paths": [],
        "ruleset": {"name": "x", "rules": [{"type": "CLEAR", "params": {"field": "title"}}]},
        "dry_run": True,
    })
    assert res.status_code == 400


def test_preview_never_touches_files(client: TestClient):
    body = client.post("/api/preview", json={
        "filename": "Artist - Title.mp3",
        "folder": "/Music",
        "fields": {"title": "Artist - Title"},
        "rule": {"type": "REPLACE", "params": {"field": "title", "find": " - ", "replace": " – "}},
    }).json()
    assert body["changes"][0]["after"] == "Artist – Title"
    assert body["changes"][0]["label"] == "Title"


def test_preview_reports_no_change_for_an_incomplete_replace(client: TestClient):
    """An empty Find is incomplete, not a rule that shreds the value."""
    body = client.post("/api/preview", json={
        "filename": "a.mp3",
        "folder": "/Music",
        "fields": {"title": "Song"},
        "rule": {"type": "REPLACE", "params": {"field": "title", "find": "", "replace": "-"}},
    }).json()
    assert body["changes"] == []
    assert body["fields"]["title"] == "Song"


def test_registry_marks_incomplete_prone_params_as_required(client: TestClient):
    specs = {s["type"]: s for s in client.get("/api/rules/registry").json()["specs"]}
    find = next(p for p in specs["REPLACE"]["params"] if p["name"] == "find")
    assert find["required"] is True
    # Replace-with may legitimately be empty (that deletes the match).
    replace = next(p for p in specs["REPLACE"]["params"] if p["name"] == "replace")
    assert replace["required"] is False

    parse = {p["name"]: p for p in specs["PARSE FILENAME"]["params"]}
    assert parse["pattern"]["required"] is True
    assert parse["assignments"]["required"] is True


def test_preview_batch_returns_the_first_matching_track(client: TestClient):
    body = client.post("/api/preview-batch", json={
        "candidates": [
            {"filename": "a.mp3", "folder": "/m", "fields": {"title": "No match"}},
            {"filename": "b.mp3", "folder": "/m", "fields": {"title": "Has (brackets)"}},
        ],
        "rule": {"type": "REPLACE", "params": {"field": "title", "find": " (*", "replace": ""}},
    }).json()
    assert body["matched_index"] == 1
    assert body["changes"][0]["after"] == "Has"


def test_preview_rejects_an_unknown_rule_type(client: TestClient):
    res = client.post("/api/preview", json={
        "filename": "a.mp3", "folder": "/m", "fields": {}, "rule": {"type": "NOPE", "params": {}},
    })
    assert res.status_code == 400


def test_browse_lists_audio_files(client: TestClient, audio_file: Path):
    body = client.get("/api/browse", params={"path": str(audio_file.parent)}).json()
    assert audio_file.name in [f["name"] for f in body["audio_files"]]
    assert body["parent"] is not None


def test_preset_round_trip(client: TestClient, monkeypatch, tmp_path: Path):
    monkeypatch.setenv("YAME_CONFIG_DIR", str(tmp_path / "cfg"))
    ruleset = {"name": "Cleanup", "rules": [
        {"type": "CLEAR", "params": {"field": "comment"}, "enabled": True},
    ]}

    saved = client.put("/api/presets", json={"name": "Cleanup", "ruleset": ruleset}).json()
    assert saved["id"]
    assert [p["name"] for p in client.get("/api/presets").json()] == ["Cleanup"]

    updated = client.put("/api/presets", json={
        "name": "Cleanup v2", "ruleset": ruleset, "preset_id": saved["id"],
    }).json()
    assert updated["id"] == saved["id"]
    assert len(client.get("/api/presets").json()) == 1

    assert client.delete(f"/api/presets/{saved['id']}").status_code == 200
    assert client.get("/api/presets").json() == []


def test_deleting_an_unknown_preset_is_404(client: TestClient, monkeypatch, tmp_path: Path):
    monkeypatch.setenv("YAME_CONFIG_DIR", str(tmp_path / "cfg"))
    assert client.delete("/api/presets/nope").status_code == 404


def test_cover_from_file_embeds_a_dropped_image(client: TestClient, audio_file: Path, png_bytes: bytes, tmp_path: Path):
    """The packaged app hands over a path (Finder drop / native picker) rather
    than base64 from a browser file input."""
    image = tmp_path / "art.png"
    image.write_bytes(png_bytes)

    res = client.post("/api/tracks/cover-from-file", json={"path": str(audio_file), "image_path": str(image)})
    assert res.status_code == 200
    body = res.json()
    assert body["warnings"] == []
    assert body["track"]["cover"]["mime"] == "image/png"
    assert base64.b64decode(body["track"]["cover"]["data_base64"]) == png_bytes


def test_cover_from_file_rejects_a_non_image(client: TestClient, audio_file: Path, tmp_path: Path):
    notes = tmp_path / "notes.txt"
    notes.write_text("not an image")
    res = client.post("/api/tracks/cover-from-file", json={"path": str(audio_file), "image_path": str(notes)})
    assert res.status_code == 422
    assert "Unsupported cover image type" in res.json()["detail"]


def test_cover_from_file_missing_image_is_404(client: TestClient, audio_file: Path, tmp_path: Path):
    res = client.post("/api/tracks/cover-from-file", json={
        "path": str(audio_file), "image_path": str(tmp_path / "nope.png"),
    })
    assert res.status_code == 404


def test_presets_are_adopted_from_the_pre_rebrand_config_dir(monkeypatch, tmp_path: Path):
    """The app shipped as TagForge; an upgrade must not lose saved rulesets."""
    from app.services import presets as presets_module

    legacy_home = tmp_path / "home"
    (legacy_home / ".config" / "tagforge").mkdir(parents=True)
    (legacy_home / ".config" / "tagforge" / "presets.json").write_text(
        json.dumps({"version": 1, "presets": [{
            "id": "keepme", "name": "Old Rules",
            "ruleset": {"name": "Old Rules", "rules": []}, "updated_unix": 1.0,
        }]}),
        encoding="utf-8",
    )
    monkeypatch.setattr(presets_module.Path, "home", staticmethod(lambda: legacy_home))
    monkeypatch.delenv("YAME_CONFIG_DIR", raising=False)
    monkeypatch.delenv("TAGFORGE_CONFIG_DIR", raising=False)
    monkeypatch.setattr(presets_module, "_migrated", False)

    names = [p["name"] for p in presets_module.list_presets()]
    assert names == ["Old Rules"]
    # The original file is left untouched.
    assert (legacy_home / ".config" / "tagforge" / "presets.json").is_file()


def test_foreign_web_origins_are_refused(client: TestClient):
    """The engine can rewrite files anywhere the user can write, so a page in
    the user's browser must not be able to drive it."""
    evil = client.post(
        "/api/apply",
        json={"paths": ["/tmp/x.mp3"], "ruleset": {"name": "x", "rules": []}, "dry_run": True},
        headers={"Origin": "https://evil.example"},
    )
    assert evil.status_code == 403

    # Preflight too, so the browser never sends the real request.
    preflight = client.options(
        "/api/apply",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert preflight.status_code == 403


def test_the_apps_own_origins_still_work(client: TestClient):
    for origin in ("tauri://localhost", "http://localhost:5173"):
        res = client.get("/api/health", headers={"Origin": origin})
        assert res.status_code == 200, origin


def test_requests_without_an_origin_still_work(client: TestClient):
    # curl, the sidecar's own checks and any local tooling.
    assert client.get("/api/health").status_code == 200


def test_importing_a_malformed_ruleset_cannot_brick_the_preset_store(
    client: TestClient, monkeypatch, tmp_path: Path
):
    """A stored preset with the wrong shape used to make every later
    GET /api/presets fail validation, so the bad entry could not be deleted."""
    monkeypatch.setenv("YAME_CONFIG_DIR", str(tmp_path / "cfg"))

    imported = client.post("/api/presets/import", json={"presets": [
        {"name": "List ruleset", "ruleset": ["not", "a", "dict"]},
        {"name": "Bad rules", "ruleset": {"name": "Bad rules", "rules": "nope"}},
        {"name": "Junk rules", "ruleset": {"rules": [1, {"type": ""}, {"type": "CLEAR", "params": "x"}]}},
        {"name": "Good", "ruleset": {"name": "Good", "rules": [
            {"type": "CLEAR", "params": {"field": "comment"}, "enabled": True},
        ]}},
    ]}).json()
    assert len(imported) == 4

    # The list must still load, and must still be valid.
    listed = client.get("/api/presets")
    assert listed.status_code == 200
    names = [p["name"] for p in listed.json()]
    assert names == ["List ruleset", "Bad rules", "Junk rules", "Good"]

    good = next(p for p in listed.json() if p["name"] == "Good")
    assert good["ruleset"]["rules"][0]["type"] == "CLEAR"
    junk = next(p for p in listed.json() if p["name"] == "Junk rules")
    assert [r["type"] for r in junk["ruleset"]["rules"]] == ["CLEAR"]
    assert junk["ruleset"]["rules"][0]["params"] == {}

    # And it can still be deleted.
    assert client.delete(f"/api/presets/{junk['id']}").status_code == 200


def test_presets_written_out_of_shape_are_tolerated_on_read(
    client: TestClient, monkeypatch, tmp_path: Path
):
    """A file left by an older build must not break the list either."""
    cfg = tmp_path / "cfg"
    cfg.mkdir(parents=True)
    (cfg / "presets.json").write_text(json.dumps({"version": 1, "presets": [
        {"id": "a", "name": "Fine", "ruleset": {"name": "Fine", "rules": []}, "updated_unix": 1.0},
        "not even an object",
        {"id": "b", "ruleset": {"rules": []}},
    ]}), encoding="utf-8")
    monkeypatch.setenv("YAME_CONFIG_DIR", str(cfg))

    body = client.get("/api/presets")
    assert body.status_code == 200
    assert [p["name"] for p in body.json()] == ["Fine"]
