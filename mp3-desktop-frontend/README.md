# YAME — frontend

React + TypeScript + Vite shell for YAME, styled after the Penpot board
in `../mp3-ui` (purple `#6D28D9` theme, Inter/system font, MP3tag-style
table).

## Layout

- `TitleBar` — traffic lights, wordmark, global search filter
- `RulesSidebar` — rule-type menu, dynamic `RuleBuilder` (rendered from the
  engine's registry, live preview via `/api/preview`), rule cards with
  on/off toggles, presets, Apply
- `TrackTable` — sortable columns, click/multi-select, double-click to edit,
  search filter, empty state
- `DetailPanel` — floating, draggable "iPod" panel: Title/Album/Artist/Comment
  inline edits + cover art
- `EditTrackOverlay` — full edit window with a collapsible "More info" grid,
  filename rename and cover replacement
- `StatusBar` — selection/total counts, duration and size

State lives in `src/store.tsx` (React context); the API client is `src/api.ts`;
rule display helpers in `src/rules.ts` mirror the engine's registry; shared
formatting/DOM helpers are in `src/utils.ts`.

`src/env.ts` resolves the host environment. In the browser the API base is
`/api` (the Vite proxy follows the engine's port file). In the packaged Tauri
build it returns the sidecar's absolute origin from
`window.__YAME_ENGINE__`, because the webview is loaded from
`tauri://localhost` and a root-relative `/api` would never reach the engine.
The Rust shell sets that global (it reads the port the engine publishes) and
`applyHostClass()` marks `<html>` with `.host-tauri`, which is what leaves room
for the native traffic lights in the title bar.

## Desktop shell (`src-tauri/`)

The app ships as a Tauri app: a small Rust binary hosting the same WebView UI
and supervising the Python engine as a bundled sidecar.

| File | Role |
| --- | --- |
| `src/lib.rs` | Builds the window and injects the engine origin |
| `src/engine.rs` | Picks a port, launches the sidecar, reaps it on exit |
| `src/macos.rs` | AppKit: the mixed open panel, LaunchServices app list, app icons |
| `src/menu.rs` | The menu bar and both native context menus |
| `src/platform.rs` | Open, clipboard file copy/paste, the save sheet |
| `tauri.conf.json` | Bundle identity, CSP, `externalBin` sidecar |
| `capabilities/default.json` | Permissions for the dialog and opener plugins |

```bash
pnpm run package      # sidecar + frontend + .app/.dmg into src-tauri/target
pnpm run desktop:dev  # Tauri dev window (uses the running Vite dev server)
pnpm run sidecar      # rebuild just the PyInstaller engine binary
pnpm run icon         # regenerate the app icon from public/favicon.svg
```

The app icon is **generated from `public/favicon.svg`**, never drawn separately:
`scripts/build-icon.sh` extracts the live `<svg>`, renders it at 1024×1024 and
runs `tauri icon`. Edit the favicon, then run `pnpm run icon`.

Two Tauri commands must stay `async` — `save_playlist`, and the two that pop up
context menus. Tauri may run a synchronous command on the main thread, and both
a modal `NSSavePanel` and an `NSMenu` tracking loop need that thread to service
them; running them there deadlocks the app.

`src/tauri.ts` is a typed, dependency-free bridge to the Tauri globals (the app
runs with `withGlobalTauri: true`, so `@tauri-apps/api` is not bundled).
`src/useNativeFileDrop.ts` routes OS drag-and-drop: images onto artwork, and
anything else through the engine's path expander. `src/useMenuEvents.ts` turns
native menu selections (`yame://menu`) back into app actions.

The title bar is dragged by hand: `-webkit-app-region` does nothing in
WKWebView, and Tauri v2 has no built-in drag region, so `TitleBar.tsx` calls
`startDragging()` on mousedown (hence `core:window:allow-start-dragging`).

## Run

```bash
pnpm install
pnpm run dev      # dev server on :5173, proxies /api to the engine's port
pnpm run build    # typecheck + production build into dist/
pnpm run lint
```

Start the engine first (see `../mp3-metadata-api/README.md`), or the UI shows
a friendly offline state.

Dev shortcut: `http://localhost:5173/?folder=/path/to/music` auto-loads a
folder on startup.

## Adding a rule type

Nothing to do here: rules are declared in the engine
(`mp3-metadata-api/app/services/rules.py`) and the builder renders them from
`GET /api/rules/registry`. Param kinds: `field`, `text`, `choice`, `bool`,
`separator`, `parse_pattern` (+ `parse_assignments`).

The registry also carries `audio_suffixes`, so drop handling recognises exactly
the formats the engine can read instead of keeping a second copy of the list.
