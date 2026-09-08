# TagForge — engine (mp3-metadata-api)

FastAPI service that reads/writes audio metadata and runs the TagForge
rules engine. In dev it serves the React frontend over HTTP on
`127.0.0.1:8000`; in the packaged Tauri app it ships as a Python sidecar.

## Run

```bash
uv sync                      # first time only
.venv/bin/uvicorn main:app --port 8000
```

- Interactive docs: <http://127.0.0.1:8000/docs>
- Health check: `curl http://127.0.0.1:8000/api/health`

> The API reads/writes local files by absolute path and must stay bound to
> 127.0.0.1 only.

## Layout

```
main.py                  entry point (uvicorn main:app)
app/
  api.py                 app factory (CORS, routers)
  schemas.py             pydantic request/response models (the JSON contract)
  fields.py              canonical field catalog (tag keys per format +
                         pseudo-fields like filename/folder)
  services/
    fs_browser.py        folder browsing -> folders + audio files
    audio_io.py          mutagen read/write for MP3/M4A/FLAC/OGG/WAV/AIFF/
                         APEv2 + WMA read-only, cover art, ruleset applier
    rules.py             the rules engine: CLEAR, REPLACE, WRITE, APPEND,
                         COPY FROM, PARSE FILENAME, CHANGE CASE, SET COVER
    presets.py           named rulesets as JSON in ~/.config/tagforge/
  routers/
    filesystem.py        GET /api/browse
    audio.py             everything else (see below)
```

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/browse?path=` | List folders + audio files |
| GET | `/api/metadata?path=` | Read one file (tags, stream info, cover) |
| POST | `/api/tracks/read` | Read many files at once |
| POST | `/api/tracks/write` | Write fields of one file (`rename_to` renames) |
| POST | `/api/tracks/cover` | Replace or remove (`remove: true`) embedded cover art |
| GET | `/api/rules/registry` | Rule + field catalog (the UI renders from this) |
| POST | `/api/preview` | Dry-run one rule on given field values |
| POST | `/api/apply` | Dry-run or apply a ruleset to many files |
| GET/PUT/DELETE | `/api/presets` | Named rulesets (JSON in `~/.config/tagforge/`) |
| POST | `/api/presets/import` | Import exported rulesets |

## Metadata response shape

```jsonc
{
  "file":    { "path", "filename", "size_bytes", "modified_unix", "created_unix" },
  "audio":   { "duration_seconds", "bitrate_kbps", "sample_rate_hz",
               "channels", "codec", "codec_detail", "mode", "bitrate_mode" },
  "fields":  { "title": "...", "artist": "...", "album": "...",
               "date": "...", "comment": "...", ... },   // canonical ids
  "frames":  [ { "id": "TIT2", "description": "", "values": ["..."] } ],
  "cover":   { "mime": "image/jpeg", "data_base64": "..." } | null,
  "writable": true,
  "warnings": []
}
```

## Rules

Rules are self-describing classes in `services/rules.py` registered in
`REGISTRY`; the registry spec is served to the UI at `/api/rules/registry`,
so adding a rule type requires no frontend changes. Wildcards: `*` = any run
of characters, `?` = one character; in REPLACE the replacement supports
`$1`-`$9` back-references to the wildcard captures. PARSE FILENAME assigns
each capture to a field. Fields can be any tag field from `app/fields.py` or
a pseudo-field (`filename`, `stem`, `ext`, `folder_name`, `folder_path`);
writing `filename` renames the file.

## Notes

- MP3 files are written as ID3v2.3 (UTF-8) and ID3v1 tags are removed on
  save to avoid stale duplicates.
- WMA/ASF is read-only (mutagen limitation); everything else the app lists
  as writable can be edited.
- Presets live in `~/.config/tagforge/presets.json` (override with the
  `TAGFORGE_CONFIG_DIR` env var — the Tauri build will point it at the
  per-user app-support folder).
