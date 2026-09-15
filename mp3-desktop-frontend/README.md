# TagForge — frontend

React + TypeScript + Vite shell for TagForge, styled after the Penpot board
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
`window.__TAGFORGE_ENGINE__`, because the webview is loaded from
`tauri://localhost` and a root-relative `/api` would never reach the engine.
The Rust shell sets that global (it reads the port the engine publishes) and
`applyHostClass()` marks `<html>` with `.host-tauri`, which is what leaves room
for the native traffic lights in the title bar.

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
