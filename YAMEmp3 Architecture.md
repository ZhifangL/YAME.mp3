# YAMEmp3 Architecture

**Y**et **A**nother **M**etadata **E**ditor — a rule-based batch metadata editor for local
music libraries, shipped as a native desktop application for macOS and Windows.

This document is the onboarding guide for engineers joining the project. It assumes you
can read code and reason about systems, and it assumes **no** prior experience with the
specific tools involved: Tauri, Vite, FastAPI, PyInstaller, `mutagen`, GitHub Actions, or
the Rust and Python conventions used here. Every such tool is introduced with a short
explanation of what it is and what role it plays before it is used as a premise.

It is organised so you can read the first two sections and understand the shape of the
whole system, then dive into whichever layer you will be working on:

| Section | Covers |
| --- | --- |
| [1. The system in one page](#1-the-system-in-one-page) | What YAME does and the three-process model |
| [2. Technology primer](#2-technology-primer) | The unfamiliar tools, explained |
| [3. Repository layout](#3-repository-layout) | Where everything lives |
| [4. The engine](#4-the-engine-python--fastapi) | Python, FastAPI, the rule engine, audio I/O |
| [5. The desktop shell](#5-the-desktop-shell-rust--tauri) | Rust, Tauri, engine supervision, native menus |
| [6. The frontend](#6-the-frontend-react--typescript) | React, the store, the rule builder, the table |
| [7. End-to-end walkthroughs](#7-end-to-end-walkthroughs) | The six flows you must understand |
| [8. Build and packaging](#8-build-and-packaging) | PyInstaller, Tauri bundling, macOS and Windows |
| [9. CI/CD](#9-cicd) | GitHub Actions, tiers, artifacts |
| [10. Testing](#10-testing) | All three suites, and what each one proves |
| [11. Configuration and environment](#11-configuration-and-environment) | Every env var and file location |
| [12. Invariants and gotchas](#12-invariants-and-gotchas) | The traps, with justifications |
| [13. Glossary](#13-glossary) | One-line definitions |
| [14. Where to start](#14-where-to-start) | First tasks by interest |

---

## 1. The system in one page

YAME points at a folder of audio files, lets the user describe a clean-up as a short list
of **visible, reorderable rules** ("replace ` - ` with ` – ` in Title", "clear Comment",
"parse the file name into Artist and Title"), shows a **dry run** of every change, and
only then writes to disk. Rulesets can be saved as reusable presets.

The engineering bet behind the whole design is that *the interesting part of this problem
is describing the transformation*, not performing it. So the transformation description is
data, and everything else is plumbing around it.

### 1.1 Three processes, one application

```
   ┌─────────────────────────────────────────────────────────────────────────┐
   │  YAME.exe  /  YAME.app  — one native executable (Rust, Tauri)           │
   │                                                                         │
   │   ┌───────────────────────────────┐                                     │
   │   │  OS webview (WKWebView /      │   loads the built React bundle      │
   │   │  WebView2)                    │   from the embedded dist/ assets    │
   │   │                               │                                     │
   │   │   React 19 + TypeScript SPA   │                                     │
   │   └──────────┬────────────────────┘                                     │
   │              │                                                          │
   │              │  (a) HTTP  →  http://127.0.0.1:<port>/api/…             │
   │              │  (b) IPC   →  window.__TAURI__.core.invoke("cmd", args)  │
   │              │                                                          │
   │   ┌──────────┴────────────────────┐        ┌──────────────────────────┐ │
   │   │  Rust shell (Tauri runtime)   │ spawns │  yame-engine             │ │
   │   │  • picks a free port          │───────▶│  (Python 3.13, frozen    │ │
   │   │  • supervises the sidecar     │        │   with PyInstaller)      │ │
   │   │  • native menus, clipboard,   │        │                          │ │
   │   │    Open With, file pickers    │        │  FastAPI + mutagen       │ │
   │   └───────────────────────────────┘        └──────────────────────────┘ │
   │                                                    ▲                    │
   │        the engine binary is embedded in the        │  all file I/O      │
   │        executable and unpacked on first run ───────┘                    │
   └─────────────────────────────────────────────────────────────────────────┘
```

Three consequences fall out of this diagram, and most of the code exists because of one
of them:

1. **The engine owns every byte of file I/O and knows nothing about the UI.** It is a
   plain local HTTP service with a JSON API. It can be run, curled and tested on its own.
2. **The frontend owns every pixel and knows nothing about tag formats.** It renders its
   rule editors from a schema the engine serves, so adding a rule type requires no
   frontend change at all.
3. **The shell owns everything the webview cannot do** — windows, native menus, the
   clipboard, "Open With", and process lifetime — and knows nothing about either.

### 1.2 Why the rules are data

The engine defines nine rule types (`CLEAR`, `REPLACE`, `WRITE`, `APPEND`, `COPY FROM`,
`PARSE FILENAME`, `CHANGE CASE`, `SET COVER`, `REMOVE COVER`). Each rule class declares:

* its type id, label and description;
* a **parameter schema** — a list of `{name, label, kind, default, required, …}` dicts;
* an `apply(ctx, params) -> list[change]` method.

`GET /api/rules/registry` serialises that schema, and `RuleBuilder.tsx` renders a form
from it, switching on `kind` (`field`, `text`, `choice`, `bool`, `separator`, `image`,
`parse_pattern`, `parse_assignments`). A preset is therefore portable data:
`{name, rules: [{type, params, enabled}]}`, with no code attached.

The engine is *authoritative* and always re-validates. The frontend's job is only to keep
the button disabled until the parameters look complete.

### 1.3 The canonical field model

Different container formats store the same concept under different names: the title is
`TIT2` in ID3, `©nam` in an MP4 atom, `title` in a Vorbis comment and `Title` in APEv2.
The engine defines one **canonical field id** per concept (`title`, `artist`, `album`,
`album_artist`, `composer`, `genre`, `date`, `track_number`, `disc_number`, `comment`,
`lyrics`, `grouping`, `bpm`, `copyright`, `publisher`, `isrc`, `language`, `encoded_by`,
`initial_key`, `original_artist`, `original_date`, `compilation`, `sort_title`,
`sort_artist`, `sort_album` — see `mp3-metadata-api/app/fields.py`) and maps it onto each
format's native key. Rules operate only on canonical ids, which is why a ruleset written
against an MP3 applies unchanged to a FLAC or an M4A.

There are also **pseudo-fields**: `filename` (writable — writing it renames the file on
disk), and the read-only `stem`, `ext`, `folder_name`, `folder_path`.

---

## 2. Technology primer

Read this section once and you will be able to read every other section. Each entry is
"what it is", "what it does here", and "what you need to know to be productive".

### 2.1 Tauri (the desktop shell)

Electron-style desktop apps bundle an entire browser. **Tauri** instead uses the operating
system's own webview (WKWebView on macOS, WebView2/Chromium on Windows, WebKitGTK on
Linux) and pairs it with a small Rust program. The result is a few megabytes instead of a
few hundred.

The pieces you need:

* **`tauri.conf.json`** — the manifest: window defaults, the frontend asset directory,
  bundle targets, icons, security policy (CSP), and platform bundle settings.
* **The Rust crate** (`src-tauri/`) — `tauri::Builder` wires up plugins, commands and a
  setup hook. `build.rs` runs at compile time and can bake values into the binary.
* **Commands** — Rust functions annotated `#[tauri::command]` and registered in
  `invoke_handler`. The webview calls them with
  `window.__TAURI__.core.invoke("command_name", { argName: value })`. Arguments and
  return values are serialised as JSON (Rust `snake_case` parameter names arrive as
  `camelCase` from JS; the project passes exactly the names declared in Rust, e.g.
  `appPath`, `defaultName` — see `src/desktop.ts`).
* **Events** — the reverse direction. Rust calls `app.emit("event-name", payload)`; JS
  subscribes with `window.__TAURI__.event.listen`. YAME uses exactly one event name for
  menus: `yame://menu`.
* **Plugins** — prebuilt capability packages. YAME uses `tauri-plugin-dialog` (the OS file
  picker), `tauri-plugin-opener` (reveal-in-file-manager) and
  `tauri-plugin-single-instance`.
* **Capabilities / ACL** — a per-window allow-list of plugin permissions in
  `src-tauri/capabilities/default.json`. A plugin being registered is not enough; the
  window must be granted the specific permission or the call fails at runtime.
* **Sidecar** — Tauri's term for a helper executable shipped alongside the app. YAME's
  sidecar is the Python engine. (Note: as of commit `8943f49`, "Stop shipping the engine
  twice", YAME no longer uses Tauri's `externalBin` mechanism — the engine is embedded in
  the executable instead. See [§8.4](#84-embedding-the-engine-in-the-executable).)

### 2.2 Rust (the language of the shell)

The shell is ~2,200 lines of Rust. You do not need to be a Rust expert to work on it, but
you should recognise:

* `#[cfg(target_os = "windows")]` / `#[cfg(unix)]` — compile-time conditional code. This
  is how the platform abstraction works; there is no runtime dispatch.
* `Result<T, E>` and `?` — error propagation. Command errors surface to JS as a rejected
  promise carrying the `String` message.
* `Arc`/`Mutex`/`OnceLock` — shared state. Two idioms recur: a `Mutex<Option<Child>>` for
  the engine process handle, and a `OnceLock<Mutex<HashMap<…>>>` for the icon cache.
* `unsafe` — used only for Win32 and AppKit FFI, always in a small, documented function.

### 2.3 FastAPI, uvicorn, Pydantic (the engine's web layer)

**FastAPI** turns Python functions into HTTP endpoints with automatic request validation
and OpenAPI docs. **uvicorn** is the ASGI server that runs it. **Pydantic** models
(`app/schemas.py`) define every request and response body; FastAPI validates incoming JSON
against them and *strips any field not declared on the response model*.

That last behaviour has bitten this project: `TracksReadResponse.errors` carries a comment
explaining that omitting the field would silently hide unreadable files from the UI.
**If you add a response field, add it to the Pydantic model, or it will not exist.**

Handlers are declared `def` (not `async def`), so FastAPI runs them in a thread pool. That
is deliberate: `mutagen` is blocking, and this is also why `presets.py` needs a lock.

### 2.4 mutagen (the tag library)

`mutagen` is a pure-Python library that reads and writes audio metadata across container
formats. Everything format-specific in YAME lives in
`mp3-metadata-api/app/services/audio_io.py`, which wraps mutagen in a small **adapter**
per tag family:

| Adapter | Formats | Native tag store |
| --- | --- | --- |
| `Id3Adapter` | MP3, AIFF, WAV | ID3v2 frames (`TIT2`, `COMM`, `APIC`, …) |
| `Mp4Adapter` | M4A, AAC, MP4, M4B | MP4 atoms (`©nam`, `covr`, …) |
| `VorbisAdapter` | FLAC, OGG Vorbis, Opus | Vorbis comments + FLAC picture blocks |
| `ApeAdapter` | MusePack, Monkey's Audio, WavPack, TrueAudio | APEv2 items |
| `AsfAdapter` | WMA / ASF | ASF attributes — **read-only**; mutagen cannot save these |

Read support covers mutagen's full line-up. Write support is limited to ID3, MP4, Vorbis
and APEv2 containers; anything else degrades gracefully with a warning rather than
pretending it saved. Every field value in the canonical model is a **string**, and `""`
means "absent" — setting a field to `""` deletes the tag.

### 2.5 PyInstaller (turning Python into an executable)

Python programs normally need an interpreter installed. **PyInstaller** freezes a program
and its dependencies into a single executable. YAME uses **one-file mode**: the output is
one binary containing a bootloader, a compressed archive and a bundled Python runtime.

At run time the bootloader unpacks to a temporary directory and then *forks the real
server*, so the sidecar is genuinely **two processes** at run time. That single fact
explains three separate pieces of engineering in this repo:

* the Unix process-group and Windows job-object logic in `process_group.rs`;
* the parent-PID watchdog in `main.py`;
* the `com.apple.security.cs.disable-library-validation` entitlement, without which macOS
  refuses to load the unpacked `libpython` under the Hardened Runtime.

**PyInstaller cannot cross-compile.** It only builds for the interpreter it runs under, so
the Windows engine must be produced by a Windows Python and the macOS engine by a macOS
Python. This constrains the whole CI design (see [§9](#9-cicd)).

The spec file is `mp3-metadata-api/yame-engine.spec`: entry point `main.py`, a curated
`hiddenimports` list (uvicorn and anyio resolve implementations by string at run time, so
static analysis cannot see them; the `app.*` modules and the `mutagen.*` format modules
are listed explicitly), and an `excludes` list that trims `tkinter`, `unittest`, `PIL`,
`numpy` and friends. `console=False` matters on Windows: a console build opens a terminal
window titled `yame-engine` on every launch — a second window and a second taskbar entry
for what is meant to be one app.

### 2.6 Vite, Vitest, TypeScript project references (the frontend toolchain)

* **Vite** is a dev server and bundler. `pnpm run dev` serves `src/` with hot module
  replacement on port 5173; `vite build` emits static assets to `dist/`, which Tauri
  embeds into the app. Its `server.proxy` config forwards `/api` to the engine so the
  browser dev build needs no CORS configuration of its own.
* **`define`** in `vite.config.ts` performs compile-time text substitution. YAME uses it
  for `__APP_VERSION__`. Because Vitest reads `vite.config.ts` for plugins but **not** for
  `define`, the same constant is re-declared in `vitest.config.ts` — without it, importing
  the store throws `ReferenceError: __APP_VERSION__ is not defined`.
* **Vitest** is the test runner; **jsdom** supplies a DOM implementation so React
  components can be rendered in Node.
* **TypeScript project references** — `tsconfig.json` is a solution file with `files: []`
  that references `tsconfig.app.json` (the app, DOM libs, `noEmit`) and
  `tsconfig.node.json` (the config files themselves, `nodenext`). `tsc -b` builds the
  graph. The app config enables `verbatimModuleSyntax`, `noUnusedLocals`,
  `noUnusedParameters` and `erasableSyntaxOnly` — the last bans enums, namespaces and
  constructor parameter properties.
* **ESLint** is flat-config (`eslint.config.js`) and includes
  `react-refresh/only-export-components`. That rule is the reason `store-context.ts`,
  `diagnostics.ts` and `useWindowChrome.ts` exist as separate modules: a file that exports
  both a component and a plain function cannot be hot-reloaded safely.

Note that the frontend has **no runtime npm dependencies except `react` and
`react-dom`**. In particular there is no `@tauri-apps/api`: the app reads the injected
`window.__TAURI__` global directly (enabled by `withGlobalTauri: true`), which keeps the
bridge hand-written and reviewable in one file (`src/tauri.ts`).

---

## 3. Repository layout

```
YAMEmp3/
├── README.md                     user-facing overview, download and build instructions
├── YAMEmp3 Architecture.md       this document
├── LICENSE                       GPL-3.0-or-later
│
├── mp3-metadata-api/             ── THE ENGINE (Python) ──────────────────────
│   ├── main.py                   entry point: port selection, logging, watchdog, uvicorn
│   ├── pyproject.toml            dependencies; requires Python >= 3.13
│   ├── yame-engine.spec          PyInstaller spec (one-file, windowed)
│   ├── app/
│   │   ├── api.py                FastAPI app factory, CORS, foreign-origin guard
│   │   ├── fields.py             canonical field catalogue + native key mapping
│   │   ├── schemas.py            every Pydantic request/response model
│   │   ├── routers/
│   │   │   ├── audio.py          metadata, rules, preview, apply, presets endpoints
│   │   │   └── filesystem.py     /api/browse
│   │   └── services/
│   │       ├── rules.py          rule classes, registry, wildcards, ruleset runner
│   │       ├── audio_io.py       mutagen adapters, read/write/cover/rename, apply
│   │       ├── fs_browser.py     directory listing, drop expansion, dev path resolution
│   │       └── presets.py        preset JSON store, locking, normalisation, migration
│   └── tests/                    pytest suite (148 tests), audio generated on the fly
│
├── mp3-desktop-frontend/         ── THE APP (TypeScript + Rust) ──────────────
│   ├── index.html                the single HTML page
│   ├── package.json              scripts and dependencies
│   ├── vite.config.ts            dev server, /api proxy, __APP_VERSION__ define
│   ├── vitest.config.ts          jsdom test config
│   ├── tsconfig*.json            project references
│   ├── eslint.config.js          flat ESLint config
│   ├── scripts/
│   │   ├── build-sidecar.mjs     freeze the engine with PyInstaller, stage it
│   │   ├── placeholder-sidecar.mjs  zero-byte stub: an explicit "no engine staged" state
│   │   ├── cargo-test-timeout.mjs   bounded `cargo test` for CI
│   │   └── build-icon.mjs        regenerate icons from public/favicon.svg
│   ├── public/favicon.svg        the icon artwork (source of truth)
│   ├── src/                      React application (see §6)
│   └── src-tauri/                Rust shell (see §5)
│
├── .github/workflows/ci.yml      the whole CI/CD pipeline
├── ports/windows/                Windows manual QA: TESTING.md, CHECKLIST.md
├── assets/                       screenshots (main-window.png is the README image)
├── sample-mp3/,                  local test media (gitignored, not part of the tree)
│   sample-different-filetypes/
├── mp3-ui/, docs/, screenshots/  obsolete early-phase design material (gitignored)
└── ports/                        per-platform porting notes
```

Two directories are worth a warning: `mp3-ui/`, `docs/` and `screenshots/` are
**gitignored leftovers** from the Penpot design phase. They are on disk for reference
only; `mp3-desktop-frontend/src` is the real UI. The frontend README still describes the
styling as "from the Penpot board", and `theme.css` credits it — that is history, not a
live dependency.

---

## 4. The engine (Python / FastAPI)

```
mp3-metadata-api/
├── main.py            process entry: port, logging, watchdog, uvicorn
└── app/
    ├── api.py         create_app(): routers, middleware, /api/health
    ├── fields.py      canonical field catalogue
    ├── schemas.py     Pydantic models
    ├── routers/       HTTP surface
    └── services/      the actual work
```

### 4.1 Process startup and the port handshake

`main.py` is small but load-bearing. In order:

1. **Port selection** (`_pick_port`). `YAME_PORT` wins if set. Otherwise port 8000 is
   tried; if it is taken, the OS is asked for an ephemeral free port. The result is cached
   in `engine_port()` so the value used to bind is the value published.
2. **Publication** happens in the FastAPI *lifespan* hook, not at import time — so
   importing `main` or `app.api` in a test never writes to the user's config directory.
   `_publish_port` writes `<config_dir>/engine.port` and prints `ENGINE_PORT=<n>` on
   stdout. This is the contract that lets the Vite dev proxy and the Rust shell find the
   engine without hard-coding a port.
3. **Diagnostics logging** (`_log`). A packaged windowed app has no console, so anything
   printed is discarded. `_log` mirrors its lines to stdout *and*
   `<config_dir>/engine.log`, recording the port, the Python version, the PID, the parent
   PID, and a full traceback if startup fails. Logging failures are swallowed — logging
   must never break startup.
4. **Parent watchdog** (`_exit_with_parent`). If `YAME_PARENT_PID` is set, a daemon thread
   polls every 5 seconds and calls `os._exit(0)` once the parent is gone. This is the
   backstop for the case the shell cannot handle: a crash or force-quit never runs the
   shell's shutdown path, and without this the engine would linger and every later launch
   would start another one.

   The liveness probe deserves its own note. On POSIX `os.kill(pid, 0)` is a pure
   liveness check; on Windows `os.kill` calls `OpenProcess(PROCESS_ALL_ACCESS)` followed
   by `TerminateProcess` — so using it as a probe would *try to kill YAME itself* every
   five seconds. `_windows_parent_is_alive` therefore opens the process with the
   least-privileged `PROCESS_QUERY_LIMITED_INFORMATION` and checks `GetExitCodeProcess`
   against `STILL_ACTIVE`.
5. **uvicorn** runs the app on `127.0.0.1` only, wrapped so that any startup exception is
   written to the log before propagating.

### 4.2 The HTTP surface

`create_app()` in `app/api.py` mounts two routers and three pieces of middleware/health.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Self-describing endpoint index (not in the OpenAPI schema) |
| `GET` | `/api/health` | Liveness + `config_dir` + `version` |
| `GET` | `/api/browse?path=&recursive=` | List sub-folders and audio files |
| `GET` | `/api/metadata?path=` | Read one file |
| `POST` | `/api/tracks/read` | Read many files; unreadable ones go in `errors` |
| `POST` | `/api/tracks/write` | Write canonical fields, optionally `rename_to` |
| `POST` | `/api/tracks/cover` | Set (`mime` + `data_base64`) or remove (`remove: true`) artwork |
| `POST` | `/api/tracks/cover-from-file` | Embed an image already on disk (Finder drop / native picker) |
| `GET` | `/api/rules/registry` | Rule specs + field catalogue + audio suffixes |
| `POST` | `/api/preview` | Dry-run one rule against supplied field values |
| `POST` | `/api/preview-batch` | Dry-run one rule against candidates; returns the first that changes |
| `POST` | `/api/apply` | Run a ruleset over many files, **streaming NDJSON**: one `file` event per file (`dry_run` toggles writing) |
| `POST` | `/api/resolve-folder` | Dev-only: name + relative entries → absolute path |
| `POST` | `/api/resolve-files` | Dev-only: file names → absolute paths |
| `POST` | `/api/paths/expand` | Flatten a mixed file/folder selection into audio paths |
| `GET`/`PUT`/`DELETE` | `/api/presets[/{id}]` | List, upsert, delete |
| `POST` | `/api/presets/import` | Import a shared export file |

FastAPI's generated docs are live at `/docs` when the engine runs standalone — the
quickest way to explore the API by hand.

**Security note — the origin guard.** The engine is an unauthenticated local HTTP service
that can rewrite and rename files anywhere the user can write. Without protection, any web
page the user happened to have open could `POST /api/apply` and edit their library.
`_is_foreign_web_origin` blocks requests carrying an `http://`/`https://` `Origin` that is
not the app's own (the Tauri custom scheme, `localhost:5173`, `127.0.0.1:5173`). It is
deliberately narrow: requests with **no** `Origin` (curl, health checks) and non-web
schemes are left alone, so the real app can never be locked out. The middleware is added
*after* `CORSMiddleware` so it sits outside it and refuses a foreign preflight before CORS
can answer.

### 4.3 The field catalogue (`app/fields.py`)

A frozen dataclass `Field(key, label, kind, id3, id3_kind, mp4, vorbis, ape)` per concept.
`kind` is `"text"` or `"number"`. `id3_kind` distinguishes plain text frames from `COMM`
(comment) and `USLT` (lyrics), which need different handling. A field is `writable` when
at least one native key is defined for it.

Derived structures you should know:

* `RULE_FIELDS` — what the rule editors may offer. Writable tag fields first (minus the
  hidden `EXCLUDE_FROM_RULES`: `ext`, `folder_name`, `folder_path`, `sort_title`,
  `sort_artist`, `sort_album`), then the pseudo-fields.
* `RULE_FIELD_KEYS` — the set every rule validates against.
* `MUST_NOT_BE_EMPTY = {"filename"}` — an empty file name is not a file.
* `field_label(key)` — the human label used in change records.

### 4.4 The rule engine (`app/services/rules.py`)

#### 4.4.1 Wildcards

`glob_to_regex(pattern, case_sensitive, anchored)` translates a user pattern into a
compiled regex. Every `*` becomes a **capturing** group `(.*)` and every `?` a capturing
group `(.)`, so `PARSE FILENAME` can address each wildcard by group number. Regex
metacharacters and quotes are escaped. `REPLACE` compiles unanchored (it matches anywhere
in the value); `PARSE FILENAME` compiles anchored (`^…$`, matched against the whole stem
or file name).

`REPLACE` substitutes its replacement **literally** — it uses a function replacement
(`regex.sub(lambda _m: replace, before)`) precisely so that a replacement containing
backslashes or `\g<…>` is not reinterpreted by `re.sub`. Moving text between fields is
`PARSE FILENAME`'s job, not `REPLACE`'s.

#### 4.4.2 `RuleContext` — the working set for one file

Per file, the engine builds a `RuleContext` holding:

* `fields` — canonical id → string;
* `filename` — the file's name, which a rule may change (that is how renaming works);
* `parent_dir` and `path`;
* `cover_state` — `{mime, data, name}`, mutated by cover rules.

Two invariants live in `RuleContext`, and both exist because there are many routes to
violating them:

* **`set("filename", …)` refuses a blank value.** An empty name is not a valid file, so
  the write is simply dropped: covering `CLEAR`, a `WRITE` with no value, a `REPLACE`
  that matched the whole name, and a `COPY FROM` an empty source in one place. Rules may
  *rename*; they may not blank.
* **The read-only pseudo-fields ignore writes.** `stem`, `ext`, `folder_name` and
  `folder_path` are computed on read and discarded on write.

`Rule._write(ctx, key, value)` is the shared helper: it reads the value **back** after
setting it and reports the change that actually took effect. That is why a rule can never
claim a change the context refused.

#### 4.4.3 The nine rules

| Type | Parameters | Behaviour notes |
| --- | --- | --- |
| `CLEAR` | `field` (excludes `filename`) | Writes `""`, which deletes the tag |
| `REPLACE` | `field`, `find`, `replace`, `case_sensitive` | Empty `find` is a **no-op**, not a match-everything — it would otherwise splice the replacement between every character |
| `WRITE` | `field`, `value` | Fixed value; empty value clears |
| `APPEND` | `field`, `value`, `separator` | `current + separator + value` |
| `COPY FROM` | `source` (role `source`), `field` | Source may be any field including read-only pseudo-fields |
| `PARSE FILENAME` | `pattern`, `include_extension`, `assignments` | See below |
| `CHANGE CASE` | `field`, `mode` ∈ {upper, lower, title, sentence} | Hand-written casing, not `str.title()` |
| `SET COVER` | `image`, legacy `mode` | Emits a `__cover__` change record, not a text field |
| `REMOVE COVER` | — | Emits a `__cover__` "remove" record |

**`PARSE FILENAME`** matches the stem (or the full name when `include_extension` is set)
against the anchored pattern and assigns capture group *n* to a field. `assignments` is a
`{index_string: field_key}` dict produced by the frontend editor. It is defensive on
purpose: assignments targeting `filename`/`stem` are ignored (parsing a name into itself is
circular — and the exclusion list is read from the rule's *own* parameter schema so the
engine and the UI cannot drift), non-integer indices are skipped, and an index beyond the
current group count is skipped rather than raising. That last case is real: shortening a
pattern in a saved rule leaves stale assignments behind, which used to raise `IndexError`
and fail the whole request.

**Casing** is deliberately not `str.title()`. `_upper_first_letter` finds the first
*letter* in a word, so `(audio)` becomes `(Audio)` and `5seconds` becomes `5Seconds`.
`_title_case` lower-cases small words (`a`, `the`, `of`, `de`, `la`, …) except in first
position, and leaves all-caps words alone. `_sentence_case` splits on `[.!?]+\s*` and
capitalises the start of each sentence. Both are covered by tests, including the
"words with no letters at all" case.

**Cover as sequential state.** Cover rules mutate `ctx.cover_state` in order, exactly like
a field. A ruleset of `[SET COVER, REMOVE COVER]` ends with no artwork; the reverse order
ends with the image. The last rule wins. `SET COVER` deliberately ignores a missing image
(an incomplete or hand-edited preset must not be able to delete every cover in a batch);
only the explicit legacy `mode: "remove"` clears artwork. A `SET COVER` whose image
already matches the working state emits no change at all.

#### 4.4.4 Registration and the runner

`REGISTRY` is a `dict[str, type[Rule]]` populated by the `register()` decorator. **The
registration order at the bottom of the file is the order of the rule menu in the UI**, so
adding a rule means adding a line there.

`run_ruleset(ctx, rules)` walks the list, skips `enabled: False` entries and unknown types
(a preset from a newer build must not crash an older one), calls each rule's `apply`, and
stamps every change record with `rule_type` and `rule_label` so the UI can attribute each
change to the rule that caused it.

### 4.5 Audio I/O and the apply pipeline (`app/services/audio_io.py`)

#### 4.5.1 Reading

`read_track(path)` returns the `MetadataResponse` shape:

```jsonc
{
  "file":   { "path", "filename", "size_bytes", "modified_unix", "created_unix" },
  "audio":  { "duration_seconds", "bitrate_kbps", "sample_rate_hz", "channels",
              "codec", "codec_detail", "mode", "bitrate_mode" },
  "fields": { "title": "…", "artist": "…", /* every canonical id, "" when absent */ },
  "cover":  { "mime", "data_base64" } | null,
  "writable": true,
  "warnings": []
}
```

`_load` translates mutagen's errors into the project's own: a missing path raises
`FileNotFoundError` (→ HTTP 404), an unparseable file raises `MetadataError` (→ 422). That
split is what lets one bad file in a batch be reported rather than turned into a 500.

`_detect(fileobj)` returns `(adapter, save_kind)` where `save_kind` is one of `id3`,
`mp4`, `vorbis`, `ape`, `asf`, or `None`. **Read-only-ness is decided by `save_kind`, not
by a flag on the adapter** — the ASF adapter's mutators are no-ops, so `hasattr` checks
would lie. `read_track` sets `writable: save_kind in ("id3", "mp4", "vorbis", "ape")`.

Several adapters create their tag container lazily (`Mp4Adapter._tags`,
`VorbisAdapter._tags`, the ID3 path in `_detect`). A FLAC or Ogg stream may legitimately
carry no `VORBIS_COMMENT` block; without the lazy creation the write silently did nothing
while still reporting success.

Two ID3 details are worth knowing because they are easy to get wrong:

* **Reading takes only the *undescribed* frame.** iTunes and other taggers park data in
  described `COMM` frames (`iTunNORM`, `iTunSMPB`) and per-language `USLT` frames. Those
  are not the user's Comment field, so `Id3Adapter.get` looks for a frame with an empty
  `desc`.
* **Writing deletes only our own frames.** `_drop_plain_frames` avoids a blanket
  `delall("COMM")`, which would throw away gapless-playback and normalisation data that
  cannot be recovered.

`_audio_info` extracts stream properties and, where useful, humanises them from the tables
at the top of the file (`MPEG_VERSION_NAMES`, `MPEG_LAYER_NAMES`, `MPEG_MODE_NAMES`,
`MP4_CODEC_NAMES`). A malformed MP3 (`info.sketchy`) adds a warning rather than failing.

#### 4.5.2 Writing fields and renaming

`write_fields(path, fields, rename_to)` is where the safety rules live:

* Unknown canonical ids are ignored.
* Writes go through the adapter, and a per-field failure becomes a *warning*, not an
  exception — the rest of the fields still get written.
* `_save_file` applies format-appropriate options. For MP3 specifically it saves with
  `v1=0, v2_version=3`: never write ID3v1, and keep broadly compatible ID3v2.3.
* **Renaming preserves a usable extension.** `_target_name` strips a trailing dot, then:
  if the requested name ends in a *known audio extension* and it matches the file's own,
  use it verbatim; if it is a different audio extension, drop it and keep the file's own
  (renaming does not convert formats); otherwise append the file's extension. So
  "Mr. Brightside" becomes "Mr. Brightside.mp3" rather than an extensionless file that
  folder listings would no longer show.
* **Unsafe names are refused.** `_unsafe_name_reason` rejects `""`, `.`, `..`, and any
  name containing `/`, `\` or NUL. Tag values routinely contain slashes — think `AC/DC` —
  and a rule that copies one into the File Name field must never move the file out of its
  folder.
* **Collisions are refused, except case-only renames.** macOS and Windows are
  case-insensitive, so `_is_same_file` (via `Path.samefile`) distinguishes "this is the
  same file with different capitalisation" from "this name is taken".
* Everything that was refused is reported in `warnings`, and `WriteOutcome.path` is
  **where the file actually ended up** — so callers never have to guess whether a rename
  applied.

#### 4.5.3 Cover art

The 10 MB cap is enforced before reading bytes from disk, so a huge TIFF is never loaded
just to be rejected. `write_cover_from_file` snapshots the file's `st_size` first and
converts to base64 only once it is acceptable; it exists so a Finder drop or a native
picker can hand over a *path* and skip the base64 round trip through the browser.
Supported image types are PNG, JPEG, WebP, GIF, BMP and TIFF. Per format: ID3 gets an
`APIC` frame (type 3, "Cover"), MP4 a `covr` atom, FLAC a picture block, OGG/Opus a
FLAC-picture block base64-encoded in the standard `METADATA_BLOCK_PICTURE` Vorbis comment
(with the legacy `coverart` key read as a fallback), APEv2 a `Cover Art (Front)` item.

#### 4.5.4 The apply pipeline — dry run, real run, and why it streams

```
iter_apply_results(paths, ruleset, dry_run)      # a generator, one result per file
  └─ for each path (one bad file must never sink the batch):
       _apply_to_file(path, ruleset, dry_run)
         1. read_track(path)                      → current values + cover
         2. seed the context:
              fields["__has_cover__"], ["__cover_data__"], ["__cover_mime__"]
         3. run_ruleset(ctx, rules)               → in-memory mutations
         4. compute the NET effect:
              • every text field whose final value differs from the original
              • exactly ONE "__cover__" record describing the net cover change
              • a "filename" record if the name changed
         5. if not dry_run and there is anything to do:
              write_fields(...)  — tags AND the rename, together
              then cover write/remove against the path the file ACTUALLY has now

apply_ruleset(paths, ruleset, dry_run)           # list(generator) + the counts
```

**It is a generator because a batch has no useful upper bound.** `/api/apply` wraps it in
a `StreamingResponse` of newline-delimited JSON — `start`, then one `file` event per file,
then `done` with the counts — so a batch of 40,000 files behaves the same as a batch of
four: the client sees it move and bounds *silence* rather than total duration
([§6.3](#63-the-api-client-apits)). `apply_ruleset` remains as the collecting form for
callers that want one dict, which is what the service's own tests use.

Streaming also buys **real cancellation**, which a single response cannot offer: the
per-file work happens inside the generator, so a client that disconnects causes Starlette
to close it at the next `yield` and no further file is touched. It stops *between* files —
whatever was already written stays written, which is why the client reports a truncated
batch as a partial result rather than a failure
([§12.1](#121-behavioural-invariants--do-not-simplify-these-away), invariant 22).

Three further details in that pipeline are the product of bug fixes and must not be undone:

* **Cover changes are collapsed to their net effect.** Individual cover rules produce
  intermediate records; the applier reports one record for the whole ruleset, because a
  user does not want to see "set artwork, remove artwork" as two changes.
* **The cover is applied *after* the rename, to the post-rename path.** Writing fields and
  renaming happen in one `write_fields` call, so the original path may no longer exist.
* **`written` reflects reality.** A read-only format or a failed save sets `saved = False`,
  and a cover failure clears it too. Otherwise the UI would say "applied" for a no-op.

The response carries per-file `{path, filename, new_filename, error, changes, warnings,
written}` plus `total_files`, `changed_files` and `dry_run`. The dry run and the real run
go through the identical code path; the only difference is whether step 5 executes, which
is why a preview can be trusted.

### 4.6 Filesystem services (`app/services/fs_browser.py`)

* `list_directory(path, recursive)` — sub-folders and audio files, sorted by case-folded
  name. Skips hidden entries unless asked, and skips `node_modules`, `__pycache__`, `.git`
  when walking. Bounded at 5,000 directories and 20,000 files so a drop of `/` cannot hang
  the request.
* `expand_paths(paths)` — flattens what a Finder or Explorer drag hands over: folders are
  walked recursively, loose audio files pass through, everything else is returned in
  `skipped` so the UI can *say* what it ignored rather than silently dropping it.
  Deduplicates, and reports `truncated`.
* `resolve_folder` / `resolve_files` — **development-only**. A browser cannot read the
  absolute path of a folder the user picked with the OS dialog, but it does get relative
  paths, so these search the local machine for a directory whose name matches and which
  contains every reported entry. The packaged Tauri app skips this entirely and passes the
  absolute path straight from the native dialog.

`_iter_audio_files` is shared by recursive browsing and drop expansion so the two can
never disagree about what counts as an audio file.

### 4.7 Presets (`app/services/presets.py`)

Plain JSON at `<config_dir>/presets.json`:

```json
{ "version": 1,
  "presets": [ { "id": "a1b2c3d4e5f6", "name": "Clean downloads",
                 "ruleset": { "name": "Clean downloads",
                              "rules": [ {"type": "WRITE", "params": {}, "enabled": true} ] },
                 "updated_unix": 1712345678.9 } ] }
```

Details that matter:

* **A re-entrant lock guards read-modify-write.** FastAPI runs these sync handlers in a
  thread pool, so two requests really can interleave.
* **Writes are atomic.** The JSON is written to a *per-writer* temp name
  (`presets.json.<pid>.<thread-id>.tmp`) and then `Path.replace`d. The per-writer name is
  not incidental: with a shared temp path, two concurrent saves race and the loser's
  `replace` fails because the winner already moved the file.
* **`normalise_ruleset` coerces untrusted input.** Everything reaching it may come from a
  file the user was handed. Writing a malformed preset verbatim used to make every
  subsequent `GET /api/presets` fail *response* validation — the list could never load
  again, so the bad entry could not even be deleted. Import now normalises before it
  reaches disk, and `_sanitise` tolerates an out-of-shape entry on read.
* **Legacy migration.** The app shipped as "TagForge"; `_adopt_legacy_presets` copies
  `~/.config/tagforge/presets.json` into the new location once, non-destructively, and an
  existing store always wins. `TAGFORGE_CONFIG_DIR` is still honoured as an env var.

### 4.8 The engine's error model

| Situation | Behaviour |
| --- | --- |
| File missing / not a file | `FileNotFoundError` → HTTP 404 |
| Not parseable as audio | `MetadataError` → HTTP 422 |
| One file fails inside a batch | Recorded in `errors` / `error`; the batch continues |
| Write to a read-only format | Warning (`"Format is read-only; tags were not written."`), `written: false` |
| A single tag fails to write | Warning; other tags still written |
| Rename refused | Warning; the file keeps its name and the response reports the real path |
| Unknown rule type in a ruleset | Skipped |
| Unknown field id | Ignored |

---

## 5. The desktop shell (Rust / Tauri)

```
mp3-desktop-frontend/src-tauri/
├── Cargo.toml          dependencies, release profile
├── build.rs            target triple + sidecar embedding at compile time
├── tauri.conf.json     bundle identity, CSP, targets, signing
├── capabilities/default.json   the window's ACL permissions
├── entitlements.plist  macOS Hardened Runtime entitlement
└── src/
    ├── main.rs         one line: yame_lib::run()
    ├── lib.rs          the Builder chain, window creation, commands
    ├── engine.rs       sidecar supervision: port, spawn, unpack, logs, stop
    ├── process_group.rs  kill-the-whole-tree (process group / job object)
    ├── menu.rs         menu bar + context menus + the yame://menu event
    ├── platform.rs     the commands the webview calls
    ├── apps.rs         the platform-neutral "Open With" seam
    ├── macos.rs        AppKit / LaunchServices integration
    └── windows.rs      Win32 / registry / clipboard integration
```

### 5.1 Startup sequence

Everything happens in `lib.rs::run()` and its `setup` hook. In order:

1. **`tauri_plugin_single_instance` is registered first, and the ordering is
   deliberate**: it must run before `setup`, which is where the engine starts. A second
   instance exits before it spawns an engine or writes the shared port file. The handler
   un-minimises and focuses the existing `main` window instead.
2. `tauri_plugin_dialog` and `tauri_plugin_opener` are registered.
3. **`invoke_handler`** registers the eight commands (see [§5.4](#54-the-commands)).
4. **`setup` runs**:
   1. `engine::start()` — pick a free port, locate and spawn the sidecar
      ([§5.2](#52-engine-supervision)).
   2. Build an **initialization script** and hand it to the window builder:
      ```js
      window.__YAME_ENGINE__  = { origin: "http://127.0.0.1:<port>" };
      window.__YAME_PLATFORM__ = "macos" | "windows" | "linux";
      window.__YAME_VERSION__  = "<crate version>";
      ```
      This runs *before any page code*, which is the whole reason the window is built in
      code rather than declared in `tauri.conf.json` (`"windows": []` is intentionally
      empty). The frontend therefore knows where the engine is from its very first
      request and can poll it while Python starts — so the window appears instantly
      instead of waiting on an interpreter. The probe it actually loops on is
      `GET /api/rules/registry`; `/api/health` is read once afterwards for the config
      path and version.
   3. Create the window: 1280×820 (minimum 940×600), centred, title "YAME.mp3",
      **devtools on** (the app is local and offline, and the inspector is how a user reads
      the undo diagnostics when reporting a problem).
      * macOS: `TitleBarStyle::Overlay` + hidden title, so the app draws its own header
        while keeping the native traffic lights.
      * Windows: `decorations(false)` — a frameless window that keeps its Win32 resize
        border — plus
        `--disable-features=msWebView2BrowserContextMenu,msWebView2BrowserAcceleratorKeys`.
        WebView2 draws its own context menu (Back, Refresh, Print, Save as…) which no
        `preventDefault` in the page can suppress, because it is native rather than DOM.
   4. `menu::build_app_menu()` and `app.set_menu(...)`.
   5. `builder.build()` then `app.manage(engine)` — the `Engine` value becomes retrievable
      state.
5. **`on_menu_event`** forwards every menu selection to `menu::emit_selection`, which
   emits `yame://menu` with the item id.
6. **`RunEvent::Exit`** calls `engine.stop()` if the engine is managed state.

### 5.2 Engine supervision

`engine.rs` is the most important file to understand in the shell.

**Port choice.** `free_port()` binds `127.0.0.1:0` and reads back the assigned port. It is
chosen *before* the webview exists so the origin can be injected.

**Locating the binary — `sidecar_path()`, three fallbacks in order of preference:**

1. **Unpacked from this executable** (the shipped layout). `build.rs` sets the
   `embed_sidecar` cfg when `src-tauri/binaries/yame-engine-<target-triple>[.exe]` exists
   *and is non-empty*, and `include_bytes!` bakes it into the Rust binary. At startup
   `unpack_embedded_engine()` writes it to a per-user directory:
   * Windows: `%LOCALAPPDATA%\YAME\engine\<version>\yame-engine.exe`
   * macOS: `~/Library/Application Support/YAME/engine/<version>/yame-engine`
   * Linux: `$XDG_CACHE_HOME` or `~/.cache` `/YAME/engine/<version>/yame-engine`

   The version is in the path so an upgrade cannot leave a stale engine for the new app to
   run. Unpacking is skipped when a file of the same size is already there, and the write
   goes to `<name>.new` followed by a rename, so a crash mid-write cannot leave a
   half-written engine that the next launch would happily execute. `chmod 0755` on Unix.
2. **Next to the executable** (`yame-engine`, or `yame-engine.exe` on Windows) — the layout
   Tauri's `externalBin` used to produce, retained for compatibility.
3. **`src-tauri/binaries/yame-engine-<TARGET_TRIPLE>[.exe]`** — where `build-sidecar.mjs`
   stages the engine, which is what makes `tauri dev` behave like the shipped app.

Those three names come from two helpers — `engine_exe_name()` for the standalone binary and
`staged_sidecar_name(triple)` for the staged one — and they exist because the names
previously disagreed on Windows: the lookup asked for `yame-engine-<triple>` while `build.rs`
and the staging script wrote `…-<triple>.exe`. The result was not an error but a silent
fall-through, so a Windows `tauri dev` attached to a port with no engine on it. Deriving
every name in one place, plus a test that the triple-derived and `cfg!`-derived suffix rules
agree on the target being built, is what keeps that from returning.

If none is found, the shell does not fail: it assumes a developer already has an engine
running, reads the port from `YAME_PORT` or `<config>/engine.port`, and attaches
(`owned: false`, so it will not try to stop somebody else's process).

**Spawning.** `Command::new(binary)` with:

* `YAME_PORT=<port>` — the engine binds where the shell expects;
* `YAME_PARENT_PID=<shell pid>` — the engine's watchdog;
* `stdin` null, `stdout`/`stderr` piped;
* on Unix, `process_group(0)` so the whole tree can be signalled.

Both streams are drained by `forward_output` threads that print to stdout **and** append
to `<config>/engine.log`. Both, not either: stdout is what a developer sees in
`tauri dev`, and the file is what survives on a machine we cannot inspect. `note()` writes
supervisor-only lines to the same log — a launch attempt, the resolved sidecar path, a
spawn error — so that a log which ends right after the engine's own startup says something
about who was at fault. A log with *nothing* after the launch line means the sidecar never
ran at all, which is a different bug from one that ran and failed.

**Stopping.** `RunEvent::Exit` → `Engine::stop()`, which returns immediately if the shell
does not own the process. Otherwise it terminates the whole group and then reaps the
direct child so no zombie is left.

**Two failure modes worth knowing.** `free_port()` drops its listener as soon as it has
read the port, so between the probe and Python's bind another process can take it — a
TOCTOU race that answers itself with a failed launch and an `engine.log` entry. And
because the release profile sets `panic = "abort"`, an abort cannot run the shutdown path
at all: on Windows the OS closes the job handle and kills the tree anyway, but on Unix no
`SIGTERM` is ever sent — which is exactly why the sidecar carries its own
`YAME_PARENT_PID` watchdog rather than relying on the parent to clean up.

### 5.3 Process ownership (`process_group.rs`) — why "kill the child" is not enough

The PyInstaller one-file sidecar is *two* processes: a bootloader that unpacks the
archive, and the real server it forks. Killing only the process the shell spawned orphans
the server, which keeps the loopback port and keeps running after the window is gone.

Each platform has exactly one mechanism for "everything in this tree dies together":

* **Unix — a process group.** `process_group(0)` at spawn time puts the child in its own
  group; `terminate` sends `libc::kill(-pid, SIGTERM)` to the group and then `child.kill()`
  as belt-and-braces (the group may not exist, e.g. for a tested child).
* **Windows — a Job Object.** A process cannot join a job after it is running, but it
  *inherits* its parent's job, so assigning the bootloader covers the server it forks.
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes the tree die when the job handle closes —
  which the OS does even if YAME itself crashes, making this strictly stronger than
  signalling. Termination is therefore "take the handle out of the `Mutex` and drop it".

`ProcessGroup::new()` never fails the launch: an engine that runs is better than no engine,
and the parent-PID watchdog in `main.py` is the backstop. On Windows a failed assignment
prints a note (the usual cause is a CI sandbox that forbids nested jobs).

### 5.4 The commands

Registered in `lib.rs::run()`; the JS side lives in `src/tauri.ts` and `src/desktop.ts`.

| Command | Signature (JS argument names) | Purpose |
| --- | --- | --- |
| `pick_music` | `{title, prompt}` → `string[] \| null` | Native panel that allows songs **and** folders together. macOS only; `null` elsewhere so the caller falls back |
| `open_default` | `{path}` | Open with the default app |
| `open_with_app` | `{path, appPath}` | Open with a chosen application |
| `copy_files_to_clipboard` | `{paths}` → `number` | Put real *file* references on the clipboard |
| `read_files_from_clipboard` | — → `string[]` | Read file paths off the clipboard |
| `save_playlist` | `{defaultName, contents}` → `string \| null` | Native save sheet + write, one round trip |
| `show_track_menu` | `{path, x, y, selectionCount}` → `true` | Pop up the song context menu |
| `show_column_menu` | `{columns, frozen, hidden, x, y}` → `true` | Pop up the column-header menu |

Three conventions are deliberate:

* **`show_track_menu` / `show_column_menu` return `bool`, not unit.** A unit return would
  serialise to `null` either way, and the frontend could not distinguish "shown natively"
  from "no Tauri here" — so it would draw its own DOM menu on top of the native one. With
  a boolean, exactly one menu ever appears.
* **They are `async fn`.** Showing an `NSMenu` blocks the calling thread inside AppKit's
  tracking loop, and a *synchronous* Tauri command runs on the main thread — the very
  thread that has to service that loop. The same reasoning applies to `save_playlist`
  (a modal `NSSavePanel` on the main thread deadlocks against the event loop) and to
  `open_default` (which shells out and would freeze the window).
* **Platform work is `cfg`-dispatched inside the command**, so the frontend sees one
  command per capability regardless of OS.

### 5.5 Menus (`menu.rs`)

Menus are real native menus (`NSMenu` on macOS, the Win32 menu on Windows), which is what
gives them the platform's highlighting, keyboard navigation and submenu behaviour.

**The menu bar**, built once at startup:

| Platform | Structure |
| --- | --- |
| macOS | **YAME** (About · Copy diagnostics · Services · Hide · Hide Others · Show All · Quit) · **File** (Open Files… ⌘O, Add Files… ⇧⌘O) · **Edit** (Undo ⌘Z, Redo ⇧⌘Z, Cut/Copy/Paste/Select All) · **View** (Search ⌘F) · **Window** (Minimize, Maximize, Close) |
| Windows / Linux | **File** (Open Files… Ctrl+O, Add Files… Ctrl+Shift+O, ─, Exit) · **Edit** (Undo, Redo, ─, Cut/Copy/Paste/Select All) · **View** (Search Ctrl+F) · **Help** (About YAME.mp3 · Copy diagnostics) |

Design notes:

* macOS renders the first submenu as the bold application menu, so it gets the
  About/Services/Hide/Quit group; Windows has no such concept, so `Exit` goes at the foot
  of File and About goes under Help.
* About is the *app's own* dialog on Windows rather than `PredefinedMenuItem::about`,
  whose OS dialog is a bare message box with no version and no config path.
* **Undo/redo accelerators are declared on macOS only.** A native menu accelerator and the
  page's key handler are two independent delivery paths for one keystroke, and
  `preventDefault` in the page cannot cancel a native menu. macOS needs the accelerator
  (it is the only path that works there). Windows needs the page handler (it is what stops
  WebView2 running its own per-field undo), so leaving the accelerator on as well
  dispatched the action **twice per press** and the second delivery ate a history step —
  which is exactly the "I have to press Ctrl+Z twice" bug. `only_macos_binds_the_edit_shortcuts`
  is a unit test guarding this.
* `menu_text` escapes `&` by doubling it, because both platforms treat the character after
  `&` as a mnemonic and drop the `&` itself — an application called "R&B" would render
  as "RB".

**The song context menu**, built on demand: `Open` · `Open With ▸` · `Copy [N Songs]` ·
`Paste` · `Remove from List` · `Show in Finder`/`Show in Explorer`. The Open With submenu
is built from `apps::recommended_apps(path)` with `apps::app_icons(...)`; when a platform
can name no applications, the submenu is replaced by a single `Open With…` entry that
routes to that platform's own chooser — losing the feature entirely would be worse than a
shorter menu. Item ids are `openwith:<absolute app path>` for an application and
`openwith.other` for the picker.

**The column menu**: `Freeze Column`/`Unfreeze Column`, then a ticked list of columns to
show/hide (`col.freeze`, `col.toggle:<key>`). The tick glyph is padded with three spaces on
macOS and five elsewhere, because that is the local convention for the blank column.

**Every selection becomes one event**: `app.emit("yame://menu", id)`. The frontend turns
ids back into actions in `useMenuEvents.ts`, and column ids go to the table first. This
single funnel is why the menu bar and both context menus share one routing table.

### 5.6 The platform seam (`apps.rs`, `macos.rs`, `windows.rs`)

`apps.rs` exists so `menu.rs` never contains a `cfg`. Each platform module exposes the same
three things: `AppChoice {name, path}`, `recommended_apps(path)`, and
`app_icons(app, paths)`; `is_application(path)` is a fourth shared function.

| | macOS (`macos.rs`) | Windows (`windows.rs`) | Linux |
| --- | --- | --- | --- |
| Recommended apps | `NSWorkspace.URLsForApplicationsToOpenURL` — the same list Finder's Open With shows | Registry: `<ext>\OpenWithList` and `<ext>\OpenWithProgids` under `HKCR` and `HKCU`, ProgIDs resolved through `shell\open\command` and `App Paths` | Empty list (honest: there is no standard answer) |
| Menu icons | Yes — `NSWorkspace.iconForFile` drawn into a 64×64 RGBA bitmap | No — Tauri cannot put icons on Windows menu items | No |
| Opening a file | `open <path>` | `ShellExecuteW("open", …)` | `xdg-open` |
| Open with a chosen app | `open -a <bundle> <file>` | `SHOpenWithDialog` (always present in the list as "Choose another app") | **Not implemented** — returns a clear error |
| Copy files | JXA/ObjC script writing an `NSArray` of `NSURL`s to the pasteboard | `CF_HDROP`: a hand-built `DROPFILES` header + double-NUL-terminated UTF-16 list | **Not implemented** — `TODO(linux)` |
| Read files | JXA reading `public.file-url` off the pasteboard | `IsClipboardFormatAvailable(CF_HDROP)` + `DragQueryFileW` | **Not implemented** |
| Mixed file-or-folder panel | `NSOpenPanel` with `setCanChooseFiles(true)` + `setCanChooseDirectories(true)` — the reason for talking to AppKit at all | Falls back to the dialog plugin's folder picker | Same fallback |

Cross-cutting macOS notes:

* **Everything AppKit runs on the main thread.** `on_main` hops there via
  `app.run_on_main_thread` and waits on an `mpsc` channel. Modal panels must not be created
  anywhere else.
* **Icons are rasterised, not PNG-encoded.** `render_icon` draws straight into a small
  bitmap. Flattening `NSWorkspace`'s multi-resolution image cost ~300 ms and 1–2 MB per
  application — far too slow while a context menu is opening, so a menu build went from
  2.5 s to ~60 ms. Results are cached in a `OnceLock<Mutex<HashMap<…>>>`, so only the first
  right-click of a session pays.
* `is_application` requires a `.app` *directory*.

Cross-cutting Windows notes:

* **Never route through `cmd /C start` or `rundll32`.** A shell expands `%VAR%` and has
  quoting rules of its own, so a file named `100% Pure.mp3` would open the wrong thing —
  and `cmd` flashes a console. `ShellExecuteW` and `SHOpenWithDialog` take proper UTF-16
  arguments.
* **The registry list is best-effort by design.** Windows 10/11 keep most per-user choices
  and every packaged app outside the classes hive, so the list is often short. That is why
  "Choose another app" is always appended.
* **`CF_HDROP` memory ownership**: allocated `GMEM_MOVEABLE`, handed to the clipboard,
  which takes ownership on success — freeing it afterwards would corrupt the clipboard, so
  only the failure path cleans up.
* `is_application` accepts `.exe`, `.lnk`, `.bat`, `.cmd` (the `.lnk` case lets a user pick
  a Start-menu entry the Open With dialog offered).

**Windows tests deliberately do not call `SHOpenWithDialog` or `ShellExecuteW`.**
`SHOpenWithDialog` does not validate its path before showing, so "call it with a missing
file and assert an error" does not merely fail on a headless runner — it *blocks forever*
waiting for someone to click. That hung a CI runner for 40 minutes. Their arguments are
covered by the pure helpers (`extension_of`, `executable_from_command`, `resolve_prog_id`);
the dialogs themselves need a human, which is what `ports/windows/CHECKLIST.md` is for.

### 5.7 Window chrome

The window is frameless on Windows and overlay-titled on macOS, and the app draws its own
header. `applyHostClass()` in the frontend toggles `host-tauri` plus exactly one of
`host-macos` / `host-windows` / `host-linux` on `<html>`, and the CSS keys off those.

* macOS keeps its **native traffic lights**; the header leaves room for them.
* Windows and Linux get **custom caption buttons** (`WindowControls.tsx`: minimise,
  maximise/restore, close) drawn as hand-made SVG rather than the Segoe MDL2 icon font,
  and a grey title bar. `useWindowChrome` wires mousedown-to-drag (excluding
  `button, input, a, .no-drag`), double-click-to-maximise, and an `onResized` subscription
  so the restore icon stays correct when the user maximises by dragging to an edge — which
  happens outside React.

### 5.8 Security posture of the shell

* **CSP** (production): `default-src 'self'; img-src 'self' data: blob:; style-src 'self'
  'unsafe-inline'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost
  http://127.0.0.1:* http://localhost:*`. The dev CSP additionally allows
  `'unsafe-inline' 'unsafe-eval'` for scripts and a `ws://localhost:5173` websocket for HMR.
* **Capabilities** (`capabilities/default.json`) grant the `main` window only:
  `core:default`, window `start-dragging` / `minimize` / `toggle-maximize` / `is-maximized`
  / `close`, `dialog:allow-open`, `opener:allow-reveal-item-in-dir`. Nothing else is
  reachable from the page.
* **Entitlements** (`entitlements.plist`): exactly one key,
  `com.apple.security.cs.disable-library-validation`, explained in
  [§8.6](#86-macos-signing-and-entitlements).

---

## 6. The frontend (React / TypeScript)

```
mp3-desktop-frontend/src/
├── main.tsx               React root; applyHostClass() then render
├── App.tsx                layout and top-level hooks
├── env.ts                 platform/origin detection, apiBase(), appVersion()
├── api.ts                 the engine HTTP client
├── tauri.ts               the window.__TAURI__ bridge
├── desktop.ts             OS integration with browser fallbacks
├── types.ts               mirrors the engine's JSON contract
├── rules.ts               rule display helpers (defaults, summaries, captures)
├── store.tsx              the entire application state (1127 lines)
├── store-context.ts       the Store interface + useStore()
├── diagnostics.ts         the undo/redo delivery log
├── utils.ts               path and formatting helpers
├── pickers.tsx / pickers-helpers.ts   hidden browser file inputs (dev fallback)
├── useKeyboardShortcuts.ts / useMenuEvents.ts / useNativeFileDrop.ts / useWindowChrome.ts
├── theme.css / index.css / App.css
├── components/            15 components (below)
└── test/                  api-stub, tauri-mock, setup, env.test
```

### 6.1 Toolchain and scripts

See [§2.6](#26-vite-vitest-typescript-project-references-the-frontend-toolchain) for what
Vite, Vitest and the tsconfig split are. The scripts in `package.json`:

| Script | Command | Use |
| --- | --- | --- |
| `dev` | `vite` | Dev server on :5173 with HMR |
| `build` | `tsc -b && vite build` | Type-check the project graph, then emit `dist/` |
| `lint` | `eslint .` | Lint |
| `test` | `vitest run` | Unit tests, once |
| `test:watch` | `vitest` | Unit tests, watch mode |
| `check` | `tsc -b && eslint . && vitest run` | **The ~6-second pre-push check.** Use this most |
| `preview` | `vite preview` | Serve the built bundle |
| `sidecar` | `node scripts/build-sidecar.mjs` | Rebuild just the frozen engine |
| `sidecar:placeholder` | `node scripts/placeholder-sidecar.mjs` | Write the zero-byte stub (not required to compile) |
| `tauri` | `tauri` | CLI passthrough |
| `desktop:dev` | `tauri dev` | The real window against the dev server |
| `desktop:build`, `package` | `node scripts/build-sidecar.mjs && tauri build` | **Identical.** Full app build |
| `icon` | `node scripts/build-icon.mjs` | Regenerate the app icon from `public/favicon.svg` |

The `__APP_VERSION__` define is the only compile-time constant the app relies on. In the
packaged app the shell's injected `__YAME_VERSION__` takes precedence (the About box is
opened exactly when something is wrong, possibly including the engine being down).

### 6.2 Boot sequence

`index.html` is minimal: a `<div id="root">` and a module script tag. There is no inline
bootstrap JavaScript.

1. `main.tsx` calls **`applyHostClass()` before React mounts**. It reads the injected
   globals and toggles the `host-*` classes on `<html>`, so CSS can lay out the window
   chrome correctly on the very first paint.
2. `createRoot(...).render(<StrictMode><StoreProvider><App/></StoreProvider></StrictMode>)`.
   StrictMode double-invokes render and effects in development; a few store comments call
   out places where that previously broke sorting.
3. `App.tsx` calls `init()` in an effect, installs `useNativeFileDrop()` and
   `useKeyboardShortcuts()`, and lays out `TitleBar → (RulesSidebar | (TrackTable,
   StatusBar, DetailPanel))` plus the conditionally-rendered `EditTrackOverlay` and the
   always-mounted `ApplyReviewModal`, `PickerInputs` and `Toast` (each self-nulls).

The globals Rust injects — and the ones Tauri injects — are declared in `env.ts`:

| Global | Set by | Meaning |
| --- | --- | --- |
| `window.__YAME_ENGINE__` | Rust init script | `{origin}` of the running sidecar |
| `window.__YAME_PLATFORM__` | Rust init script | `"macos"`, `"windows"` or `"linux"` |
| `window.__YAME_VERSION__` | Rust init script | The shell's build version |
| `window.__TAURI__` | Tauri (`withGlobalTauri: true`) | `core.invoke`, `dialog`, `opener`, `event`, `window`, `webviewWindow` |
| `window.__TAURI_INTERNALS__` | Tauri | Presence is how `isTauri()` is answered |

Platform is read from the injected value rather than sniffed from the user agent,
deliberately: in a webview the user agent lies — WebKit on macOS reports "Macintosh",
WebView2 reports "Windows NT" — and a wrong answer changes window chrome and wording.

### 6.3 The API client (`api.ts`)

The client has **two timeout policies, because there are two kinds of call.** Everything
except a batch apply goes through one generic `request<T>(path, init?)`:

* calls `fetch(apiBase() + path)`;
* **aborts the call after 60 seconds** and reports it as a timeout;
* rewraps any other network failure as `Error('Cannot reach the YAME engine. Is it
  running?', { cause })`;
* on a non-2xx, prefers the JSON `detail` field and falls back to `status statusText`;
* parses JSON on success.

`apiBase()` returns `window.__YAME_ENGINE__.origin` (trailing slashes stripped) + `/api`
when the shell injected it, otherwise the root-relative `/api` that the Vite proxy
resolves. The absolute form is required in the packaged app because the webview is loaded
from `tauri://localhost`, where a root-relative `/api` would resolve inside the webview
instead of reaching the engine.

**The 60-second budget for ordinary calls** (`REQUEST_TIMEOUT_SECONDS`) exists because its
absence is not a graceful failure: a request to a wedged engine simply stayed pending, so
the UI stopped responding with nothing to show the user. Two implementation details are
deliberate:

* It uses an **`AbortController` plus `setTimeout`**, not `AbortSignal.timeout()`. The
  latter is Safari 16+, and the macOS build supports 10.15, whose WKWebView predates it —
  using it would make *every* request fail on older macOS rather than merely going
  unbounded. The distinction between "timed out" and "unreachable" is carried by a flag
  rather than an abort reason, for the same compatibility reason.
* The timer is cleared in a `finally`, so a successful call leaves nothing pending. One
  live 60-second timer per request would otherwise accumulate for the life of a session.

The two messages are worth keeping apart because they suggest different fixes: a timeout
means *retry*, an unreachable engine means *the engine is not running*.

The other resilience in the system is `store.init()`'s startup retry loop (30 seconds,
backoff `min(250 × attempt, 1500)` ms), which exists because the packaged sidecar takes a
moment to come up. A refused connection fails instantly, so the loop still spins quickly;
the timeout only bites if something is listening and not answering.

#### 6.3.1 A batch apply has no total budget — it bounds silence instead

`api.apply()` does **not** use the 60-second budget, because no fixed number can be right
for it. The cost of a batch is proportional to the files in it — at roughly 7 ms per file
on a fast local disk, 60 seconds is comfortable for a few thousand files and wrong for
50,000, and it is wildly wrong for large FLACs with embedded artwork on a slow external
drive. Any number large enough for the worst case would be useless as a hang detector for
the common one.

So the bound moved to the *gap between events*. `/api/apply` streams one event per file
([§4.5.4](#454-the-apply-pipeline--dry-run-real-run-and-why-it-streams)), and
`STREAM_IDLE_TIMEOUT_SECONDS` (60) is armed on the first byte and re-armed on every chunk
thereafter. Consequences worth understanding:

* A batch of any size may run as long as it keeps producing results. The only thing that
  trips the timeout is a minute of *silence*, which no single file legitimately needs.
* Progress is a by-product, not a separate feature: `onProgress` receives `{done, total}`
  and the UI shows it ([§6.5](#65-state-storetsx--store-contextts)).
* The engine's `start` event is emitted before any file is touched, so the first-byte gap
  is bounded by the same 60 seconds rather than by a whole batch.

A truncated stream is **never reported as success**. If the events stop without a `done`,
the client raises *"The engine stopped before the batch finished. N of M file(s) were
processed — check them before retrying."* The files that did land are already written, so
"the request failed" and "nothing changed" are not the same statement, and the message says
so. Operation-level failures are also distinguished from transport ones: the engine's own
400s (no paths, no rules) arrive as JSON before the stream starts and are surfaced verbatim.

#### 6.3.2 The buffered fallback

Reading a response incrementally needs `Response.body`, which is Safari 14.1+ — and the
declared macOS minimum is 10.15. Rather than let a batch apply break outright on an older
webview, `canStreamBody()` feature-detects it and `readBuffered()` reads the whole body in
one go. That path has no progress to prove it is alive, so it gets the batch-scaled budget
that the streaming path does not need:

```
min(1 hour, 60s + 500ms × files)
```

The per-file allowance is deliberately generous (a large file can take hundreds of
milliseconds), and the cap exists because on this path "still working" and "wedged" cannot
be told apart — an hour is where we stop guessing in the user's favour. The fallback is
also what keeps the app working at all on such a webview, which is the same reasoning
behind avoiding `AbortSignal.timeout()` above.

#### 6.3.3 An interface newer than its engine

The stream is a protocol change, and a protocol change has two sides. Nothing guarantees
they match: `pnpm run desktop:dev` runs whatever engine is already staged in
`src-tauri/binaries/` **and does not rebuild it**, and the shell attaches to an
already-running engine when it finds no binary ([§5.2](#52-engine-supervision)). A new
interface talking to an older engine is therefore a normal state of affairs, not a
corrupted install.

The older engine answers `/api/apply` with one JSON object holding every result. The
client recognises that envelope (`olderEngineResponse`) and **uses it**: the batch is
perfectly good, only the progress reporting is missing, and a working apply must not be
reported as a failure because of how it was framed. A `console.warn` names the mismatch so
it does not stay invisible to whoever can fix it.

This was learned the hard way. The first version of this code saw zero recognised events,
concluded the batch had been cut short, and reported *"0 of 0 file(s) were processed"* —
which blames the user's files for a protocol mismatch, and is the most confusing possible
way to report it. Two guards now exist:

* the older envelope is accepted (above);
* if the body is recognised as *neither* shape, the error names the real problem —
  *"The YAME engine did not answer the way this version of the interface expects. Quit and
  reopen YAME…"* — and the "stopped before the batch finished" message is reserved for the
  case it describes, where events *were* seen and the stream then ended early.


### 6.4 The desktop bridge (`tauri.ts`, `desktop.ts`)

`tauri.ts` is a typed, dependency-free accessor over `window.__TAURI__`. Every function
returns `null`/`false` outside Tauri so callers can fall back to browser behaviour:

* `invoke<T>(cmd, args)` → `core.invoke`, or `null`;
* `pickPaths(options)` → `dialog.open`, flattening a single string to an array and `null`
  to `[]`;
* `revealItemInDir(path)` → `opener.revealItemInDir`;
* `pickMusicSelection(title, prompt)` → `invoke('pick_music', …)`;
* `listenForMenu(handler)` → `event.listen('yame://menu')`, returning an unlisten function;
* `listenForFileDrops(handler)` → `webviewWindow.getCurrentWebviewWindow().onDragDropEvent`,
  with a fallback to four `event.listen('tauri://drag-' + phase)` subscriptions for
  `enter|over|drop|leave`. Only the final `drop` carries absolute paths.

`desktop.ts` layers graceful degradation on top, which is what lets `pnpm run dev` exercise
the whole UI in a plain browser:

| Function | Packaged | Browser |
| --- | --- | --- |
| `pickMusicPaths` | native mixed panel, else the dialog plugin | returns `null` → hidden `<input>` folder picker |
| `pickApplication` | native picker (starting in `/Applications` on macOS) | `null` |
| `openWithDefault` | `invoke('open_default')` | throws `'… is available in the packaged YAME app'` |
| `copyFiles` | native file clipboard | copies the paths as **text** |
| `pasteFiles` | native file clipboard | reads clipboard *text*, keeps lines containing a path separator, reduces them to basenames, and asks the engine's `/resolve-files` |
| `revealPath` | opener plugin | throws, with the platform's file-manager name in the message |
| `savePlaylistFile` | `invoke('save_playlist')` | `null` → the caller downloads a Blob |

### 6.5 State (`store.tsx` + `store-context.ts`)

There is **no state library**. One context provider holds everything, with `useState` for
values and `useCallback` for actions. `store-context.ts` holds the `Store` interface, the
`SortKey` union, `BuilderDraft`, `ToastState`, `ConfirmRequest`, the context object and
`useStore()`, which throws if used outside the provider. The split is required by
`react-refresh/only-export-components`.

**State shape** (all in the provider):

* data: `registry`, `presets`, `activePresetId`, `tracks`, `folderPath`, `configDir`;
* status: `loadingTracks`, `engineError`, `engineStarting` (initially `true`), and two
  internal values not exposed on the context — the engine's `version` and the shell's
  `appVersion`;
* view: `selectedPaths`, `search`, `sortKey` (`null` = natural folder order), `sortDir`;
* authoring: `ruleset`, `draft`;
* overlays: `dragOver`, `editTrackPath`, `applyReview`, `applying`, `toast`,
  `confirmRequest`.

**Mirror refs.** `tracksRef` and `selectionRef` mirror the state. `setTracks` and
`setSelectedPaths` push a closure onto `pendingMirrors` and flush it in a **microtask**,
which lands exactly after React has committed what is queued and before the next event.
This is what makes a history step hold the *pre*-action list at the moment it is recorded
and the *post*-action list by the time the next action runs. An effect-based version
passed locally and failed in CI, which is why the timing is explicit.

**Undo/redo.** Three rules, documented at the top of the relevant block: only edits are
undoable; one edit is one step; focus decides which history.

* `sameTrack` / `sameList` compare path, cover (`mime` + `base64`) and fields **by value**,
  never by object identity — the engine hands back fresh objects for the same file. An
  earlier path-only comparison made edits look like no-ops, so they could not be undone and
  two different states of one file collapsed into a single history step. There are
  regression tests for exactly this.
* `recordEdit(snapshot, touched)` drops a step identical to the one already on the stack,
  caps history at **50** steps, and clears the redo branch. It compares against the
  previous *step*, not the live list: at that moment the live list is the array the action
  is about to replace, so comparing against it would ask whether a value equals itself.
* `restore(step)` is **synchronous** — nothing is fetched — because an earlier version
  re-read the files and the user felt the round trip as lag on every press. But undo must
  actually *undo*: it diffs the step's fields against the current ones, POSTs **only the
  differing keys** (a rule that touched one field must not rewrite the other twenty-four),
  sends a separate cover write/remove when artwork differs, and `Promise.allSettled`s them.
  A failure there means the row and the file now disagree — the one outcome the user cannot
  see for themselves — so it raises an error toast: *"Reverted here, but the file could not
  be written: …"*.
* `settling` is a ref, set during a restore and cleared through `queueMirror`. A duplicate
  delivery of one keystroke arrives before the first has committed, so the two are
  indistinguishable by state; ignoring anything until the next commit discards the
  duplicate and can never discard a deliberate second press, because a person cannot press,
  press again inside one render.
* `undo`/`redo` first route to `document.execCommand('undo'|'redo')` when focus is in an
  input, textarea or contentEditable — that drives the *field's* own history. Then they
  record a diagnostics entry, return early while `settling`, and skip steps that would not
  change the list.
* The **first load records nothing**. There is nothing before it to return to, and undo
  must never be able to empty the window.

**Applying.** `startApply` targets the selection, or every track when nothing is selected,
requires at least one enabled rule, calls `POST /api/apply` with `dry_run: true`, and
stores the response in `applyReview`. `ApplyReviewModal` renders it. `confirmApply` calls
apply again with `dry_run: false`, records **the whole batch as one undo step** (the last
action was a batch, so undo reverses a batch), then re-reads only the files reported
`written` and rebuilds the list — mapping renamed rows through
`joinPath(dirOf(r.path), r.new_filename)` and synthesising a row when the re-read missed.

**Other action groups**: loading (`loadFolder`, `replacePaths`, `appendPaths`,
`importPaths` — which always goes through `/paths/expand` and warns on truncation);
selection (`toggleSelect`, `selectRange`, `setSelection`, `clearSelection`); sorting
(`cycleSort`); rule authoring (`setDraft`, `updateDraftParam`, `updateDraftType`,
`cancelDraft`, `commitDraft`, `removeRule`, `toggleRule`, `reorderRules`); writes
(`writeFields`, `setCover`, `setCoverFromFile`, `removeCover`); presets (`savePreset`,
`loadPreset`, `deletePreset`, `importPresets`); and feedback (`showToast`, `confirm`,
`showAbout`, `copyDiagnostics`).

Note two behaviours a newcomer will otherwise trip over:

* Live rule editing writes through to the *live rule* as well as the draft, so
  `cancelDraft` has to restore both `params` and `type` (hence `originalParams` /
  `originalType` on `BuilderDraft`).
* `activePresetId` is cleared on **structural** changes only. Editing a parameter or
  toggling a rule leaves the preset id pointing at a preset the ruleset no longer matches.
  Dirty state is not tracked centrally at all; each editor computes its own.

`confirm()` replaces `window.confirm`, because a Tauri webview can return `false` without
drawing anything — which would make a destructive action silently do nothing. The provider
renders `<ConfirmDialog>` itself, so it is impossible to ask for a confirmation that has
no dialog mounted. `showToast` uses a monotonically increasing id so a stale dismiss timer
cannot clear a newer toast.

### 6.6 Rules in the UI

* `RulesSidebar` builds the "New rule" menu from `registry.specs` and is disabled while no
  tracks are loaded — rules preview against real files, so authoring without any would be
  meaningless.
* `RuleBuilder` finds the spec with `specFor(...)` and maps `spec.params` to a
  `<ParamEditor>` per `kind`: `field`/`choice` become selects, `text`/`separator` text
  inputs, `bool` a checkbox, `image` an `ImageParamEditor` (10 MB cap, thumbnail, Clear),
  `parse_pattern` the `ParsePatternEditor` (pattern field plus one field-picker per
  capture). `include_extension` is filtered out of the generic loop and rendered by the
  pattern editor.
* `draftProblem(registry, params, values)` is the commit gate: it returns the reason the
  rule cannot be committed yet (the button stays disabled and shows it as a tooltip). It
  blocks literal-empty values aimed at a `must_not_be_empty` field and enforces the
  per-kind `required` flags.
* **Live preview** debounces 350 ms and POSTs up to 20 candidates — the selected tracks in
  table order, then `tracks[0]`, de-duplicated — to `/api/preview-batch`. The engine
  returns the first candidate that actually changes, which is the point: with many tracks
  selected, previewing the first *selected* track is often a track the rule does not
  affect at all.
* `RuleCard` shows `describeRule(...)`, an enable/disable toggle, a remove button, and
  click-to-edit (which snapshots the params). Reordering uses HTML5 drag-and-drop carrying
  the rule id; array order **is** execution order.

`rules.ts` contains only display helpers. Its `selectableFields` is what enforces the
field-picker rules: drop anything in `param.exclude`, and for `role !== 'source'` keep only
`writable` fields. That is how `CLEAR` is denied the file name and `PARSE FILENAME` is
denied both name fields.

### 6.7 The track table (`TrackTable.tsx`)

The trickiest component in the app, because it implements frozen columns.

**Rendering is plain HTML tables — there is no virtualisation — and there are two of
them.** `.table-scroll` is the single scroll container; inside it a `frozen-pane` table and
a `main-pane` table each render the *entire* visible row list, so every row exists twice in
the DOM. The panes are kept aligned by shared width arithmetic (`frozenWidth`,
`totalWidth`) and a `hoveredPath` state, because CSS `:hover` cannot span two tables. The
pinning itself is CSS: `.tracks thead { position: sticky; top: 0 }` and
`.tracks.frozen-pane { position: sticky; left: 0; z-index: 7 }`, with
`table-layout: fixed` and per-column inline widths.

**Column state** — `{order, frozen, hidden, widths}` — is persisted in
`localStorage['yame.columns.v1']` (with a one-time read of the pre-rebrand
`'tagforge.columns.v1'`), validated element-wise on load so a corrupt value cannot break
the table. Freeze is per column (default: `filename`). Hiding preserves the frozen flag.
Reordering refuses to move a column across the frozen boundary. Resizing is pointer-based
with `setPointerCapture`, clamped to 40–900 px. Column drag-and-drop adds window-level
`dragover`/`drop` listeners while a drag is in flight so a drop beyond the table edges maps
to "before first" / "after last", and `normalizeInsertion` collapses every gap to one
canonical form so only a single insertion indicator is ever drawn.

**Sorting and filtering.** A header click calls `cycleSort`, which toggles direction on the
same key and otherwise sets key + direction. The visible list filters on whitespace-split
AND terms across filename, title, artist, album, album_artist, genre, composer and comment,
then sorts numerically for duration and size and with
`localeCompare(..., {numeric: true, sensitivity: 'base'})` otherwise. `sortKey === null`
preserves folder order, which is the state a fresh load starts in.

**Selection.** Cmd/Ctrl-click toggles one row additively. Shift-click computes a range from
an anchor over the **visible** list and *replaces* the selection with it (so shift-clicking
can shrink the selection). A plain click on an already-exclusive selection clears it. A
window-level key handler provides Cmd/Ctrl+A (select all visible), Cmd/Ctrl+C (copy files),
Cmd/Ctrl+V (paste and import), Backspace/Delete (remove the selection as **one** undoable
step) and Up/Down (move a single-row selection and `scrollIntoView({block: 'nearest'})`).
Document-level `copy`/`paste` handlers route by focus, so a text field keeps its own
behaviour and the list copies files; a pasted clipboard *image* is left alone so the cover
handlers can win.

**Editing** is not inline here: double-click opens `EditTrackOverlay`. Inline field editing
lives in `DetailPanel`.

**Context menus.** A right-click calls
`invoke('show_track_menu', {path, x, y, selectionCount})`. A result that is not `true`
(browser dev, or a failed call) renders the DOM `.row-menu` fallback, so exactly one menu
ever appears. Header right-click calls `invoke('show_column_menu', …)` with a DOM
`.freeze-menu` fallback; the native ids (`col.freeze`, `col.toggle:<key>`) come back
through `useMenuEvents` into the table's `handleColumnMenu`. Both DOM menus close on
outside mousedown, resize, or a capture-phase scroll.

**Browser-dev drops** are a separate path: `webkitGetAsEntry` walks the dropped directory
tree (browsers hide absolute paths), then `/resolve-folder` and `/resolve-files` locate it
on disk. Audio detection uses `registry.audio_suffixes` with a hard-coded fallback set.

### 6.8 The remaining components

| Component | Responsibility |
| --- | --- |
| `TitleBar` | Wordmark, Open/Add/Create-playlist/Help buttons, the `#yame-search` input, platform-correct shortcut tooltips, mousedown-to-drag, double-click-to-maximise |
| `WindowControls` | Minimise / maximise-restore / close; rendered only when `isTauri() && hostPlatform() !== 'macos'` |
| `RulesSidebar` | New-rule menu, `RuleBuilder`, rule cards, presets, the Apply button |
| `RuleBuilder` | Schema-driven rule editor with live preview and the commit gate |
| `RuleCard` | One rule's summary, enable toggle, remove, click-to-edit, drag handle |
| `TrackTable` | The two-pane track list (above) |
| `DetailPanel` | Floating panel for the first selected track: four inline fields (title/album/artist/comment; commit on blur, Enter saves, Esc reverts) and a cover button accepting click, drag and paste |
| `EditTrackOverlay` | The full editor: draft fields, a `dirty` memo, guarded close behind a destructive confirm, draggable/resizable geometry clamped to the viewport, basic fields plus a collapsible advanced grid and read-only stream properties, filename rename passed as `renameTo`, cover choose/remove. Save is disabled and the button reads "Read-only format" for a non-writable track |
| `ApplyReviewModal` | The dry-run review: per-file `label before → after` (empty shown as `(empty)`), error rows, an empty state, a "N files left unchanged" note that excludes errored files, and an Apply button disabled while applying or when nothing changed |
| `PresetManager` | Modal preset list with per-row and bulk export (`.yame.json`), import from a JSON file, and delete behind the real confirm dialog; footer shows the config directory |
| `ConfirmDialog` | Promise-based replacement for `window.confirm`: focus trap, Escape/backdrop resolve false, exactly-one-resolution guard, focus restored to the opener, single-button mode when `cancelLabel` is null |
| `SavePresetModal` | Name field autofocused and selected on the next frame; Enter saves, Escape closes |
| `StatusBar` | Selection/total counts, summed duration and size |
| `Toast` | One transient message, kind as a class |
| `MusicArt` | Shared empty-cover placeholder image |

### 6.9 Hooks

* **`useKeyboardShortcuts`** — a window keydown listener in the **capture** phase (the
  earliest point the page can intervene) plus a capture-phase `contextmenu`
  `preventDefault`, which suppresses the webview's native menu while still letting React's
  own bubble-phase handlers run. `Cmd/Ctrl+F` always focuses *this app's* search bar, even
  when focus is already in a text field — returning early there let WebView2 open its own
  find bar. `Cmd/Ctrl+O` opens and `Shift+O` adds, but returns early on macOS where the
  menu accelerators already did it (otherwise two pickers open). `Ctrl+Z`/`Shift+Z`/`Ctrl+Y`
  undo/redo only off macOS, because WebView2 claims `Ctrl+Z` for its own per-field history.
* **`useMenuEvents(onColumnMenu, focusSearch, menuTarget)`** — one long-lived subscription;
  state is read through a `latest` ref refreshed every render, because the listener is
  registered once. It resolves the action target as `menuTarget.current ?? selectedPaths[0]`
  (so right-clicking row 3 of a multi-selection acts on row 3, not row 1), delegates `col.*`
  ids to the table, then switches over the ids listed in [§5.5](#55-menus).
* **`useNativeFileDrop`** — `enter`/`over` set `dragOver`; on `drop`, it converts the
  physical-pixel position to CSS pixels via `devicePixelRatio` and
  `document.elementFromPoint(...).closest('[data-cover-drop]')`. A single dropped image on
  a cover target becomes `setCoverFromFile` for the track being edited or the sole selected
  track; anything else goes to `importPaths(paths, 'replace')` — a drop **replaces** the
  list.
* **`useWindowChrome`** — `useMaximized()` (initial query plus an `onResized`
  subscription) and `useWindowDrag()` (mousedown → `startDragging()`, skipping
  `button, input, a, .no-drag` and multi-clicks; double-click → `toggleMaximize()`),
  swallowing errors outside Tauri.

### 6.10 Styling

One light theme, no preprocessor, no CSS modules, no utility framework.

* `theme.css` is the token layer: CSS custom properties for the purple scale
  (`--purple-primary: #6d28d9`), four surface levels, four border tokens, text tokens, the
  macOS traffic-light colours, danger, four radii, three shadows, and
  `--font-ui` / `--font-mono`.
* `index.css` imports the tokens, resets box-sizing, makes `html`/`body`/`#root` full-height
  with `overflow: hidden`, sets `user-select: none` on the body and re-enables it for form
  controls, and styles the scrollbars.
* `App.css` is one consolidated stylesheet (~1,800 lines, organised by section comments)
  using the tokens. It contains the flex shell, the absolutely-positioned floating detail
  panel, the sticky table header and frozen pane, and the `.host-macos` / `.host-windows` /
  `.host-linux` scoped overrides for chrome geometry and colour.

---

## 7. End-to-end walkthroughs

### 7.1 Cold start

```
YAME launches
  Rust: single-instance plugin claims the user; a second launch focuses the window and exits
  Rust: free_port() → e.g. 51234; origin = http://127.0.0.1:51234
  Rust: note("launching engine on port 51234 (app pid N)")   → engine.log
  Rust: sidecar_path() → unpack embedded engine to
        ~/Library/Application Support/YAME/engine/<version>/yame-engine
  Rust: spawn with YAME_PORT=51234, YAME_PARENT_PID=N, process_group(0)
  Rust: spawn two threads forwarding stdout/stderr to console + engine.log
  Rust: build window, inject __YAME_ENGINE__ / __YAME_PLATFORM__ / __YAME_VERSION__
  Rust: build and set the native menu; manage(engine)
  ── the window paints here, before Python has finished starting ──
  Engine: engine_port() → 51234; publish to <config>/engine.port; print ENGINE_PORT=51234
  Engine: _log("engine started on 127.0.0.1:51234 …")
  Engine: start the parent watchdog thread (5 s poll)
  Engine: uvicorn serves on 127.0.0.1:51234
  Frontend: init() polls GET /api/rules/registry with backoff (up to 30 s)
  Frontend: registry arrives → rules sidebar becomes usable, engineStarting = false
  Frontend: GET /api/presets and GET /api/health fill the preset list and config path
```

Note what did *not* happen: the UI never waited for the engine to boot. It drew
immediately and polled. That is the entire reason the port is chosen before the webview
exists.

### 7.2 Opening a folder

`File ▸ Open Files…` emits `yame://menu` with `file.open` → `useMenuEvents` →
`pickMusic('replace', importPaths)` → the native macOS `NSOpenPanel` (or the dialog
plugin's folder picker) → absolute paths → `importPaths(paths, 'replace')` →
`POST /api/paths/expand` (folders walked recursively, non-audio reported in `skipped`) →
`POST /api/tracks/read` → rows appear. A drop does the same thing with `'replace'`; the
`File ▸ Add Files…` / `Shift+O` path uses `'append'`. In browser dev the folder picker
returns only relative paths, so `/resolve-folder` locates it on disk first.

### 7.3 Authoring a rule

```
pick a type from "New rule"   → setDraft({type, params: defaultParams(spec.params)})
edit a parameter              → updateDraftParam  (writes to BOTH the live rule and the draft)
350 ms of quiet               → POST /api/preview-batch with ≤20 candidates
engine                        → runs the rule against each candidate in memory,
                                 returns the first that changes  (+ matched_index)
builder                       → renders formatPreview() and describeRule()
commit                        → draftProblem() must return null; commitDraft() appends
                                 {id, type, params, enabled: true} to ruleset.rules
```

Because the engine's `/preview-batch` never touches files, an incomplete or wrong rule
costs nothing but a round trip.

### 7.4 Dry run and apply

```
Apply
  └─ POST /api/apply {paths, ruleset, dry_run: true}      → an NDJSON stream
       {"type":"start","total":N}          the engine is alive, and N is known
       {"type":"file","index":i,…}         one per file: read, run the rules in
                                           memory, compute the NET changes
       {"type":"done","changed_files":C}   nothing was written
       ▲ each event re-arms the client's 60s silence budget and updates
         applyProgress, which StatusBar renders as "Checking 412 of 3,000…"
  └─ applyReview = the assembled response; ApplyReviewModal shows every change
       "Apply changes"
         └─ POST /api/apply {paths, ruleset, dry_run: false}   → same stream
              engine: the same computation, then per file:
                write_fields(tags + rename together) → post-rename path
                cover write/remove against that path
                warnings + written flag
              the modal shows "Applying 412 of 3,000…" as it goes
         └─ a stream that ends without a "done" is an error, not a success:
            "N of M file(s) were processed — check them before retrying"
         └─ store: record the whole batch as ONE undo step
         └─ re-read only the files marked written; rebuild rows (renames remapped)
```

If the client goes away mid-batch — the window closes, the request is aborted — the engine
stops at the next file: the generator is closed, so nothing after that point is touched.
There is no cancel button in the UI yet, so today this only happens on a real disconnect.

### 7.5 Undo

```
Ctrl+Z (off macOS: the page handler; on macOS: the menu accelerator)
  ├─ focus in a text field?      → document.execCommand('undo')  (the field's history)
  └─ else
       ├─ noteDiag(...)                        → console + window.__YAME_DIAG__
       ├─ settling?  → ignore (a duplicate delivery of the same keystroke)
       ├─ pop the last step, skipping any that would not change the list
       ├─ push the current state onto `future` (carrying `touched`)
       └─ restore(step):
            diff the step's fields against current → POST only the differing keys
            cover differs → POST set/remove cover
            replace tracks + selection immediately (synchronous, no round trip)
            failures → "Reverted here, but the file could not be written: …"
```

The important property is that undo reverts **the file**, not merely the row. Restoring the
row alone would show the earlier values while the file on disk kept the later ones.

### 7.6 Presets

`Save` → `PUT /api/presets` → the engine normalises the ruleset and writes the JSON store
atomically under a lock. `Load` assigns fresh client-side rule ids (they are UI-only and
never persisted). `Export` downloads `{yame_presets: 1, exported_unix, presets: [...]}`;
`Import` accepts either that wrapper or a bare object and merges by id — the engine
normalises each entry before it can reach disk, because a malformed stored preset would
otherwise make the whole preset list unloadable.

---

## 8. Build and packaging

### 8.1 Prerequisites

| Tool | Version | For |
| --- | --- | --- |
| Node | 20+ (CI uses 22) | Frontend |
| pnpm | 10 | Frontend dependency manager (CI pins v10) |
| Python | **3.13** | Engine (`requires-python = ">=3.13"`) |
| `uv` | latest | Engine virtualenv and dependency resolution |
| Rust | 1.77+ | Shell (`rust-version = "1.77"`) |
| Platform toolchain | Xcode CLT (macOS) / MSVC (Windows) | Linking and bundling |

### 8.2 The development loop

Two terminals, because the engine and the UI are separate processes in development:

```bash
# terminal 1 — the engine (picks a free port and publishes it)
cd mp3-metadata-api
uv sync
.venv/bin/python main.py           # -> ENGINE_PORT=<n>, <config>/engine.port

# terminal 2 — the interface
cd mp3-desktop-frontend
pnpm install
pnpm run dev                       # http://localhost:5173
```

The Vite dev server reads `<config>/engine.port` at config-evaluation time to point its
`/api` proxy at whatever port the engine actually took, so the two find each other with no
configuration. Add `?folder=/path/to/music` to the URL to auto-load a folder on startup.

To run the real shell against the dev server — native menus, clipboard, real picks —
build the sidecar once and use `pnpm run desktop:dev` (`tauri dev`). Without a staged
sidecar, the shell falls back to attaching to the engine you already have running, which
also works.

### 8.3 The npm build scripts

| Command | What it does |
| --- | --- |
| `pnpm run sidecar` | `node scripts/build-sidecar.mjs` — PyInstaller, then stage |
| `pnpm run sidecar:placeholder` | Write the zero-byte stub (not required for the crate to compile) |
| `pnpm run desktop:dev` | `tauri dev` |
| `pnpm run package` / `desktop:build` | **Identical**: build the sidecar, then `tauri build` |
| `pnpm run icon` | `node scripts/build-icon.mjs` — regenerate the app icon from `public/favicon.svg` |

### 8.4 Embedding the engine in the executable

This is the part of the build most likely to confuse a newcomer, because comments in
several files still describe the *previous* mechanism.

**Step 1 — freeze the engine.** `scripts/build-sidecar.mjs`:

1. Determines the Rust target triple, from `argv[2]` or from `rustc -vV` (`host:` line).
2. Finds a Python with PyInstaller: `.venv/bin/python` (or `.venv\Scripts\python.exe`),
   then `python3`/`python`/`py`. Each candidate is probed by *running* it with
   `-c "import PyInstaller"`, because a bare name like `python3` has to be resolved through
   `PATH`, which `existsSync` cannot do. **The venv comes first** because PyInstaller can
   only build for the architecture of the interpreter it runs under, and the venv is the
   one the project pins.
3. Runs `python -m PyInstaller yame-engine.spec --noconfirm --distpath dist --workpath build`
   with `cwd` set to `mp3-metadata-api`.
4. Copies `dist/yame-engine` (or `yame-engine.exe`) to
   `mp3-desktop-frontend/src-tauri/binaries/yame-engine-<triple>[.exe]` and, on Unix,
   `chmod 0755`.

It is Node rather than bash on purpose: **the Windows build has no bash**, and PyInstaller
cannot cross-compile, so the Windows sidecar must be produced by a Windows Python on
Windows. One script that runs identically everywhere beats three that drift.
`build-sidecar.mjs` is the only staging script. It replaced a bash original
(`scripts/build-sidecar.sh`, deleted) in the commit that started the Windows port: the
Windows build has no bash, the script must be run by a Windows Python because PyInstaller
cannot cross-compile, and one script that runs identically everywhere beats two that drift.
The old one also had no PyInstaller probe and no `.exe` handling.

**Step 2 — bake it into the Rust binary.** `src-tauri/build.rs` runs at compile time:

* computes the sidecar path `binaries/yame-engine-<TARGET>[.exe]` and exports
  `TARGET_TRIPLE` (used at run time by `sidecar_path`'s dev fallback) and
  `YAME_SIDECAR_PATH` (absolute, because `include_bytes!` resolves relative paths against
  the *source file's* directory, not the crate root);
* emits `cargo:rustc-cfg=embed_sidecar` **only when the file exists and is non-empty**.
  That condition is what stops a placeholder build from baking a zero-byte engine and
  failing at run time instead of at compile time;
* then runs `tauri_build::build()`.

`engine.rs` then has `#[cfg(embed_sidecar)] static EMBEDDED_ENGINE: &[u8] =
include_bytes!(env!("YAME_SIDECAR_PATH"));`, and unpacks it at first launch
([§5.2](#52-engine-supervision)).

**Why embedding rather than Tauri's `externalBin`.** The app used to do both, and the
macOS bundle came out at 36.8 MB: the executable carried the engine *and* `externalBin`
copied a second copy into `Contents/MacOS`. Commit `8943f49` ("Stop shipping the engine
twice") removed the `externalBin` key; the DMG dropped back to 19.2 MB and the Windows
installer lost the duplicate. Nothing was lost, because `externalBin` only provided the
installed layout (now handled by unpacking) and `tauri dev` (the third fallback in
`sidecar_path`, and the same file `build.rs` embeds).

Note that the surviving references to `externalBin` in the scripts, `build.rs`, `engine.rs`
and the READMEs are now *historical*: each one explains what the project used to do and why
it stopped, which is the useful thing for a reader to know. The authoritative sources for
current behaviour remain `tauri.conf.json` (no `externalBin` key) and `engine.rs`.

**The placeholder.** `scripts/placeholder-sidecar.mjs` writes a zero-byte file at
`binaries/yame-engine-<triple>` so a fresh checkout has an explicit "no engine built yet"
state. It is **not required for compilation**: `build.rs` treats a missing or empty file as
"nothing to embed" and the crate compiles either way — verified both statically
(`tauri-build` 2.6.3 runs `copy_binaries` only `if let Some(paths) =
&config.bundle.external_bin`, and that key is gone) and by experiment (removing `binaries/`
alters nothing; build.rs simply stops emitting `cargo:rustc-cfg=embed_sidecar`).

The failure mode it guards against is worth stating plainly, because it is silent: **a
`tauri build` with no staged sidecar compiles cleanly and produces an app with no engine**
— and because `sidecar_path()`'s third fallback bakes in the compile-time
`CARGO_MANIFEST_DIR`, such a build still works on the developer's own machine and nowhere
else. If a packaged build cannot reach the engine on someone else's machine, check
`engine.log` for `[yame] no sidecar binary found` first.

### 8.5 Bundling

`tauri build` compiles the release binary (with the frontend already built into `dist/` by
`beforeBuildCommand`) and then bundles it according to `tauri.conf.json`:

```jsonc
"bundle": {
  "active": true,
  "targets": ["app", "dmg", "nsis"],
  "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png",
           "icons/icon.icns", "icons/icon.ico"],
  "macOS": { "minimumSystemVersion": "10.15", "signingIdentity": "-",
             "entitlements": "entitlements.plist" },
  "windows": { "nsis": { "installMode": "currentUser", "languages": ["English"] } }
}
```

The release profile in `Cargo.toml` is tuned for size: `opt-level = "s"`, `lto = true`,
`codegen-units = 1`, `panic = "abort"`, `strip = true`.

**Artifacts by platform:**

| Platform | Command | Result |
| --- | --- | --- |
| macOS | `pnpm run package` | `src-tauri/target/release/bundle/macos/YAME.app` and `bundle/dmg/YAME_<version>_<arch>.dmg` (~19 MB) |
| Windows | `pnpm run package` | `src-tauri/target/release/yame.exe` (single file — the engine is inside) plus `bundle/nsis/YAME_<version>_x64-setup.exe` |
| Windows portable | CI, or manually | `YAME-portable-x64.zip` containing `yame.exe` + `README-portable.txt` |

Note the executable is `yame.exe`, from the *crate* name, not `YAME.exe` from
`productName` — which matters when you script the portable zip (that is exactly what the CI
step does).

**Architecture caveat.** PyInstaller builds only for the interpreter that runs it, so:

* the **macOS** artifact is Apple-Silicon-only as published, because it is built on an
  Apple Silicon Mac with an arm64 Python. Intel Mac support needs an x86_64 Python to
  produce the sidecar — the code is ready, it has simply not been built;
* the **Windows** artifact is x64, produced by the x64 Python on `windows-latest`;
* **Linux** needs no code changes for the engine, but `platform.rs` still has
  `TODO(linux)` markers for the clipboard and an unimplemented `open_with_app`.

There is **no CI job that builds the macOS bundle**: the DMG is produced locally. CI builds
the Windows portable zip and the NSIS installer.

### 8.6 macOS signing and entitlements

The build signs ad-hoc (`signingIdentity: "-"`). Two details matter and are easy to get
wrong:

1. **The bundle must be signed at all.** Without it the executable keeps the linker's own
   signature, which claims bundle resources that do not exist, and macOS reports the
   downloaded app as *damaged* — a dead end with no way for the user to proceed.
2. **The engine needs `disable-library-validation`.** The sidecar is a PyInstaller one-file
   binary that unpacks `libpython` into a temporary directory at launch. The Hardened
   Runtime only permits loading libraries signed by the same team, and those unpacked files
   are not — so without the entitlement the engine dies with
   `Failed to load Python shared library ... different Team IDs`.
   `entitlements.plist` contains exactly that one key. It relaxes library validation for
   this process; it does not disable the sandbox and has no effect on the app's own code
   signature.

To ship a warning-free download, set `signingIdentity` to a Developer ID and add
notarisation. **Nothing else about the build changes**, and no code-signing secrets exist
in the repository today: both platforms produce unsigned builds, so Windows SmartScreen
warns on first run ("More info" → "Run anyway").

*Diagnostic note from a past clean-run test:* `xattr -w com.apple.quarantine` sends macOS
into **App Translocation**, which runs the app from a read-only random path. That makes a
healthy build look broken. If a clean-run test fails in an unexplained way, check for it.

### 8.7 Icons

`public/favicon.svg` is the artwork's source of truth.
`scripts/build-icon.mjs` strips commented-out drafts from it, extracts the live `<svg>`,
rewrites the `width`/`height` to 1024, writes `src-tauri/app-icon.svg`, and then runs
`tauri icon` on it to regenerate every size in `src-tauri/icons/` including the
multi-resolution `.ico` Windows reads for the taskbar.

The current approach replaced a screenshot pipeline that rendered a 32 px SVG at 1024 px
with headless Chrome and downscaled; the upscaling lost the detail the small sizes need and
the Windows taskbar icon was reported as "a corrupted version of the app icon". `tauri
icon` rasterises the vector at each size instead. The PyInstaller spec also picks up
`src-tauri/icons/icon.ico` as the engine's icon when present, so the taskbar shows one
product rather than a nameless console — optional by design.

`pnpm run icon` drives all of it. One behaviour to expect: `tauri icon` also writes
launcher sets for the mobile targets this desktop-only app does not ship
(`src-tauri/icons/android/`, `src-tauri/icons/ios/` — 35 files). They are gitignored, so
running the documented command leaves a clean tree. It also re-encodes `icon.icns` on every
run, so expect a binary diff in that one file if you run it on a different Tauri version;
the PNG, `.ico` and `app-icon.svg` outputs are stable.

### 8.8 Windows manual QA (`ports/windows/`)

Because a Windows build cannot be produced on an Apple Silicon Mac (no MSVC linker, and
PyInstaller cannot cross-compile), the port is validated in three layers of increasing
cost:

1. **CI** — the verify tier's Windows `cargo check --all-targets` catches compile errors in
   ~3 minutes; the packaging tier produces a real installer to install and run.
2. **`ports/windows/CHECKLIST.md`** — the scripted manual pass, ordered so an early failure
   makes later steps meaningless: install, startup, the menu bar, opening music, the track
   list, Open With, editing and saving, rules and applying, clipboard and drag-and-drop,
   known-acceptable differences from macOS, process cleanup, and native feel. Two checks
   matter more than the rest because they are the decisions made blind: **window chrome**
   (does the app end up drawing its own header *and* a native title bar at once?) and
   **orphaned engines** (does closing YAME leave a `yame-engine.exe` behind?).
3. **`ports/windows/TESTING.md`** — the CI tiers and their real job and artifact names, the
   cheap-check table, and how to drive the test laptop over SSH or VS Code Remote-SSH if
   interactive debugging is needed. `CHECKLIST.md` is the ordered pass it refers to.

Both documents are kept in step with `ci.yml`; when the workflow changes, the tables in
`TESTING.md` §1 are the part that goes stale first. It also records the asymmetry that
matters: the Windows `Shell check` job only *type-checks*, because `cargo test` runs on
Linux only.

---

## 9. CI/CD

Everything is one workflow: `.github/workflows/ci.yml`.

### 9.1 Triggers and concurrency

```yaml
on:
  push:      { branches: [main], paths-ignore: ['**/*.md', 'ports/**', 'LICENSE'] }
  pull_request:
  workflow_dispatch:
    inputs:
      package: { type: boolean, default: false }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
```

Docs-only changes skip CI entirely — with a caveat: `paths-ignore` is a `push`-only filter,
so a documentation-only **pull request** still runs the whole verify tier. A manual
dispatch can request packaging with `gh workflow run CI --ref <branch> -f package=true`.

The workflow is split into **two tiers** because they answer different questions at very
different costs:

* **verify** — *"is this change sound?"* Runs on every push and PR, on all three
  platforms, in roughly three minutes. It packages nothing.
* **package** — *"does a real Windows build come out?"* Needs PyInstaller, a full release
  compile and the bundler, so it is minutes rather than seconds. On demand, or
  automatically on `main`.

This split exists because packaging on every push made a two-line change a twenty-minute
round trip.

### 9.2 Job by job

| Job | Runner | Timeout | What it proves |
| --- | --- | --- | --- |
| `frontend` | ubuntu-latest | — | Types, lint, 78 unit tests, production build |
| `engine` | ubuntu-latest | — | 148 pytest tests pass on Python 3.13 |
| `shell-check` | **matrix**: ubuntu, windows, macos | 20 min | The Rust crate type-checks on every OS, *including test code* |
| `shell-test` | ubuntu-latest | 25 min | The Rust test suite actually passes, under a hard time bound |
| `package` | windows-latest | 45 min | The engine freezes on Windows, the app builds, a portable zip comes out |
| `installer` | windows-latest | 45 min | An NSIS installer comes out |

**`frontend`** — pnpm 10, Node 22, `pnpm install --frozen-lockfile` with the pnpm store
cached on `pnpm-lock.yaml`, then one step running the whole gate so a failure is one place
to look:

```
pnpm exec tsc -b && pnpm run lint && pnpm test && pnpm run build
```

**`engine`** — Python 3.13, `pip install -e .`, `pip install pytest httpx`, then
`python -m pytest -q`.

**`shell-check`** — the matrix job. `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache`
with `key: shell` (a **commit-independent** key: the default per-ref keys meant a cold
dependency build — the largest single cost here — on nearly every commit). On Ubuntu it
installs the webview development packages
(`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libgtk-3-dev`) in a step that is
both **bounded and retried** (`timeout-minutes: 6`,
`Acquire::Retries=3 Acquire::http::Timeout=30`) because `apt-get update` twice stalled long
enough to hold a runner for eight minutes or more, looking like a compile hang. Then
`node scripts/placeholder-sidecar.mjs` (belt-and-braces — the crate compiles without it),
then:

```
cargo check --all-targets --locked
```

`--all-targets` is the point: it compiles the test code too, which plain `cargo check`
skips, and a platform-specific *test* failing to compile is a real breakage that has
reached this pipeline before.

**`shell-test`** — the same Linux setup, then
`CARGO_TEST_CWD=src-tauri node scripts/cargo-test-timeout.mjs 600`. The bound exists
because a *hanging* test holds a runner until the job timeout (40 minutes, once) and
reports nothing about which test did it; a bound turns that into a prompt failure whose
last printed line names the culprit. The timeout is generous because a cold Windows build
is genuinely slow — it catches hangs, not slowness. The script streams output through, and
kills the whole process tree on Windows (`taskkill /T /F`) because `cargo` is a `.cmd` shim
there rather than the direct child.

**`package`** — Windows. Installs the engine's build dependencies
(`pip install -e .` + `pyinstaller`), `pnpm install --frozen-lockfile`, then
`node scripts/build-sidecar.mjs`, then `pnpm run package`. Then a PowerShell step assembles
the portable zip from `src-tauri/target/release/yame.exe` plus `README-portable.txt`, and
`actions/upload-artifact@v4` publishes it as **`yame-windows-portable`**
(`if-no-files-found: error`). It uses its own Rust cache key (`key: package`) so the two
caches never evict each other — this one holds the release profile the bundler needs.

**`installer`** — the same pipeline but `pnpm build` +
`pnpm exec tauri build --bundles nsis`, uploading **`yame-windows-installer`**
(`if-no-files-found: warn`). It is separated from `package` because the installer is the
slowest artifact and the least useful for testing.

Both packaging jobs are conditional:
`if: (github.event_name == 'workflow_dispatch' && inputs.package) || github.ref == 'refs/heads/main'`.
`inputs.package` only exists for a dispatch, so a push to `main` is the other way in.

### 9.3 What CI does **not** do

* No macOS packaging job. The `.dmg` is built locally on an Apple Silicon Mac.
* No code signing or notarisation, on either platform, and no signing secrets.
* No release publishing. The README points at a Releases page, but creating the release
  and attaching artifacts is a manual step today.
* No coverage reporting or benchmarks.

### 9.4 Choosing the cheapest check that answers your question

| Question | Command | Cost |
| --- | --- | --- |
| Did I break the store, rules or a path helper? | `cd mp3-desktop-frontend && pnpm run check` | ~6 s |
| Did I break the engine? | `cd mp3-metadata-api && .venv/bin/python -m pytest -q` | ~1 s |
| Did I break the shell, on any platform? | push, then `gh run list --limit 1` | ~3 min |
| Does a real Windows build come out? | dispatch with `package` ticked | ~5–8 min |

The store, rules and diagnostics are platform-independent, so most undo/search/menu
changes can be settled on the Mac in seconds. For a genuinely Windows-specific change
(window chrome, the menu bar, paths), the verify tier's Windows `cargo check` catches
compile breaks in about three minutes, and only a *behaviour* question needs the test
laptop.

---

## 10. Testing

| Suite | Location | Runner | Count | Run it with |
| --- | --- | --- | --- | --- |
| Engine | `mp3-metadata-api/tests/` | pytest | **148** | `.venv/bin/python -m pytest -q` |
| Frontend | `mp3-desktop-frontend/src/**/*.test.ts(x)` | Vitest + jsdom | **78** | `pnpm test` (or `pnpm run check`) |
| Shell | `#[cfg(test)] mod tests` in `src-tauri/src/*.rs` | `cargo test` | **15** (platform-gated: 10 run on macOS, `windows.rs`'s 5 only on Windows) | `cargo test` in `src-tauri` |

### 10.1 Engine tests

`tests/conftest.py` generates audio on the fly rather than checking in binary fixtures:
`_tone()` writes a small valid mono 16-bit PCM WAV with the standard library, and
`png_bytes` builds a minimal valid 2×2 PNG from struct-packed chunks. WAV is chosen
because mutagen tags it through the *same ID3 adapter MP3 uses*, so the I/O tests exercise
a real read/write cycle with no committed media and no writes to the sample folders.

| File | Covers |
| --- | --- |
| `test_rules.py` | Wildcard translation (`*`, `?`, literal regex characters, anchoring, case sensitivity, `$` as an ordinary character), capture counting, every rule's behaviour, cover composition order, `RuleContext` pseudo-fields and coercion, the "a rule can never blank the file name" invariants, and `basename`/`join_native` against **both** POSIX and Windows paths |
| `test_audio_io.py` | Round-trip read/write, tag deletion via `""`, unknown keys ignored, rename extension preservation, rename refusal on collision, rename refusal for a slash coming from a tag value, cover set/remove, the 10 MB limit, invalid base64, apply dry-run vs write, rename+cover in one ruleset, and one unreadable file not sinking a batch |
| `test_api.py` | The HTTP contract: health, registry self-description, `errors` in a batch read, 404 vs 422, write-then-read, dotted renames, a refused rename reporting the *original* file, apply dry-run/write (and the NDJSON stream's start/file/done shape), empty-ruleset and empty-path rejection, preview never touching files, preview-batch returning the first matching track, an unknown rule type rejected, browse, preset round-trip, cover-from-file, legacy-config adoption, and the three origin-guard cases (foreign refused, own origins allowed, no Origin allowed) |
| `test_fs_browser.py` | Drop expansion (loose files, recursion, mixed selections, missing paths, dedupe, hidden directories), recursive browse agreeing with expand, alphabetical ordering, and the expand endpoint |

Notable *kinds* of test in here, because they encode product decisions: that a
whitespace-only `find` is still a pattern, that `SET COVER` with no image is a no-op, that
stale `PARSE FILENAME` capture indices are skipped, that a malformed `assignments` value
does not raise, that an imported malformed ruleset cannot brick the preset store, and that
closing the apply generator stops the walk before the next file is touched.

### 10.2 Frontend tests

The two helpers are the whole strategy, and they are the reason the packaged code paths
are covered with no Tauri process and no GUI:

* **`src/test/api-stub.ts`** replaces global `fetch` (never the `api.ts` module) and routes
  on the *path*, normalising absolute and relative URLs down to a path so a route is
  written once regardless of dev or packaged base URL. A route may be a value, a function
  of the request body (awaited), or `{status, body}` for error cases. Every call is
  recorded. **An unrouted path throws**, so a test can never pass because a request
  silently 404'd. It also **honours `init.signal`**, rejecting with an `AbortError` like the
  real `fetch` — without that, a test could not tell a request the client abandoned (the
  60-second timeout) from one that simply never answered. Keeping the real `api.ts` in the
  loop is intentional: base-URL resolution and error handling are where the packaging bugs
  actually live.
* **`src/test/tauri-mock.ts`** installs a fake `window.__TAURI__` (and
  `__TAURI_INTERNALS__`, which is what `isTauri()` checks) exposing only the APIs the app
  actually uses — which doubles as a check that the bridge has not grown new dependencies.
  It records every `invoke`, can replay menu ids, and exposes `setEngineOrigin` /
  `setHostPlatform`. `setup.ts` deletes all four globals before every test so a mock can
  never leak and make `isTauri()` silently true.

| File | Cases | Covers |
| --- | --- | --- |
| `test/env.test.ts` | 13 | `isTauri`, `apiBase` (including trailing-slash stripping and the absolute-base regression), `applyHostClass` (exactly one host class), unknown platform rejection, `fileManagerName` |
| `api.test.ts` | 11 | Both timeout policies. Ordinary calls: a wedged engine rejects after 60s, a timely answer leaves no timer behind (`getTimerCount() === 0`), a refused connection reads as "cannot reach", an HTTP error body still surfaces. Batch apply: the NDJSON stream is assembled with per-file progress, a truncated stream is refused as a partial result, silence trips the idle timeout (while a 1,000-file total does not), the buffered fallback works without a stream body, an older engine's single-object reply is accepted, an unrecognisable reply is reported as a version mismatch, and the engine's own 400 passes through verbatim |
| `undo.test.tsx` | 20 | Mounts the real provider with a harness: edits undo but the first load is the floor, batch removal is one step, redo-branch invalidation, focus routing to the field, selection restore, one-press-one-step after a load, selective write-back (only the changed key), the "reverted here but the file could not be written" toast, and both duplicate-delivery guards — each with a deliberate-second-press counter-test |
| `components/ConfirmDialog.test.tsx` | 12 | Render, resolve, Escape, backdrop, exactly-once resolution, Tab trap, focus return, Enter |
| `components/PresetManager.test.tsx` | 4 | End-to-end delete guard: no `DELETE` before confirmation, and none after Cancel or Escape |
| `utils.test.ts` | 11 | POSIX vs Windows `dirOf`/`joinPath`, including `/song.mp3 → /` and `C:\song.mp3 → C:\other.mp3` |
| `diagnostics.test.ts` | 4 | The undo/redo log, using `vi.resetModules()` for a fresh module-level array |
| `about.test.tsx` | 3 | About content, the single-button dialog, and a CSS-contract assertion that reads `src/App.css` from disk (jsdom applies no stylesheets) — which is why `tsconfig.app.json` includes Node types |

**Not covered:** `TrackTable`, `RuleBuilder`, `EditTrackOverlay`, `DetailPanel`,
`WindowControls` and `useMaximized`. Those are the components where a change most needs a
manual check.

### 10.3 Shell tests

`cargo test` from `src-tauri`. The tests are chosen so they can run headless:

* `menu.rs` — `only_macos_binds_the_edit_shortcuts`, guarding the double-delivery bug.
* `platform.rs` — opening a missing file is an error not a launch; `open_with_app` rejects
  a missing file; copy rejects an empty selection; a path that looks like a flag is made
  absolute (Unix); only bundles count as applications (macOS); LaunchServices recommends
  apps for an audio file (macOS). Commands are async, so assertions run on a bare runtime
  via `tauri::async_runtime::block_on`.
* `engine.rs` — the sidecar naming rules, which are the one place a mistake is silent: the
  staged name is `yame-engine-<triple>[.exe]`, the standalone name carries the `.exe` only
  on Windows, and — the assertion that pins the fixed bug shut — the triple-derived and
  `cfg!`-derived suffix rules must agree on the target being built. That last test is the
  reason a Windows dev build can no longer look for `yame-engine-<triple>` while the staged
  file is `…-<triple>.exe`.
* `windows.rs` — pure helpers only: extension lowercasing, quoted and unquoted shell
  command parsing, and rejection of a command with no program or a ProgID with no command.
* Icon rasterisation is deliberately untested: it needs a main-thread marker that cargo's
  test harness cannot provide. `sidecar_path()` itself is untested because it depends on
  `current_exe()` and the manifest directory; its naming inputs are what carry the tests.

---

## 11. Configuration and environment

### 11.1 Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `YAME_PORT` | `main.py`, `engine.rs` | Force the engine's port (and, in the shell, where to attach) |
| `YAME_CONFIG_DIR` | `main.py`, `presets.py`, `engine.rs`, `vite.config.ts` | Relocate presets, `engine.port` and `engine.log` |
| `YAME_PARENT_PID` | `main.py` | Set by the shell; enables the exit-with-parent watchdog |
| `TAGFORGE_CONFIG_DIR` | `presets.py` | Legacy pre-rebrand config location |
| `HOME` / `USERPROFILE` | `engine.rs` | Locating the config directory on each platform |
| `LOCALAPPDATA` / `XDG_CACHE_HOME` | `engine.rs` | Where the embedded engine is unpacked |
| `CARGO_TEST_CWD` | `cargo-test-timeout.mjs` | Working directory for the bounded `cargo test` |

`YAME_CONFIG_DIR` is the useful one in development: point it somewhere disposable and the
engine's port file, log and presets all move together.

### 11.2 Files on disk

| Path | Written by | Contents |
| --- | --- | --- |
| `<config>/presets.json` | Engine | Saved rulesets (plain JSON) |
| `<config>/engine.port` | Engine | The port it bound, for the dev proxy and the shell |
| `<config>/engine.log` | Engine **and** shell | Engine startup lines, its stdout/stderr, supervisor notes, tracebacks |
| `<config>` default | — | `~/.config/yame` (all platforms — yes, including Windows) |
| `%LOCALAPPDATA%\YAME\engine\<version>\yame-engine.exe` | Shell | The unpacked engine (Windows portable/installed) |
| `~/Library/Application Support/YAME/engine/<version>/yame-engine` | Shell | The unpacked engine (macOS) |
| `localStorage['yame.columns.v1']` | Frontend | Table column order, widths, frozen and hidden sets |

`engine.log` is the black box and the first thing to ask a user for. It is appended to on
every launch, so **the end of the file is the most recent run**. A log that ends
immediately after `[yame] launching engine on port …` means the sidecar never ran at all —
a different bug from one that ran and failed.

`README-portable.txt` tells the portable-build user the same thing, including that
uninstalling means deleting `YAME.exe` and `%LOCALAPPDATA%\YAME`, with nothing written to
the registry.

---

## 12. Invariants and gotchas

Read this section before your first non-trivial change. Each item is a rule the codebase
learned the hard way; most have a comment in the source explaining the same thing, and
several have a test.

### 12.1 Behavioural invariants — do not "simplify" these away

1. **A rule may rename the file but never blank its name.** Enforced once, in
   `RuleContext.set("filename", …)`, because there are four routes to it.
2. **Renaming never converts formats and never loses the extension.** A requested audio
   extension that differs from the file's own is dropped, with a warning.
3. **A rename collision is refused, but a case-only rename is not.** `Path.samefile` is the
   difference.
4. **Tag values may contain `/`; file names may not.** `_unsafe_name_reason` is the wall
   between them.
5. **`""` means "delete the tag", and a read-only format must say so** rather than
   reporting success. `written`/`saved` is the flag the UI trusts.
6. **The dry run and the real run share one code path.** Preview must never be able to
   disagree with apply.
7. **Cover rules compose sequentially; the last one wins.** The reported change is the
   *net* effect, and the cover is applied to the post-rename path.
8. **ID3 reads take only undescribed frames and writes delete only those.**
   `iTunNORM`/`iTunSMPB` data is unrecoverable and must survive.
9. **An empty `find` in `REPLACE` is a no-op**, not a match-everything.
10. **A stale or malformed `PARSE FILENAME` assignment is skipped, never fatal.**
11. **Untrusted preset data is normalised before it reaches disk**, or one bad entry makes
    the preset list permanently unloadable.
12. **The engine refuses web-page origins.** Do not widen `APP_ORIGINS` casually, and do
    not loosen the "no Origin is fine" rule.
13. **The engine picks the port and publishes it; nothing hard-codes 8000** except as a
    fallback.
14. **All file I/O happens in the engine.** Native dialogs may hand *paths* around, but
    nothing else in the app reads or writes a media file.
15. **The rule registry is the single source of truth for parameters.** If a rule needs a
    new parameter, add it to the rule's `params` and both the engine and the UI get it.
16. **The first load is the undo floor.** Undo must never be able to empty the window.
17. **One press is one step.** The `settling` guard, the diagnostics log and the
    macOS-only menu accelerators all exist to protect this.
18. **Undo reverts the file, not just the row**, and writes back only the fields that
    actually differ.
19. **`window.confirm` is not usable in the webview.** Use the store's `confirm()`.
20. **Exactly one context menu appears.** Native commands return `bool` for this reason.
21. **The engine binary has three names and they must agree.** `build.rs` stages
    `yame-engine-<triple>[.exe]` in `binaries/`, `unpack_embedded_engine` writes
    `yame-engine[.exe]` into per-user storage, and `sidecar_path` looks for both. All three
    derive from `engine_exe_name()` and `staged_sidecar_name()`. A mismatch here is *silent*
    — no engine is found and no error is raised — and it has already cost Windows dev builds
    once, so do not inline the name anywhere.
22. **A batch apply streams, and a batch that stops must say so.** `/api/apply` answers
    with one event per file, so the client can report progress and bound silence instead of
    duration. Two things follow: never make it return a single body again (a fixed timeout
    cannot be right for an arbitrary number of files), and never let a stream that ends
    without `done` be treated as success — the files it did reach are already written.
23. **The apply walk must stay interruptible.** The per-file work happens inside the
    generator that the response iterates, which is what makes a disconnect stop the batch
    at the next file. Collecting the results into a list first — the obvious "simplification"
    — would remove both the progress and the cancellation, and buy nothing.

### 12.2 Traps

| Trap | Detail |
| --- | --- |
| `pnpm run icon` rewrites `icon.icns` | The command works, but `tauri icon` re-encodes the `.icns` on every run, so expect a binary diff in that file. It also emits gitignored `icons/android/` and `icons/ios/` sets for platforms this app does not ship. |
| `externalBin` is history, not current behaviour | The bundle does **not** use Tauri's `externalBin`; the engine is embedded via `build.rs` + `include_bytes!` and unpacked on first run. References in the scripts, `build.rs`, `engine.rs` and the READMEs now explain that history deliberately — do not "restore" the mechanism from them. |
| Plain `cargo build` in a fresh checkout | Works with no sidecar at all — `build.rs` treats a missing or empty file as "nothing to embed". Running `node scripts/placeholder-sidecar.mjs` first just makes the "no engine built yet" state explicit. |
| A build with no staged sidecar succeeds silently | Nothing fails; you get an app with no engine that still works on your machine (the dev fallback path is compiled in) and nowhere else. Run `pnpm run sidecar` before `tauri build`. |
| Windows dev could not find a staged sidecar | Historical: the lookup built `yame-engine-<triple>` while `build.rs` and the staging script wrote `…-<triple>.exe`, so a Windows `tauri dev` silently attached to port 8000 instead of starting the engine it had just staged. See invariant 21. |
| `free_port()` is racy | The probe listener is closed before the engine binds; another process can win the port in between. |
| `panic = "abort"` skips cleanup | On Unix an abort never sends `SIGTERM` to the process group. The sidecar's own watchdog is the only backstop — do not remove it. |
| A version bump touches six files | `package.json`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `pyproject.toml`, `app/api.py`. A docs-only change must not bump them (see commit `5058887`). `unpack_dir()` keys on `CARGO_PKG_VERSION` while the bundle reports `tauri.conf.json`'s version, so the two must agree. |
| `pnpm run package` on Windows also builds the installer | `bundle.targets` includes `nsis`, so the CI `installer` job's `--bundles nsis` is partly redundant — and a local Windows `pnpm run package` produces the installer as well. |
| `paths-ignore` applies to `push` only | A documentation-only *pull request* still runs the whole verify tier. |
| The constant Rust cache keys are shared across refs | `key: shell` and `key: package` are deliberately not per-commit so the dependency build survives every push. The trade is that a branch and `main` share one cache entry. |
| Pydantic strips undeclared response fields | Add the field to `app/schemas.py` or it will not exist in the JSON. |
| `__APP_VERSION__` must be defined twice | Once in `vite.config.ts`, once in `vitest.config.ts`. Without the second, importing the store throws in tests. |
| A stopped batch is a *partial* batch | A batch apply stops between files, so whatever was written before the stop stays written. That is why a stream ending without `done` is reported as "N of M file(s) were processed" rather than as a failure: "the request failed" and "nothing changed" are different statements, and only one of them is true. |
| Ordinary calls really are capped at 60s | Only the batch apply is silence-bounded. `request()` — reads, metadata, previews, presets — still aborts after a fixed 60 seconds, which is right for a loopback call that should answer in milliseconds. Do not reuse `applyStream`'s policy for them. |
| A stale engine is a normal state, not a broken install | After any change to the Python engine, `tauri dev` keeps using the sidecar already staged in `src-tauri/binaries/` — `desktop:dev` does not rebuild it, and `build.rs` embeds whatever is there. The packaged app can also attach to an older engine that is already running. Seen for real: a batch failed with "0 of 0 file(s) were processed" purely because the engine predated the streaming change. **Run `pnpm run sidecar` after touching the engine**, and read `engine.log` — a run of `POST /api/apply ... 200 OK` lines with a failure in the UI means the request succeeded and the *parsing* did not. |
| The unpacked engine is keyed by size, not by content | `unpack_embedded_engine` reuses `Application Support/YAME/engine/<version>/yame-engine` when its length matches the embedded copy. The version is in the path, so a rebuild that changes the engine's byte count re-unpacks correctly — but a rebuild that happened to produce an identical size would be silently ignored. |
| Windows double-delivers `Ctrl+Z` | The page handler and WebView2's own undo both fire. Handled in the store, but any *new* keyboard shortcut needs the same thought. |
| Edit accelerators are macOS-only | Deliberate, per the test in `menu.rs`. Do not add them back. |
| `SHOpenWithDialog` cannot be unit-tested | It blocks forever without a human. Keep those paths out of `cargo test`. |
| Dev-only endpoints in production | `/api/resolve-folder` and `/api/resolve-files` exist for the browser build. The packaged app does not need them; do not build features on them. |
| Two divergent paste paths | The row context menu calls `appendPaths` directly (no folder expansion); the native Edit ▸ Paste path calls `importPaths`, which expands directories. Same gesture, different semantics — worth unifying. |
| Redundant work in the packaging jobs | The `package` job runs `node scripts/build-sidecar.mjs` and then `pnpm run package`, which runs it again; `installer` runs `pnpm build` and then `tauri build`, whose `beforeBuildCommand` runs it again. Correct, just slower than it needs to be. |
| `-webkit-app-region: drag` on `.titlebar` | A leftover Electron-style property sitting beside Tauri's `startDragging()`. Harmless dead CSS. |
| Rows render twice | The table has no virtualisation and duplicates every row across the frozen and main panes. A 20,000-file import is bounded but not fast. |
| Linux is half-wired | `xdg-open` works; the clipboard, `open_with_app`, the mixed picker and menu icons are missing or stubbed, each marked in the source. |
| Doc drift | The engine and Windows-port docs were reconciled with the code; the remaining known divergence is the root `README.md`, which summarises rather than specifies. When a count or a job name matters, `ci.yml`, `pyproject.toml` and the test runners are authoritative. |
| A moved checkout can break `cargo` | `target/` caches absolute paths. This checkout lived elsewhere once, and `tauri-build` died with "failed to read plugin permissions … No such file or directory" while pointing at the old path — nothing to do with the sidecar, and easy to misread as a broken build script. The cheap fix is `cargo clean -p tauri -p tauri-plugin-dialog -p tauri-plugin-opener -p tauri-plugin-single-instance`, which re-runs just those build scripts; a full `cargo clean` always works. CI never sees it because it always starts fresh. |
| `mp3-ui/`, `docs/`, `screenshots/` | Gitignored design-phase leftovers, not part of the product. |
| A branch may be ahead of `main` | `windows-port-phase-2` exists; check which branch you are on before reporting a bug. |

---

## 13. Glossary

| Term | Meaning |
| --- | --- |
| **Engine** | The Python/FastAPI process; owns all audio and file I/O |
| **Shell** | The Rust/Tauri executable hosting the webview and supervising the engine |
| **Sidecar** | A helper executable shipped with a Tauri app; here, the frozen engine |
| **Canonical field** | A format-independent field id (`title`) mapped to each format's native key |
| **Pseudo-field** | A computed field: `filename` (writable → renames) plus read-only `stem`, `ext`, `folder_name`, `folder_path` |
| **Rule** | One declarative transformation step with a parameter schema |
| **Rule instance** | `{id, type, params, enabled}` — `id` is client-side only and never persisted |
| **Ruleset / preset** | `{name, rules: [...]}`; a saved preset is that plus an id and timestamp |
| **Dry run** | `POST /api/apply` with `dry_run: true`; computes changes, writes nothing |
| **Change record** | `{field, label, before, after, rule_type, rule_label}`; `__cover__` is the cover-art record |
| **`save_kind`** | `id3` / `mp4` / `vorbis` / `ape` / `asf` / `None` — decides writability |
| **ACL / capability** | Tauri's per-window permission allow-list for plugins |
| **Init script** | JavaScript Tauri runs in the webview before any page code; carries the engine origin |
| **Job object** | The Windows mechanism that ties a process tree's lifetime to a handle |
| **Process group** | The Unix equivalent, signalled with `kill(-pid)` |

---

## 14. Where to start

**If you are working on the engine:** run `pytest`, then read
`app/services/rules.py` end to end — it is 562 lines and holds the product's core idea.
Adding a rule type is a three-line diff (a class, its `params`, and a `register()` call)
plus tests; nothing in the frontend needs to change, and that is worth verifying early
because it is the architecture's main claim.

**If you are working on the frontend:** `pnpm run check` should be green in ~6 seconds.
Read `store-context.ts` first (166 lines — it is the complete API surface), then the undo
block in `store.tsx`, then `RuleBuilder.tsx` for the schema-driven rendering.

**If you are working on the shell:** read `engine.rs` first, then `process_group.rs`, then
`lib.rs`'s `setup` hook. After that, `menu.rs` and the platform modules are mechanical.
Remember that `#[cfg]` branches mean you cannot fully validate platform code on one OS —
that is what the CI matrix and `ports/windows/` are for.

**If you are working on packaging or CI:** `scripts/build-sidecar.mjs` and `build.rs` are
the two files that explain the build. The single most important fact is that PyInstaller
cannot cross-compile, so every platform's engine must be produced by that platform's
Python.

**If you want a first bug to fix:** the frontend has no tests for `TrackTable`,
`RuleBuilder`, `EditTrackOverlay` or `DetailPanel` ([§10.2](#102-frontend-tests)) — the four
components where a change most needs a manual check; `platform.rs` still carries the Linux
`TODO(linux)` stubs for the clipboard and `open_with_app`
([§5.6](#56-the-platform-seam-appsrs-macosrs-windowsrs)); and nothing is code-signed or
notarised, so every download warns ([§8.6](#86-macos-signing-and-entitlements)).

**The one thing to internalise above all else:** the engine decides, the shell provides,
the frontend presents, and the user always sees the changes before any file is touched.
Every design decision in this document follows from those four clauses.
