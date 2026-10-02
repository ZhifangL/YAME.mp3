// Runtime environment detection.
//
// The packaged Tauri build injects `window.__YAME_ENGINE__` (the sidecar's
// origin) and `window.__YAME_PLATFORM__` from the Rust shell. In the browser
// dev build neither exists and the Vite proxy serves /api, so the defaults
// below keep dev working unchanged.

export interface EngineBridge {
  /** e.g. "http://127.0.0.1:8000" — no trailing slash. */
  origin: string
}

/** What Rust reports through `std::env::consts::OS`. */
export type HostPlatform = 'macos' | 'windows' | 'linux'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
    __YAME_ENGINE__?: EngineBridge
    __YAME_PLATFORM__?: string
    __YAME_VERSION__?: string
  }
}

/**
 * The app's version.
 *
 * The shell injects its build version, so this is available before — and even
 * if — the engine answers. That matters for the About box, which is exactly
 * what a user opens when something is wrong. In a plain browser the Vite define
 * supplies the package version instead.
 */
export function appVersion(): string {
  if (typeof window !== 'undefined' && window.__YAME_VERSION__) {
    return window.__YAME_VERSION__
  }
  return __APP_VERSION__
}

/** True inside the Tauri webview (the same check the plugins use). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Which desktop platform the shell is running on, or null in a browser.
 *
 * Read from the value Rust injects rather than sniffed from the user agent:
 * in a webview the user agent lies about the platform on purpose (WebKit on
 * macOS reports "Macintosh" for compatibility, WebView2 reports "Windows NT"),
 * and a wrong answer here changes window chrome and wording.
 */
export function hostPlatform(): HostPlatform | null {
  if (typeof window === 'undefined') return null
  const raw = window.__YAME_PLATFORM__
  if (raw === 'macos' || raw === 'windows' || raw === 'linux') return raw
  return null
}

/** Wording for the platform's file manager. */
export function fileManagerName(): string {
  switch (hostPlatform()) {
    case 'windows':
      return 'Explorer'
    case 'macos':
      return 'Finder'
    default:
      return 'your file manager'
  }
}

/**
 * Base URL the API client should prefix its paths with.
 *
 * Browser dev: "/api" (the Vite dev proxy follows the engine's port file).
 * Packaged app: the absolute sidecar origin, because the webview is loaded
 * from tauri://localhost and a root-relative "/api" would resolve inside the
 * webview instead of reaching the engine.
 */
export function apiBase(): string {
  const injected = typeof window !== 'undefined' ? window.__YAME_ENGINE__?.origin : undefined
  if (injected) return injected.replace(/\/+$/, '') + '/api'
  return '/api'
}

/**
 * Reflect the host environment on <html> so CSS can adapt (window chrome).
 *
 * `host-tauri` says "inside the desktop shell"; the per-platform class says
 * which one, because the window chrome differs: macOS keeps its traffic lights
 * inside our header, Windows and Linux draw their own title bar outside it.
 */
export function applyHostClass(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const platform = hostPlatform()
  root.classList.toggle('host-tauri', isTauri())
  for (const name of ['macos', 'windows', 'linux'] as const) {
    root.classList.toggle('host-' + name, platform === name)
  }
}
