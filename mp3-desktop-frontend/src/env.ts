// Runtime environment detection.
//
// The packaged Tauri build injects `window.__YAME_ENGINE__` (the sidecar's
// origin) from the Rust shell, which reads the port the engine publishes. In
// the browser dev build none of this exists and the Vite proxy serves /api,
// so the defaults below keep dev working unchanged.

export interface EngineBridge {
  /** e.g. "http://127.0.0.1:8000" — no trailing slash. */
  origin: string
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
    __YAME_ENGINE__?: EngineBridge
  }
}

/** True inside the Tauri webview (the same check the plugins use). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
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

/** Reflect the host environment on <html> so CSS can adapt (window chrome). */
export function applyHostClass(): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('host-tauri', isTauri())
}
