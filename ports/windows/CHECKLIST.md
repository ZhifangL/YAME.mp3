# Windows manual checklist

Ordered so that an early failure makes the later steps meaningless. Each item
says what to do, what should happen, and what a failure means — so a failed step
can be reported without a second round trip.

Suggested setup: install the CI artifact (`YAME_<version>_x64-setup.exe` from the
latest `package-windows` job), and have a folder of MP3s ready. The repo's
`sample-mp3/` is a good one if you copy it over.

## 0. Install

- [ ] Run the installer. It should install for the current user and add a Start
      menu entry. **SmartScreen will warn that the publisher is unknown** —
      expected, the build is unsigned. "More info" → "Run anyway".
- [ ] Launch from the Start menu.

*If the installer itself fails, nothing below matters — report that and stop.*

## 1. Starting up

- [ ] The window appears within a couple of seconds, with the track list empty
      and a status bar at the bottom.
- [ ] No console window flashes or stays open.

**Most important item in this file:**

- [ ] Look at the top of the window. There should be **exactly one** title bar.
      Because macOS draws its traffic lights *inside* the app's own header, the
      app was built to draw its own header on macOS. On Windows this is the open
      question: you may see the app's header ("YAME.mp3", Open/Add/Create
      playlist buttons) *plus* a native Windows title bar above it, which would
      look like a port rather than a Windows app.

      Report exactly what you see: one bar, two bars, or the app's own header
      with the window controls overlapping it. Also check the top-left corner is
      not padded oddly (that would be the macOS traffic-light space, 96px,
      leaking through).

- [ ] Drag the header: the window should move. (The app implements dragging
      itself; it is not the native title bar doing it.)
- [ ] Try to resize the window, and maximise/restore it.

## 2. The menu bar

- [ ] There is a menu bar: **File, Edit, View, Help** (no "Window" — that is
      macOS-only, and Windows puts those in the title bar's own menu).
- [ ] File contains "Open Files…", "Add Files…", a separator, and "Exit".
- [ ] Help ▸ About shows **YAME.mp3 and a version number**.
- [ ] Press `Ctrl+O`. The Open Files dialog should appear (this exercises the
      menu accelerator, which is the same mechanism as `Ctrl+F` for search).
- [ ] Press `Alt+F` (or `Alt` alone): the File menu should open by keyboard.
      The `&`-mnemonic handling is custom, so this is worth a click.

*Note: Edit ▸ Undo/Redo were removed on Windows because the underlying API is
macOS-only; Cut/Copy/Paste/Select All remain and are what make clipboard
shortcuts work in the text fields.*

## 3. Opening music

- [ ] **File ▸ Open Files…** or the **Open** button: the native picker appears.
      On Windows the app falls back to the dialog plugin's folder picker, not
      the mixed files-and-folders panel macOS has — see §9.
- [ ] Pick a folder of MP3s. Tracks appear, with title/artist/duration/size.
- [ ] Pick a folder containing FLAC or M4A files: they load too.
- [ ] **Add** appends to the existing list rather than replacing it.
- [ ] Try opening a folder with a **space** and a **non-ASCII character** in its
      name (e.g. `C:\Users\<you>\Music\Björk – Homogénic`). Files should still
      load and, later, be writable.
- [ ] Try a file named with a `%` (e.g. `100% Pure.mp3`) if you have one: it
      should open and play, not silently fail. This was a real bug class on
      Windows — paths used to go through `cmd`, which expands `%`.

## 4. The track list

- [ ] Click a row: it selects. `Ctrl+click` adds/removes. `Shift+click` selects a
      range. `↑`/`↓` walk the list.
- [ ] `Ctrl+A` selects everything.
- [ ] Click column headers to sort; drag a header edge to resize; drag a header
      to reorder.
- [ ] **Right-click a row**: a native Windows context menu appears, with Open,
      Open With, Copy, Paste, Remove from List, and **Show in Explorer**.
- [ ] "Show in Explorer" opens Explorer with the file selected.
- [ ] Right-click a column header: Freeze/Unfreeze Column and a tick-list of
      columns to show/hide.

*If the native menu and a styled HTML menu both appear, that is a specific known
bug class (the app draws its own menu only when Rust reports it did not show
one). Report it — it is easy to fix once seen.*

## 5. Open With (new, untested code)

- [ ] In the row context menu, open **Open With ▸**. It should list the players
      Windows associates with the file type, plus **"Choose another app"**.
- [ ] Pick one of the listed players: it should open the track.
- [ ] Pick **"Choose another app"**: the Windows Open With dialog should appear,
      with the file name shown and applications to pick from.
- [ ] In that dialog, pick something and tick "Always use this app", then open
      the same file again from the context menu — the choice should stick.
- [ ] If the list is *empty* apart from "Choose another app", that is a real
      result worth reporting: the registry enumeration found nothing, which
      happens when the player is a packaged (Store) app.

## 6. Editing and saving

- [ ] Double-click a track: the edit window opens.
- [ ] Change the title and Close: **a confirmation dialog appears** ("Discard
      unsaved changes?"). This is the app's own dialog; before this port it was
      `window.confirm`, which a webview may refuse to draw.
- [ ] Choose Cancel: the window stays open. Choose Discard: it closes.
- [ ] Reopen, change the title, and Save. The table updates.
- [ ] Check in Explorer that the file's metadata actually changed (right-click →
      Properties → Details).
- [ ] Rename a file via the File Name field. The row should follow the new name,
      and the file on disk should be renamed — this exercises the path-joining
      code that had a Windows bug (it used to assume `/`).
- [ ] Try renaming to something with a `?` or `/` in it: it should be refused
      with a warning, not write the file somewhere unexpected.
- [ ] Set cover art by clicking the cover box and picking an image.

## 7. Rules and applying

- [ ] Add a rule (e.g. "Change Case" → Title Case on Title). The rule card shows
      a plain-language summary.
- [ ] Press **Apply**: a review modal lists exactly what would change, with
      before → after per file.
- [ ] Cancel it: nothing is written.
- [ ] Apply again and confirm: changes are written, and the table refreshes.
- [ ] Save the ruleset as a preset, close, and reload it from the ruleset
      manager.
- [ ] Delete the preset: **the app's confirmation dialog appears** (not a
      browser dialog), and Delete actually deletes it.

## 8. Clipboard and drag-and-drop

- [ ] Select tracks, `Ctrl+C`, then `Ctrl+V` in Explorer: real files should
      paste. *This is a known gap — the Windows clipboard implementation is
      still a stub. If it shows an error toast, that is expected; please say so
      explicitly rather than reporting it as new.*
- [ ] Copy files in Explorer, then `Ctrl+V` in YAME: if the stub is still in
      place, expect an error rather than tracks appearing.
- [ ] Drag a folder from Explorer onto the YAME window: tracks should load.
- [ ] Drag an image onto the cover box in the edit window: it becomes the cover.
- [ ] Drag an image onto the cover area with no track selected: a message should
      say to select a track first, not crash.

## 9. Known-acceptable differences from macOS

These are deliberate, and are *not* bugs to report:

- The Open dialog is **folders-only**, not the mixed files+folders panel macOS
  gets. Windows' common item dialog cannot offer both, and drag-and-drop covers
  the mixed case. (Worth confirming you find this acceptable in practice.)
- Edit ▸ Undo/Redo are absent.
- There is no Window menu.
- The installer is unsigned, so SmartScreen warns.

## 10. Process cleanup (the most valuable test on this page)

The engine is a Python sidecar; the app must not leave it behind, and a
PyInstaller sidecar is *two* processes, so killing one can orphan the other.

- [ ] With YAME running, open Task Manager → Details and note the `yame-engine`
      processes.
- [ ] Close YAME normally. Within a few seconds, **every** `yame-engine` process
      should be gone. If one remains, note how many and whether it eventually
      exits on its own (there is a 5-second watchdog as a backstop).
- [ ] Launch YAME again and load music: it should work, which also proves the
      previous engine released its port.
- [ ] Now the crash case: with YAME running, **kill YAME from Task Manager**
      (End task). The engine should still disappear on its own within ~5–10
      seconds. This is the backstop watchdog; the Job Object should make it
      immediate.
- [ ] Do this twice in a row, then launch YAME once more: if two engines
      accumulated, the new one may bind a different port — the app should still
      work.

Useful commands (PowerShell):

```powershell
Get-Process yame-engine -ErrorAction SilentlyContinue   # any orphans?
Get-Process YAME -ErrorAction SilentlyContinue          # the app itself
type $env:USERPROFILE\.config\yame\engine.port          # the port in use
```

## 11. Native feel (your call, not a coded expectation)

Answer in your own words:

- Does the window chrome look like a Windows app, or like a Mac app wearing a
  Windows title bar?
- Are the fonts, spacing and control sizes plausible for Windows? (The UI uses
  the system font stack, but was designed against macOS metrics.)
- Do the menus read correctly — wording, order, and accelerators shown as
  `Ctrl+O` rather than `⌘O`?
- Anything that looks obviously "ported" rather than "built for Windows".

## Reporting

For each failed item, the useful details are: the step number, what you did,
what happened, what you expected, and a screenshot if it is visual. For anything
involving the engine, the output of the PowerShell commands in §10 as well.
