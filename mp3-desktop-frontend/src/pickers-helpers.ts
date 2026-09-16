import { pickMusicPaths } from './desktop'

export type PickMode = 'replace' | 'append'
export type ImportFn = (paths: string[], mode: PickMode) => Promise<void>

let pendingMode: PickMode = 'append'

/**
 * Single entry point for the "Open" (replace) and "Add" (append) buttons.
 *
 * In the packaged app this is the native OS dialog, which returns absolute
 * paths directly — no upload, no name resolution. In the browser dev build it
 * falls back to the folder input mounted by <PickerInputs>.
 */
export async function pickMusic(mode: PickMode, importPaths: ImportFn): Promise<void> {
  const native = await pickMusicPaths(mode === 'replace' ? 'open' : 'add')
  if (native === null) {
    pendingMode = mode
    document.getElementById('yame-picker-folder')?.click()
    return
  }
  if (!native.length) return // the user cancelled
  await importPaths(native, mode)
}

export function takePendingMode(): PickMode {
  return pendingMode
}
