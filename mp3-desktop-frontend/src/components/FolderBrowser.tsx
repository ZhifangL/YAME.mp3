import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store-context'
import type { BrowseResponse } from '../types'

export function FolderBrowser() {
  const { closeFolderBrowser, loadFolder, showToast, folderPath } = useStore()
  const [current, setCurrent] = useState<BrowseResponse | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const browse = useCallback((path?: string) => {
    setLoading(true)
    setError(null)
    api
      .browse(path)
      .then((res) => {
        setCurrent(res)
        setPathInput(res.path)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      void browse(folderPath ?? undefined)
    }, 0)
    return () => clearTimeout(timer)
  }, [browse, folderPath])

  const openFolder = () => {
    if (!current) return
    const paths = current.audio_files.map((f) => f.path)
    loadFolder(current.path, paths)
    closeFolderBrowser()
  }

  const goToInput = () => {
    const p = pathInput.trim()
    if (p) browse(p)
    else showToast('Enter a folder path', 'error')
  }

  return (
    <div className="overlay-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeFolderBrowser() }}>
      <div className="folder-modal">
        <div className="modal-header">
          <h3>Open folder</h3>
          <button className="overlay-close" onClick={closeFolderBrowser} title="Close">
            ✕
          </button>
        </div>
        <input
          className="input path-input"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') goToInput() }}
          placeholder="/path/to/your/music"
          spellCheck={false}
        />
        <div className="folder-list">
          {error && <p className="field-help" style={{ color: 'var(--danger)' }}>{error}</p>}
          {loading && <p className="field-help">Reading…</p>}
          {current?.parent && (
            <button className="folder-entry" onClick={() => browse(current.parent!)}>
              <span className="f-icon">↑</span> ..
            </button>
          )}
          {current?.folders.map((folder) => (
            <button
              key={folder.path}
              className="folder-entry"
              onClick={() => browse(folder.path)}
              onDoubleClick={() => browse(folder.path)}
              title={folder.path}
            >
              <span className="f-icon">📁</span>
              {folder.name}
            </button>
          ))}
          {current && current.folders.length === 0 && !current.audio_files.length && !loading && !error && (
            <p className="field-help">No sub-folders or audio files here.</p>
          )}
        </div>
        <div className="modal-footer">
          <span className="field-help" style={{ marginRight: 'auto', alignSelf: 'center' }}>
            {current && current.audio_files.length > 0
              ? current.audio_files.length + ' audio file' + (current.audio_files.length === 1 ? '' : 's') + ' in this folder'
              : ''}
          </span>
          <button className="text-btn" onClick={closeFolderBrowser}>
            Cancel
          </button>
          <button className="text-btn primary" onClick={openFolder} disabled={!current || current.audio_files.length === 0}>
            Open this folder
          </button>
        </div>
      </div>
    </div>
  )
}
