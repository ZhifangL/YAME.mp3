// Global test setup: jest-dom matchers, per-test DOM teardown, and a guard
// against the two globals that make a test lie about which platform it is on.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

beforeEach(() => {
  // jsdom implements neither of these, and the app's platform detection reads
  // them. Clearing them per test means a mock installed by one test can never
  // leak into the next and silently make `isTauri()` return true.
  delete (window as { __TAURI__?: unknown }).__TAURI__
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (window as { __YAME_ENGINE__?: unknown }).__YAME_ENGINE__
  delete (window as { __YAME_PLATFORM__?: unknown }).__YAME_PLATFORM__
  document.documentElement.className = ''
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
