import type { ChangeEvent } from 'react'
import { api } from './api'
import { useStore } from './store-context'

import { takePendingMode } from './pickers-helpers'

/**
 * Browser-dev fallback for the native picker: a hidden folder input.
 *
 * Browsers hide absolute paths, so the picked folder is re-located on disk by
 * name + relative entries (see the engine's /api/resolve-folder). The packaged
 * app never uses this — it passes paths straight from the OS dialog.
 */
export function PickerInputs() {
  const { folderPath, importPaths, showToast } = useStore()

  const onFolder = async (e: ChangeEvent<HTMLInputElement>) => {
    const mode = takePendingMode()
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!files.length) {
      showToast('The selected folder is empty', 'info')
      return
    }
    const first = files[0]
    const rel = first.webkitRelativePath || ''
    const name = rel.split('/')[0] || first.name
    const entries = files.map((f) => f.webkitRelativePath || f.name)
    try {
      const res = await api.resolveFolder(name, entries, folderPath)
      if (!res.path) {
        showToast('Could not locate the selected folder on disk', 'error')
        return
      }
      // Import every audio file in the folder, including sub-folders.
      await importPaths([res.path], mode)
    } catch {
      showToast('Could not locate the selected folder on disk', 'error')
    }
  }

  // Browser-only fallback for the native picker.
  const folderAttrs = { webkitdirectory: '', directory: '' } as Record<string, string>

  return (
    <input
      id="yame-picker-folder"
      type="file"
      {...folderAttrs}
      style={{ display: 'none' }}
      onChange={onFolder}
    />
  )
}
