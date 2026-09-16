// Native file drag-and-drop bridge.
//
// With Tauri's dragDropEnabled the webview never sees HTML5 file drops — the
// OS hands real absolute paths to the Rust side instead, which is exactly what
// we want (the browser could only ever give us file *names*). This hook routes
// those drops: an image dropped on a cover target sets artwork, anything else
// is imported through the engine's path expander, so a single drop may contain
// audio files, folders, or a mix of both.
import { useEffect } from 'react'
import { useStore } from './store-context'
import { listenForFileDrops } from './tauri'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'])

function looksLikeImage(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot !== -1 && IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

/** Which cover target (if any) is under this physical-pixel drop position. */
function coverTargetAt(x: number, y: number): string | null {
  const ratio = window.devicePixelRatio || 1
  const element = document.elementFromPoint(x / ratio, y / ratio)
  return element?.closest('[data-cover-drop]')?.getAttribute('data-cover-drop') ?? null
}

export function useNativeFileDrop(): void {
  const { importPaths, setDragOver, setCoverFromFile, editTrackPath, selectedPaths, showToast } = useStore()

  useEffect(() => {
    let stop: (() => void) | null = null
    let cancelled = false

    listenForFileDrops((payload) => {
      switch (payload.type) {
        case 'enter':
        case 'over':
          setDragOver(true)
          break

        case 'leave':
          setDragOver(false)
          break

        case 'drop': {
          setDragOver(false)
          const paths = payload.paths ?? []
          if (!paths.length) return

          // A single image dropped onto artwork belongs to the cover, not the
          // track list. The edit window wins when it is open.
          const target = coverTargetAt(payload.position?.x ?? 0, payload.position?.y ?? 0)
          const trackPath = editTrackPath ?? (selectedPaths.length === 1 ? selectedPaths[0] : null)
          if (target && paths.length === 1 && looksLikeImage(paths[0])) {
            if (!trackPath) {
              showToast('Select a track first', 'info')
              return
            }
            void setCoverFromFile(trackPath, paths[0])
              .then(() => showToast('Cover art updated', 'success'))
              .catch((err) => showToast(err instanceof Error ? err.message : String(err), 'error'))
            return
          }

          void importPaths(paths, 'replace')
          break
        }
      }
    })
      .then((unlisten) => {
        if (cancelled) unlisten?.()
        else stop = unlisten
      })
      .catch(() => {
        /* not running under Tauri — the DOM drop handlers take over */
      })

    return () => {
      cancelled = true
      stop?.()
    }
  }, [importPaths, setDragOver, setCoverFromFile, editTrackPath, selectedPaths, showToast])
}
