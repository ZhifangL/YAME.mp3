// The app's own window chrome: caption buttons for platforms that draw their
// own title bar.
//
// macOS keeps its native traffic lights and a native menu bar, so it renders
// none of this. Windows gets a frameless window (see `decorations` in lib.rs)
// and these buttons supply what the native title bar did.
import { useCallback } from 'react'
import { isTauri } from '../env'
import { currentWindow, useMaximized } from '../useWindowChrome'

// Drawn as SVG rather than taken from an icon font: Segoe MDL2 Assets has the
// canonical Windows glyphs, but depending on a font means the buttons inherit
// whatever a machine without it does. These are the same shapes, at the 10px
// Windows uses.

function MinimizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  )
}

function MaximizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  )
}

function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      {/* The two overlapping frames of the "restore" state. */}
      <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" strokeWidth="1" fill="none" />
      <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  )
}

/** Minimise / maximise / close, styled like the Windows caption buttons. */
export function WindowControls() {
  const maximized = useMaximized()

  const act = useCallback(
    (run: (win: NonNullable<ReturnType<typeof currentWindow>>) => Promise<void>) => {
      const win = currentWindow()
      if (!win) return
      run(win).catch(() => {})
    },
    [],
  )

  if (!isTauri()) return null

  return (
    <div className="window-controls no-drag">
      <button
        className="wc-btn"
        onClick={() => act((w) => w.minimize())}
        title="Minimise"
        aria-label="Minimise"
      >
        <MinimizeIcon />
      </button>
      <button
        className="wc-btn"
        onClick={() => act((w) => w.toggleMaximize())}
        title={maximized ? 'Restore' : 'Maximise'}
        aria-label={maximized ? 'Restore' : 'Maximise'}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        className="wc-btn wc-close"
        onClick={() => act((w) => w.close())}
        title="Close"
        aria-label="Close"
      >
        <CloseIcon />
      </button>
    </div>
  )
}
