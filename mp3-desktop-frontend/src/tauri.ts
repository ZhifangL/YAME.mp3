// Typed, dependency-free bridge to the Tauri runtime.
//
// The app runs with `withGlobalTauri: true`, so the Tauri API is injected as
// `window.__TAURI__` instead of pulling `@tauri-apps/api` into the bundle.
// Everything here is a thin, safe accessor: outside Tauri the calls return
// null/false so callers can fall back to browser behaviour.
import { isTauri } from './env'

interface TauriOpenDialogOptions {
  title?: string
  directory?: boolean
  multiple?: boolean
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

/** Event carrying the id of a chosen native menu item. */
export const MENU_EVENT = 'yame://menu'

export interface DragDropPayload {
  type: 'enter' | 'over' | 'drop' | 'leave'
  /** Physical-pixel position; only present on enter/over/drop. */
  position: { x: number; y: number }
  /** Absolute paths; Tauri only includes these on the final "drop". */
  paths?: string[]
}

interface TauriGlobal {
  core?: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> }
  dialog?: { open(options: TauriOpenDialogOptions): Promise<string[] | string | null> }
  opener?: {
    revealItemInDir(path: string): Promise<void>
  }
  event?: {
    listen(event: string, handler: (e: { payload: unknown }) => void): Promise<() => void>
  }
  webviewWindow?: {
    getCurrentWebviewWindow(): {
      onDragDropEvent?(handler: (e: { payload: DragDropPayload }) => void): Promise<() => void>
    }
  }
}

function tauri(): TauriGlobal | null {
  if (!isTauri()) return null
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null
}

/** Run a Rust command defined in src-tauri. Returns null outside Tauri. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const api = tauri()
  if (!api?.core?.invoke) return null
  return api.core.invoke<T>(cmd, args)
}

/**
 * Show the native picker and return absolute paths.
 *
 * Returns null when not running in Tauri (the caller then uses the browser
 * folder input), and [] when the user cancelled.
 */
export async function pickPaths(options: TauriOpenDialogOptions): Promise<string[] | null> {
  const api = tauri()
  if (!api?.dialog?.open) return null
  const picked = await api.dialog.open(options)
  if (picked == null) return []
  return Array.isArray(picked) ? picked : [picked]
}

export async function revealItemInDir(path: string): Promise<boolean> {
  const api = tauri()
  if (!api?.opener?.revealItemInDir) return false
  await api.opener.revealItemInDir(path)
  return true
}

/**
 * The "add music" panel: songs and folders selectable together.
 *
 * Returns null when the platform has no native implementation, so callers can
 * fall back to the dialog plugin.
 */
export async function pickMusicSelection(
  title: string,
  prompt: string,
): Promise<string[] | null> {
  return invoke<string[] | null>('pick_music', { title, prompt })
}

/** Subscribe to native menu selections. Returns an unlisten function. */
export async function listenForMenu(
  handler: (id: string) => void,
): Promise<(() => void) | null> {
  const api = tauri()
  if (!api?.event?.listen) return null
  return api.event.listen(MENU_EVENT, (event) => handler(String(event.payload)))
}

/**
 * Subscribe to native file drag-and-drop. Returns an unlisten function, or
 * null when the runtime has no drag-drop support (browser mode uses the DOM's
 * own drag events instead).
 */
export async function listenForFileDrops(
  handler: (payload: DragDropPayload) => void,
): Promise<(() => void) | null> {
  const api = tauri()
  const webview = api?.webviewWindow?.getCurrentWebviewWindow?.()
  if (webview?.onDragDropEvent) {
    return webview.onDragDropEvent((event) => handler(event.payload))
  }
  // Fall back to the raw window events when the helper is unavailable.
  if (api?.event?.listen) {
    const stops = await Promise.all(
      (['enter', 'over', 'drop', 'leave'] as const).map((phase) =>
        api.event!.listen('tauri://drag-' + phase, (e) =>
          handler({ type: phase, position: { x: 0, y: 0 }, ...(e.payload as object) }),
        ),
      ),
    )
    return () => stops.forEach((stop) => stop())
  }
  return null
}
