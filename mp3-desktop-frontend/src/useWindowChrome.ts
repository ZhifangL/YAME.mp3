// Window plumbing for the app's own title bar.
//
// Kept apart from `WindowControls.tsx` because that file exports a component,
// and mixing component and non-component exports breaks React Fast Refresh
// (eslint's react-refresh rule enforces it).
import { useEffect, useRef, useState } from 'react'

interface TauriWindow {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  startDragging(): Promise<void>
  onResized?(handler: () => void): Promise<() => void>
}

/** The current window, or null outside the Tauri shell. */
export function currentWindow(): TauriWindow | null {
  return (
    (window as unknown as { __TAURI__?: { window?: { getCurrentWindow(): TauriWindow } } })
      .__TAURI__?.window?.getCurrentWindow() ?? null
  )
}

/** Whether the window is maximised, kept in sync with the OS. */
export function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const win = currentWindow()
    if (!win) return
    let stop: (() => void) | null = null
    let cancelled = false

    const sync = () => {
      win.isMaximized()
        .then(setMaximized)
        .catch(() => {})
    }
    sync()

    // Maximising by dragging the window to a screen edge, or by double-clicking
    // the bar, happens outside React — so the button follows the window rather
    // than its own click count.
    win.onResized?.(sync)
      .then((unlisten) => {
        if (cancelled) unlisten()
        else stop = unlisten
      })
      .catch(() => {})

    return () => {
      cancelled = true
      stop?.()
    }
  }, [])

  return maximized
}

/** Let the header be dragged to move the window, and double-clicked to maximise. */
export function useWindowDrag() {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const bar = ref.current
    if (!bar) return
    // A drag handle is the bar itself; buttons and the search field keep their
    // own clicks.
    const isHandle = (target: EventTarget | null) =>
      !(target as HTMLElement | null)?.closest('button, input, a, .no-drag')

    const onMouseDown = async (e: MouseEvent) => {
      if (e.button !== 0 || e.detail > 1) return
      if (!isHandle(e.target)) return
      try {
        await currentWindow()?.startDragging()
      } catch {
        /* not running under Tauri, or the permission is missing */
      }
    }
    // Double-clicking a title bar maximises, on every platform that has one.
    const onDoubleClick = async (e: MouseEvent) => {
      if (e.button !== 0 || !isHandle(e.target)) return
      try {
        await currentWindow()?.toggleMaximize()
      } catch {
        /* not running under Tauri */
      }
    }

    bar.addEventListener('mousedown', onMouseDown)
    bar.addEventListener('dblclick', onDoubleClick)
    return () => {
      bar.removeEventListener('mousedown', onMouseDown)
      bar.removeEventListener('dblclick', onDoubleClick)
    }
  }, [])

  return ref
}
