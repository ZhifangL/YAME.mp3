// Test helpers for the browser/desktop split.
//
// The app decides what it is allowed to do by sniffing `window.__TAURI__`, so
// the only honest way to test the packaged-app code paths is to install a fake
// one. That also means the packaged paths (native menus, the file clipboard,
// the save sheet) are covered without a Tauri process or a GUI.
import { vi } from 'vitest'

/** Platforms the app should recognise, mirroring Rust's `cfg(target_os)`. */
export type HostPlatform = 'macos' | 'windows' | 'linux'

interface InstallOptions {
  /**
   * Commands the fake `core.invoke` answers. Returning `undefined` for a
   * command makes the call reject, which is what a missing Rust command does.
   */
  invoke?: Record<string, (args: Record<string, unknown>) => unknown>
  /** Result of `dialog.open`; `null` means the user cancelled. */
  dialog?: string[] | null
  /** Native menu selections to deliver to listeners registered by the app. */
  menuIds?: string[]
}

export interface TauriHandle {
  /** Every `invoke` call, in order — for asserting how the UI talked to Rust. */
  invokes: { cmd: string; args: Record<string, unknown> }[]
  /** Deliver a native menu selection to the app (e.g. "file.open"). */
  emitMenu: (id: string) => void
  /** Whether any menu listener has subscribed yet. */
  hasMenuListener: () => boolean
}

/**
 * Install a fake Tauri runtime on `window`.
 *
 * Only the handful of APIs the app actually uses are provided: `core.invoke`,
 * `dialog.open`, `event.listen` and the window drag handle. Everything the
 * frontend touches goes through `src/tauri.ts`, so keeping this list short is
 * also a check that the bridge has not grown new dependencies.
 */
export function installTauri(options: InstallOptions = {}): TauriHandle {
  const invokes: TauriHandle['invokes'] = []
  const menuListeners = new Set<(event: { payload: unknown }) => void>()

  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    invokes.push({ cmd, args })
    const handler = options.invoke?.[cmd]
    if (!handler) throw new Error(`no such command: ${cmd}`)
    return handler(args)
  })

  const global = window as unknown as Record<string, unknown>

  // `isTauri()` tests for __TAURI_INTERNALS__; the app's own bridge reads
  // __TAURI__. Installing both mirrors the real `withGlobalTauri` runtime.
  global.__TAURI_INTERNALS__ = {}

  global.__TAURI__ = {
    core: { invoke },
    dialog: { open: vi.fn(async () => options.dialog ?? null) },
    opener: { revealItemInDir: vi.fn(async () => undefined) },
    event: {
      listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
        if (event === 'yame://menu') {
          menuListeners.add(handler)
          for (const id of options.menuIds ?? []) handler({ payload: id })
        }
        return () => menuListeners.delete(handler)
      }),
    },
    window: {
      getCurrentWindow: () => ({ startDragging: vi.fn(async () => undefined) }),
    },
    webviewWindow: {
      getCurrentWebviewWindow: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }),
    },
  }

  return {
    invokes,
    emitMenu: (id) => menuListeners.forEach((handler) => handler({ payload: id })),
    hasMenuListener: () => menuListeners.size > 0,
  }
}

export function removeTauri(): void {
  const global = window as unknown as Record<string, unknown>
  delete global.__TAURI__
  delete global.__TAURI_INTERNALS__
}

/** Pretend the Rust shell injected the sidecar's origin. */
export function setEngineOrigin(origin: string): void {
  ;(window as unknown as Record<string, unknown>).__YAME_ENGINE__ = { origin }
}

/** Pretend the Rust shell reported the host platform (`std::env::consts::OS`). */
export function setHostPlatform(platform: 'macos' | 'windows' | 'linux'): void {
  ;(window as unknown as Record<string, unknown>).__YAME_PLATFORM__ = platform
}
