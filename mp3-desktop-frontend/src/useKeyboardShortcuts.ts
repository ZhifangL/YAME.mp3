// Global keyboard shortcuts and the context-menu guard.
//
// Windows does not deliver Ctrl+F / Ctrl+O to the native menu the way macOS
// does: WebView2 claims them first (Ctrl+F as its own find bar, Ctrl+O as a
// file-open the webview cannot actually satisfy) and the browser engine
// likewise insists on its own right-click menu. Both are handled here, at the
// document, which is the earliest point the page can intervene.
import { useEffect } from 'react'
import { hostPlatform } from './env'
import { pickMusic } from './pickers-helpers'
import { useStore } from './store-context'

/** Ask the title bar to focus the search field. */
export const FOCUS_SEARCH_EVENT = 'yame://focus-search'

function inTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

export function useKeyboardShortcuts(): void {
  const { importPaths, undo, redo } = useStore()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey) return

      switch (e.key.toLowerCase()) {
        case 'f':
          // Ctrl+F / Cmd+F. `preventDefault` is what stops WebView2 opening its
          // find bar; the menu bar's accelerator handles macOS, this handles
          // everywhere.
          if (inTextField(e.target)) return
          e.preventDefault()
          window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT))
          return

        case 'o': {
          // Ctrl+O opens, Ctrl+Shift+O adds. On macOS the menu bar's
          // accelerators already do this — handling it here too would open two
          // pickers — so this is the fallback for the platforms where Tauri's
          // accelerators do not reach, which is where the shortcut was broken.
          if (hostPlatform() === 'macos') return
          e.preventDefault()
          void pickMusic(e.shiftKey ? 'append' : 'replace', importPaths)
          return
        }

        case 'z': {
          // Undo, and Shift+Z for redo (the macOS spelling). On Windows the
          // webview otherwise claims Ctrl+Z for its own per-field history, so
          // the menu accelerator never sees it. The store decides whether the
          // keystroke belongs to a text field or to the track list.
          if (hostPlatform() === 'macos') return
          e.preventDefault()
          if (e.shiftKey) redo()
          else undo()
          return
        }

        case 'y': {
          // Redo, the Windows spelling.
          if (hostPlatform() === 'macos') return
          e.preventDefault()
          redo()
          return
        }

        default:
          return
      }
    }

    // Capture phase and non-passive: React's own onContextMenu handlers run on
    // the bubble phase afterwards, so suppressing the platform menu here cannot
    // stop the app from showing its own.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('contextmenu', onContextMenu, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('contextmenu', onContextMenu, { capture: true })
    }
  }, [importPaths, undo, redo])
}
