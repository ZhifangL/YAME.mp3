import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store-context'
import type { Track } from '../types'
import { MusicArt } from './MusicArt'

export function DetailPanel() {
  const { tracks, selectedPaths, writeFields, setCover, showToast, openEdit } = useStore()
  const track = tracks.find((t) => selectedPaths.includes(t.file.path)) ?? null
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [posKey, setPosKey] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const containerRef = useRef<HTMLElement | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // Reset position and expansion when a different track gets selected
  // (render-phase adjustment — the React-recommended alternative to effects).
  if (track && posKey !== track.file.path) {
    setPosKey(track.file.path)
    setPos(null)
    setCollapsed(false)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const panel = panelRef.current
    if (!panel) return
    const container = panel.parentElement
    if (!container) return
    containerRef.current = container
    const rect = panel.getBoundingClientRect()
    const cRect = container.getBoundingClientRect()
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: pos ? pos.x : rect.left - cRect.left,
      origY: pos ? pos.y : rect.top - cRect.top,
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    const container = containerRef.current
    if (!drag || !container) return
    const cRect = container.getBoundingClientRect()
    const panel = panelRef.current
    const width = panel ? panel.offsetWidth : 296
    const height = panel ? panel.offsetHeight : 420
    const x = Math.min(Math.max(drag.origX + (e.clientX - drag.startX), 8), cRect.width - width - 8)
    const y = Math.min(Math.max(drag.origY + (e.clientY - drag.startY), 8), cRect.height - height - 8)
    setPos({ x, y })
  }

  const onPointerUp = () => {
    dragRef.current = null
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
      const dataUrl = await readAsDataUrl(file)
      const mime = dataUrl.slice(5, dataUrl.indexOf(';'))
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      try {
        await setCover(track.file.path, mime, b64)
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

  const style = pos
    ? { left: pos.x, top: pos.y }
    : { right: 20, bottom: 52 }

  const title = track?.fields.title || 'No track selected'
  const artist = track?.fields.artist || ''

  if (collapsed) {
    return (
      <div className={'detail-panel collapsed' + (track ? '' : ' empty')} ref={panelRef} style={style}>
        <div className="panel-header" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
          <span className="panel-collapsed-title">
            {track ? title + (artist ? ' — ' + artist : '') : 'Select a track'}
          </span>
          <button className="panel-close" onClick={() => setCollapsed(false)} title="Expand">
            ▲
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={'detail-panel' + (track ? '' : ' empty')}
      ref={panelRef}
      style={style}
      onPaste={onPaste}
      onDragOver={(e) => { if (track) e.preventDefault() }}
      onDrop={onDrop}
    >
      <div className="panel-header" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <span className="panel-title">{track ? 'Selected track' : 'Track details'}</span>
        <span className="panel-header-actions">
          {track && (
            <button className="panel-close" onClick={() => openEdit(track.file.path)} title="Open edit window (double-click also works)">
              ⤢
            </button>
          )}
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
      {!track && <p className="panel-hint">Select a track in the list to edit its tags and artwork.</p>}
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

  // Sync local value with the store when the track or its tags change
  // externally (render-phase adjustment instead of an effect).
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

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
