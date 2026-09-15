// OS-integration layer for the song context menu.
//
// The packaged Tauri build implements these with native plugins / small Rust
// commands (shell + dialog + a pasteboard command that reads/writes file
// URLs, and "Open With" via NSWorkspace/ShellExecute). The browser dev build
// degrades gracefully: clipboard text where possible, clear toasts otherwise.
import { api } from './api'

function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

function tauriTodo(feature: string): never {
  // TODO(packaging): implement with the Tauri plugins:
  //   openWithDefault -> shell.open(path)
  //   openWithChooser -> custom command (NSWorkspace on macOS, ShellExecuteEx on Windows)
  //   copyFiles        -> pasteboard write of file URLs
  //   pasteFiles       -> pasteboard read of file URLs
  //   revealInFinder   -> reveal in file manager (open parent + select)
  throw new Error(feature + ' is available in the packaged TagForge app')
}

export async function openWithDefault(_path: string): Promise<void> {
  void _path
  if (isTauri()) tauriTodo('Open with the default app')
  // Browser dev: no way to hand a local file to the OS.
  throw new Error('Open with the default app is available in the packaged TagForge app')
}

export async function openWithChooser(_path: string): Promise<void> {
  void _path
  if (isTauri()) tauriTodo('Open with…')
  throw new Error('"Open with…" is available in the packaged TagForge app')
}

export async function copyFiles(paths: string[]): Promise<void> {
  if (isTauri()) tauriTodo('Copy files')
  // Browser dev: copy the paths as text (real file copy needs the packaged app).
  try {
    await navigator.clipboard.writeText(paths.join('\n'))
  } catch {
    throw new Error('Could not access the clipboard')
  }
}

// Reads file paths from the clipboard (files copied in Finder). Returns
// absolute paths on disk, or an empty list when nothing usable is there.
export async function pasteFiles(previousPath: string | null): Promise<string[]> {
  if (isTauri()) tauriTodo('Paste files')
  // Browser dev: browsers expose clipboard files as nameless blobs, so only
  // pasted path *text* can be resolved; the packaged app reads real file URLs.
  try {
    const text = await navigator.clipboard.readText()
    const lines = text
      .split(/[\n\r]+/)
      .map((l) => l.trim())
      .filter((l) => /[/\\]/.test(l))
    if (!lines.length) return []
    const names = lines.map((l) => l.split(/[/\\]/).pop() || l)
    const res = await api.resolveFiles(names, previousPath)
    return res.paths
  } catch {
    return []
  }
}

export async function revealInFinder(_path: string): Promise<void> {
  void _path
  if (isTauri()) tauriTodo('Show in Finder')
  throw new Error('Show in Finder is available in the packaged TagForge app')
}
