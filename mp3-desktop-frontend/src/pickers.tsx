import type { ChangeEvent } from 'react'
import { api } from './api'
import { useStore } from './store-context'

import { takePendingMode } from './pickers-helpers'

// Mounted once in App; renders the hidden native folder input.
export function PickerInputs() {
  const { folderPath, appendPaths, replacePaths, showToast } = useStore()

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
      const browse = await api.browse(res.path, true)
      if (!browse.audio_files.length) {
        showToast('No audio files in this folder', 'info')
        return
      }
      const paths = browse.audio_files.map((f) => f.path)
      if (mode === 'replace') await replacePaths(paths)
      else await appendPaths(paths)
    } catch {
      showToast('Could not locate the selected folder on disk', 'error')
    }
  }

  const folderAttrs = { webkitdirectory: '', directory: '' } as Record<string, string>

  return (
    <input
      id="tf-picker-folder"
      type="file"
      {...folderAttrs}
      style={{ display: 'none' }}
      onChange={onFolder}
    />
  )
}
