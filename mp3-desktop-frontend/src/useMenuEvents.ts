// Routes native menu selections to app actions.
//
// Both context menus (track list, column headers) and the menu bar are real
// macOS menus built in Rust; they report their chosen item id on one event.
// This hook turns those ids back into the actions the UI already had, so the
// HTML menus are only used in the browser dev build.
import { useEffect, useRef } from 'react'
import {
  copyFiles,
  openWithApp,
  openWithDefault,
  pasteFiles,
  pickApplication,
  revealInFinder,
} from './desktop'
import { pickMusic } from './pickers-helpers'
import { useStore } from './store-context'
import { listenForMenu } from './tauri'

/** Called for column-menu ids; supplied by the track table. */
type ColumnHandler = (id: string) => boolean

export function useMenuEvents(
  onColumnMenu: ColumnHandler,
  focusSearch: () => void,
  /**
   * The row the context menu was opened on. The menu is built for that row, so
   * single-row actions must use it rather than the first entry of the
   * selection — otherwise right-clicking row 3 of a multi-selection would act
   * on row 1.
   */
  menuTarget: { current: string | null },
): void {
  const {
    tracks,
    selectedPaths,
    folderPath,
    importPaths,
    removeTrack,
    showToast,
  } = useStore()

  // The listener is registered once, so it reads state through a ref that is
  // refreshed after every render rather than closing over stale values.
  const latest = useRef({
    tracks, selectedPaths, folderPath, importPaths, removeTrack, showToast, onColumnMenu, focusSearch, menuTarget,
  })
  useEffect(() => {
    latest.current = {
      tracks, selectedPaths, folderPath, importPaths, removeTrack, showToast, onColumnMenu, focusSearch, menuTarget,
    }
  })

  useEffect(() => {
    let stop: (() => void) | null = null
    let cancelled = false

    const run = async (id: string) => {
      const s = latest.current
      // The row the menu was opened on — not simply the first selected one.
      const target = s.menuTarget.current ?? s.selectedPaths[0] ?? null

      // Column menus report their own ids; let the table deal with them first.
      if (id.startsWith('col.') && s.onColumnMenu(id)) return

      try {
        switch (true) {
          case id === 'file.open':
            await pickMusic('replace', s.importPaths)
            return
          case id === 'file.add':
            await pickMusic('append', s.importPaths)
            return
          case id === 'view.search':
            s.focusSearch()
            return
          case id === 'open':
            if (!target) return
            await openWithDefault(target)
            return
          case id.startsWith('openwith:'):
            if (!target) return
            await openWithApp(target, id.slice('openwith:'.length))
            return
          case id === 'openwith.other': {
            if (!target) return
            const appPath = await pickApplication()
            if (appPath) await openWithApp(target, appPath)
            return
          }
          case id === 'copy': {
            if (!s.selectedPaths.length) return
            await copyFiles(s.selectedPaths)
            s.showToast(
              'Copied ' + s.selectedPaths.length + ' song' + (s.selectedPaths.length === 1 ? '' : 's'),
              'success',
            )
            return
          }
          case id === 'paste': {
            const paths = await pasteFiles(s.folderPath)
            if (paths.length) await s.importPaths(paths, 'append')
            else s.showToast('No audio files on the clipboard', 'info')
            return
          }
          case id === 'remove':
            if (target) s.removeTrack(target)
            return
          case id === 'reveal':
            if (target) await revealInFinder(target)
            return
          default:
            return
        }
      } catch (err) {
        latest.current.showToast(err instanceof Error ? err.message : String(err), 'error')
      }
    }

    listenForMenu((id) => void run(id))
      .then((unlisten) => {
        if (cancelled) unlisten?.()
        else stop = unlisten
      })
      .catch(() => {
        /* not running under Tauri — the DOM menus take over */
      })

    return () => {
      cancelled = true
      stop?.()
    }
  }, [])
}
