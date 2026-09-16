// OS-integration layer for everything the browser cannot do.
//
// In the packaged app these are real: the opener plugin hands a path to the
// OS, and Rust commands handle the native picker, launching with a chosen
// application, the pasteboard and the save sheet (see src-tauri/src/platform.rs).
// In the browser dev build we degrade gracefully — clipboard text where
// possible, a clear message otherwise — so `pnpm run dev` still exercises the
// whole UI.
import { api } from './api'
import { isTauri } from './env'
import { invoke, pickMusicSelection, pickPaths, revealItemInDir } from './tauri'

const PACKAGED_ONLY = ' is available in the packaged YAME app'

/**
 * Native "add music" panel.
 *
 * Returns absolute paths (songs and/or folders — the engine expands folders
 * recursively), or null when the caller should fall back to the browser
 * folder input.
 */
export async function pickMusicPaths(mode: 'open' | 'add'): Promise<string[] | null> {
  if (!isTauri()) return null
  const title = mode === 'open' ? 'Open music' : 'Add music'
  const prompt = mode === 'open' ? 'Open' : 'Add'
  const paths = await pickMusicSelection(title, prompt)
  if (paths !== null) return paths
  // A platform without the custom panel: folders only, via the dialog plugin.
  return pickPaths({ title: 'Choose a folder of music', directory: true, multiple: true })
}

/**
 * Pick any application bundle, starting in /Applications.
 *
 * An `.app` is a directory, so this is the folder panel pointed at where
 * applications live — the same navigation Finder's "Other…" offers.
 */
export async function pickApplication(): Promise<string | null> {
  if (!isTauri()) return null
  const picked = await pickPaths({
    title: 'Choose an application',
    directory: true,
    multiple: false,
    defaultPath: '/Applications',
  })
  return picked && picked.length ? picked[0] : null
}

export async function openWithDefault(path: string): Promise<void> {
  if (isTauri()) {
    await invoke<null>('open_default', { path })
    return
  }
  throw new Error('Open with the default app' + PACKAGED_ONLY)
}

/** Open `path` with a specific application bundle. */
export async function openWithApp(path: string, appPath: string): Promise<void> {
  await invoke<null>('open_with_app', { path, appPath })
}

export async function copyFiles(paths: string[]): Promise<void> {
  const result = await invoke<number>('copy_files_to_clipboard', { paths })
  if (result !== null) return
  // Browser dev: copy the paths as text; a real file copy needs the OS.
  try {
    await navigator.clipboard.writeText(paths.join('\n'))
  } catch {
    throw new Error('Could not access the clipboard')
  }
}

/**
 * Read absolute file paths from the clipboard (files copied in Finder).
 * Returns [] when nothing usable is there.
 */
export async function pasteFiles(previousPath: string | null): Promise<string[]> {
  const paths = await invoke<string[]>('read_files_from_clipboard')
  if (paths !== null) return paths

  // Browser dev: browsers expose clipboard files as nameless blobs, so only
  // pasted path *text* can be resolved by name.
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

export async function revealInFinder(path: string): Promise<void> {
  if (await revealItemInDir(path)) return
  throw new Error('Show in Finder' + PACKAGED_ONLY)
}

/**
 * Write a playlist through the native save sheet.
 *
 * Returns the saved path, or null when the user cancelled (or when running in
 * a browser, where the caller falls back to a download).
 */
export async function savePlaylistFile(
  defaultName: string,
  contents: string,
): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string | null>('save_playlist', { defaultName, contents })
}

