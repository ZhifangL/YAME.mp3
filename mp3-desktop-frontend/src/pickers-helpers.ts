export type PickMode = 'replace' | 'append'

let pendingMode: PickMode = 'append'

// Single entry point for the "Open" (replace) and "Add" (append) buttons.
// In the packaged Tauri build this calls the native dialog plugin with both
// file and directory selection enabled, returning absolute paths directly:
//   window.__TAURI__.dialog.open({ directory: true, multiple: true, ... })
// The browser fallback opens the OS folder picker; individual files can be
// dropped onto the trackview (drop replaces the list).
export function pickMusic(mode: PickMode) {
  pendingMode = mode
  document.getElementById('tf-picker-folder')?.click()
}

export function takePendingMode(): PickMode {
  return pendingMode
}
