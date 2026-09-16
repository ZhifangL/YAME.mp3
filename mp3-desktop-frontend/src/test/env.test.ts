// Verifies the test harness itself: platform detection, the API base URL the
// Rust shell injects, and the host class the CSS keys off.
import { describe, expect, it } from 'vitest'
import { apiBase, applyHostClass, fileManagerName, hostPlatform, isTauri } from '../env'
import { installTauri, removeTauri, setEngineOrigin, setHostPlatform } from './tauri-mock'

describe('isTauri', () => {
  it('is false in a plain browser', () => {
    expect(isTauri()).toBe(false)
  })

  it('is true once the Tauri runtime is present', () => {
    installTauri()
    expect(isTauri()).toBe(true)
    removeTauri()
    expect(isTauri()).toBe(false)
  })
})

describe('apiBase', () => {
  it('uses the Vite dev proxy when no origin was injected', () => {
    expect(apiBase()).toBe('/api')
  })

  it('uses the sidecar origin when the shell injected one', () => {
    setEngineOrigin('http://127.0.0.1:54321')
    expect(apiBase()).toBe('http://127.0.0.1:54321/api')
  })

  it('strips trailing slashes so paths are never doubled', () => {
    setEngineOrigin('http://127.0.0.1:54321/')
    expect(apiBase()).toBe('http://127.0.0.1:54321/api')
  })

  it('returns an absolute base, not a root-relative one, under Tauri', () => {
    // Regression guard: a root-relative "/api" would resolve inside the
    // tauri:// webview instead of reaching the engine.
    installTauri()
    setEngineOrigin('http://127.0.0.1:9000')
    expect(apiBase()).toMatch(/^http:\/\//)
  })
})

describe('applyHostClass', () => {
  it('marks the document only inside the desktop shell', () => {
    applyHostClass()
    expect(document.documentElement).not.toHaveClass('host-tauri')

    installTauri()
    applyHostClass()
    expect(document.documentElement).toHaveClass('host-tauri')

    removeTauri()
    applyHostClass()
    expect(document.documentElement).not.toHaveClass('host-tauri')
  })

  it('marks which platform the shell is on, so window chrome can differ', () => {
    installTauri()
    setHostPlatform('windows')
    applyHostClass()
    expect(document.documentElement).toHaveClass('host-windows')
    expect(document.documentElement).not.toHaveClass('host-macos')

    setHostPlatform('macos')
    applyHostClass()
    expect(document.documentElement).toHaveClass('host-macos')
    expect(document.documentElement).not.toHaveClass('host-windows')
  })

  it('never leaves two platform classes on at once', () => {
    installTauri()
    for (const platform of ['macos', 'windows', 'linux', 'macos'] as const) {
      setHostPlatform(platform)
      applyHostClass()
      const present = (['host-macos', 'host-windows', 'host-linux'] as const).filter((c) =>
        document.documentElement.classList.contains(c),
      )
      expect(present).toEqual(['host-' + platform])
    }
  })
})

describe('hostPlatform', () => {
  it('is null in a plain browser', () => {
    expect(hostPlatform()).toBeNull()
  })

  it('reports what the shell injected', () => {
    setHostPlatform('windows')
    expect(hostPlatform()).toBe('windows')
  })

  it('ignores an unrecognised value rather than trusting it', () => {
    // A typo'd or unknown platform must not silently become macOS.
    ;(window as unknown as Record<string, unknown>).__YAME_PLATFORM__ = 'freebsd'
    expect(hostPlatform()).toBeNull()
  })
})

describe('fileManagerName', () => {
  it('names the platform\'s file manager', () => {
    setHostPlatform('windows')
    expect(fileManagerName()).toBe('Explorer')
    setHostPlatform('macos')
    expect(fileManagerName()).toBe('Finder')
    setHostPlatform('linux')
    expect(fileManagerName()).toBe('your file manager')
  })
})
