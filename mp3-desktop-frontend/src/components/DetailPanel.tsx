import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store-context'
import type { Track } from '../types'
import { readImageFile } from '../utils'
import { MusicArt } from './MusicArt'

export function DetailPanel() {
  const { tracks, selectedPaths, writeFields, setCover, showToast, openEdit } = useStore()
  const track = tracks.find((t) => selectedPaths.includes(t.file.path)) ?? null
  const [collapsed, setCollapsed] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [panelKey, setPanelKey] = useState<string | null>(null)

  // Reset the collapsed state whenever a different track gets selected.
  if (track && panelKey !== track.file.path) {
    setPanelKey(track.file.path)
    setCollapsed(false)
  }

  const pickCover = useCallback(
    async (file: File) => {
      if (!track) return
      if (!file.type.startsWith('image/')) {
        showToast('That file is not an image', 'error')
        return
      }
      if (file.size > 10 * 1024 * 1024) {
        showToast('Cover image is larger than 10 MB', 'error')
        return
      }
      const image = await readImageFile(file)
      try {
        await setCover(track.file.path, image.mime, image.data_base64)
        showToast('Cover art updated', 'success')
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error')
      }
    },
    [track, setCover, showToast],
  )

  // Paste an image anywhere (outside text inputs) to set the selected
  // track's cover — works even when the panel itself is not focused.
  useEffect(() => {
    const onWindowPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (!track) return
      const items = Array.from(e.clipboardData?.items ?? [])
      const image = items.find((i) => i.type.startsWith('image/'))
      if (!image) return
      e.preventDefault()
      const file = image.getAsFile()
      if (file) pickCover(file)
    }
    window.addEventListener('paste', onWindowPaste)
    return () => window.removeEventListener('paste', onWindowPaste)
  }, [track, pickCover])

  // Hidden entirely until music has been added to the trackview.
  if (!tracks.length) return null

  const onPaste = (e: React.ClipboardEvent) => {
    if (!track) return
    const target = e.target as HTMLElement
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    const items = Array.from(e.clipboardData?.items ?? [])
    const image = items.find((i) => i.type.startsWith('image/'))
    if (!image) return
    e.preventDefault()
    const file = image.getAsFile()
    if (file) pickCover(file)
  }

  const onDrop = (e: React.DragEvent) => {
    if (!track) return
    const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith('image/'))
    if (file) {
      e.preventDefault()
      pickCover(file)
    }
  }

  const title = track ? track.fields.title || 'Unnamed Track' : 'Select a track'
  const artist = track?.fields.artist || ''

  if (collapsed) {
    return (
      <div className={'detail-panel collapsed' + (track ? '' : ' empty')}>
        <div className="panel-header" onClick={() => setCollapsed(false)} title="Click to expand">
          <span className="panel-collapsed-title">
            {track ? title + (artist ? ' — ' + artist : '') : 'Select a track'}
          </span>
          <button className="panel-close" onClick={() => setCollapsed(false)} title="Expand panel">
            ▲
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={'detail-panel' + (track ? '' : ' empty')}
      onPaste={onPaste}
      onDragOver={(e) => { if (track) e.preventDefault() }}
      onDrop={onDrop}
    >
      <div
        className="panel-header"
        onDoubleClick={() => {
          if (track) openEdit(track.file.path)
        }}
        title={track ? 'Double-click to open the edit window' : undefined}
      >
        <span className="panel-title">{track ? 'Selected track' : 'Track details'}</span>
        <span className="panel-header-actions">
          <button className="panel-close" onClick={() => setCollapsed(true)} title="Collapse panel">
            ▼
          </button>
        </span>
      </div>
      <PanelField track={track} fieldKey="title" label="Title" commit={writeFields} onSaved={showToast} />
      <PanelField track={track} fieldKey="album" label="Album" commit={writeFields} onSaved={showToast} />
      <PanelField track={track} fieldKey="artist" label="Artist" commit={writeFields} onSaved={showToast} />
      <PanelField track={track} fieldKey="comment" label="Comment" commit={writeFields} onSaved={showToast} />
      <button
        className={'panel-cover' + (track ? ' has-track' : '')}
        onClick={() => { if (track) fileInput.current?.click() }}
        disabled={!track}
        title={track ? 'Set cover art — click, or drop / paste an image' : 'Select a track to edit'}
      >
        {track && track.cover ? (
          <img src={'data:' + track.cover.mime + ';base64,' + track.cover.data_base64} alt="Cover art" />
        ) : (
          <MusicArt />
        )}
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) pickCover(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}

function PanelField({
  track,
  fieldKey,
  label,
  commit,
  onSaved,
}: {
  track: Track | null
  fieldKey: string
  label: string
  commit: (path: string, fields: Record<string, string>) => Promise<string[]>
  onSaved: (text: string, kind: 'info' | 'success' | 'error') => void
}) {
  const [value, setValue] = useState(track ? track.fields[fieldKey] ?? '' : '')
  const [editing, setEditing] = useState(false)
  const [lastSync, setLastSync] = useState<{ path: string; value: string }>({
    path: track?.file.path ?? '',
    value: track ? track.fields[fieldKey] ?? '' : '',
  })

  const currentFieldValue = track ? track.fields[fieldKey] ?? '' : ''
  const currentPath = track?.file.path ?? ''
  if (lastSync.path !== currentPath || lastSync.value !== currentFieldValue) {
    setLastSync({ path: currentPath, value: currentFieldValue })
    setValue(currentFieldValue)
  }

  const save = async () => {
    setEditing(false)
    if (!track) return
    const current = track.fields[fieldKey] ?? ''
    if (value === current) return
    try {
      const warnings = await commit(track.file.path, { [fieldKey]: value })
      warnings.forEach((w) => onSaved(w, 'error'))
      if (!warnings.length) onSaved(label + ' saved', 'success')
    } catch (err) {
      onSaved(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="panel-field">
      <span className="field-label">{label}</span>
      <input
        value={value}
        placeholder="—"
        disabled={!track}
        onFocus={() => setEditing(true)}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setValue(track ? track.fields[fieldKey] ?? '' : '')
            setEditing(false)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        spellCheck={false}
        title={editing ? 'Enter to save, Esc to cancel' : label}
      />
    </div>
  )
}
