import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store-context'
import { formatDate, formatDuration, formatSize } from '../utils'
import { MusicArt } from './MusicArt'

interface DraftFields {
  filename: string
  title: string
  artist: string
  album: string
  year: string
  comment: string
  track_number: string
  disc_number: string
  composer: string
  genre: string
  bpm: string
}

const EDITABLE: { key: keyof DraftFields; label: string; field?: string; textarea?: boolean }[] = [
  { key: 'filename', label: 'Filename' },
  { key: 'title', label: 'Title', field: 'title' },
  { key: 'artist', label: 'Artist', field: 'artist' },
  { key: 'album', label: 'Album', field: 'album' },
  { key: 'year', label: 'Year', field: 'date' },
  { key: 'comment', label: 'Comment', field: 'comment', textarea: true },
]

const ADVANCED_EDITABLE: { key: keyof DraftFields; label: string; field: string }[] = [
  { key: 'track_number', label: 'Track Number', field: 'track_number' },
  { key: 'disc_number', label: 'Disc Number', field: 'disc_number' },
  { key: 'composer', label: 'Composer', field: 'composer' },
  { key: 'genre', label: 'Genre', field: 'genre' },
  { key: 'bpm', label: 'BPM', field: 'bpm' },
]

export function EditTrackOverlay() {
  const { tracks, editTrackPath, closeEdit, writeFields, setCover, removeCover, showToast } = useStore()
  const track = tracks.find((t) => t.file.path === editTrackPath) ?? null
  const [draft, setDraft] = useState<DraftFields | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [coverMenuOpen, setCoverMenuOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  // Window geometry: null = default centered size (720px wide). Dragging the
  // title bar moves it; the corner handle resizes it.
  const [win, setWin] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startY: number; x: number; y: number; w: number; h: number; mode: 'move' | 'resize' } | null>(null)

  const startMove = (e: React.PointerEvent) => {
    const el = overlayRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    dragRef.current = { startX: e.clientX, startY: e.clientY, x: rect.left, y: rect.top, w: rect.width, h: rect.height, mode: 'move' }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const startResize = (e: React.PointerEvent) => {
    const el = overlayRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    dragRef.current = { startX: e.clientX, startY: e.clientY, x: rect.left, y: rect.top, w: rect.width, h: rect.height, mode: 'resize' }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onGeometryMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (drag.mode === 'move') {
      const w = drag.w
      const h = drag.h
      const x = clamp(drag.x + dx, 8, window.innerWidth - w - 8)
      const y = clamp(drag.y + dy, 8, window.innerHeight - h - 8)
      setWin({ x, y, w, h })
    } else {
      const w = clamp(drag.w + dx, 560, window.innerWidth - 16)
      const h = clamp(drag.h + dy, 420, window.innerHeight - 16)
      setWin({ x: drag.x, y: drag.y, w, h })
    }
  }

  const endGeometry = () => {
    dragRef.current = null
  }

  // Initialise the draft when the edited track changes (render-phase
  // adjustment — the component unmounts when the overlay closes).
  const [draftKey, setDraftKey] = useState<string | null>(null)
  if (track && draftKey !== track.file.path) {
    setDraftKey(track.file.path)
    setDraft({
      filename: track.file.filename,
      title: track.fields.title ?? '',
      artist: track.fields.artist ?? '',
      album: track.fields.album ?? '',
      year: track.fields.date ?? '',
      comment: track.fields.comment ?? '',
      track_number: track.fields.track_number ?? '',
      disc_number: track.fields.disc_number ?? '',
      composer: track.fields.composer ?? '',
      genre: track.fields.genre ?? '',
      bpm: track.fields.bpm ?? '',
    })
    setMoreOpen(false)
    setCoverMenuOpen(false)
  }

  const dirty = useMemo(() => {
    if (!track || !draft) return false
    return (
      draft.filename !== track.file.filename ||
      draft.title !== (track.fields.title ?? '') ||
      draft.artist !== (track.fields.artist ?? '') ||
      draft.album !== (track.fields.album ?? '') ||
      draft.year !== (track.fields.date ?? '') ||
      draft.comment !== (track.fields.comment ?? '') ||
      draft.track_number !== (track.fields.track_number ?? '') ||
      draft.disc_number !== (track.fields.disc_number ?? '') ||
      draft.composer !== (track.fields.composer ?? '') ||
      draft.genre !== (track.fields.genre ?? '') ||
      draft.bpm !== (track.fields.bpm ?? '')
    )
  }, [track, draft])

  const onPickCover = useCallback(async (file: File) => {
    if (!track) return
    if (file.size > 10 * 1024 * 1024) {
      showToast('Cover image is larger than 10 MB', 'error')
      return
    }
    const dataUrl = await readAsDataUrl(file)
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'))
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    try {
      await setCover(track.file.path, mime, b64)
      setCoverMenuOpen(false)
      showToast('Cover art updated', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }, [track, setCover, showToast])

  useEffect(() => {
    const onWindowPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      const items = Array.from(e.clipboardData?.items ?? [])
      const image = items.find((i) => i.type.startsWith('image/'))
      if (!image) return
      e.preventDefault()
      const file = image.getAsFile()
      if (file) onPickCover(file)
    }
    window.addEventListener('paste', onWindowPaste)
    return () => window.removeEventListener('paste', onWindowPaste)
  })

  if (!track || !draft) return null

  const set = (key: keyof DraftFields, value: string) => setDraft((d) => (d ? { ...d, [key]: value } : d))

  const save = async () => {
    if (!dirty) {
      closeEdit()
      return
    }
    setSaving(true)
    try {
      const fields: Record<string, string> = {}
      for (const row of EDITABLE) {
        if (row.field) fields[row.field] = draft[row.key]
      }
      for (const row of ADVANCED_EDITABLE) {
        fields[row.field] = draft[row.key]
      }
      const warnings = await writeFields(
        track.file.path,
        fields,
        draft.filename !== track.file.filename ? draft.filename : null,
      )
      warnings.forEach((w) => showToast(w, 'error'))
      showToast(warnings.length ? 'Saved with warnings' : 'Saved', 'success')
      closeEdit()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }


  const onRemoveCover = async () => {
    try {
      await removeCover(track.file.path)
      setCoverMenuOpen(false)
      showToast('Cover art removed', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const codec = [track.audio?.codec, track.audio?.codec_detail].filter(Boolean).join(' ') || '—'
  const bitrate = track.audio?.bitrate_kbps != null ? formatBitrate(track.audio.bitrate_kbps) : '—'
  const sampleRate = track.audio?.sample_rate_hz != null ? (track.audio.sample_rate_hz / 1000).toFixed(1) + ' kHz' : '—'

  return (
    <div className="overlay-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !dirty) closeEdit() }}>
      <div
        className="overlay wide"
        ref={overlayRef}
        style={
          win
            ? { position: 'fixed', left: win.x, top: win.y, width: win.w, height: win.h, maxWidth: 'none', maxHeight: 'none' }
            : undefined
        }
      >
        <div
          className="overlay-titlebar"
          onPointerDown={startMove}
          onPointerMove={onGeometryMove}
          onPointerUp={endGeometry}
        >
          <span className="title">Edit Track</span>
          <button className="overlay-close" onClick={() => (dirty ? window.confirm('Discard unsaved changes?') && closeEdit() : closeEdit())} title="Close (Esc)">
            ✕
          </button>
        </div>

        <div className="overlay-body">
          <div className="edit-top">
            <div className="edit-cover- col">
              <div
                className="cover-box-wrap"
                onDragOver={(e) => {
                  const has = Array.from(e.dataTransfer?.items ?? []).some((i) => i.type.startsWith('image/'))
                  if (has) e.preventDefault()
                }}
                onDrop={(e) => {
                  const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith('image/'))
                  if (file) {
                    e.preventDefault()
                    onPickCover(file)
                  }
                }}
              >
                <button className="cover-box" onClick={() => setCoverMenuOpen(!coverMenuOpen)} title="Cover art options — or drop an image here">
                  {track.cover ? (
                    <img src={'data:' + track.cover.mime + ';base64,' + track.cover.data_base64} alt="Cover art" />
                  ) : (
                    <MusicArt />
                  )}
                </button>
                {coverMenuOpen && (
                  <div className="cover-menu">
                    <button className="cover-menu-btn" onClick={() => fileInput.current?.click()}>
                      Choose image…
                    </button>
                    {track.cover && (
                      <button className="cover-menu-btn danger" onClick={onRemoveCover}>
                        Remove cover art
                      </button>
                    )}
                  </div>
                )}
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) onPickCover(file)
                  e.target.value = ''
                }}
              />
              <span className="cover-caption">
                Length: {formatDuration(track.audio?.duration_seconds ?? null)} — Size: {formatSize(track.file.size_bytes)}
              </span>
            </div>

            <div className="edit-fields">
              {EDITABLE.map((row) =>
                row.textarea ? (
                  <div className="edit-row textarea-row" key={row.key}>
                    <span className="field-label">{row.label}</span>
                    <textarea
                      className="input comment-area"
                      value={draft[row.key]}
                      onChange={(e) => set(row.key, e.target.value)}
                      spellCheck={false}
                      rows={3}
                    />
                  </div>
                ) : (
                  <div className="edit-row" key={row.key}>
                    <span className="field-label">{row.label}</span>
                    <input className="input" value={draft[row.key]} onChange={(e) => set(row.key, e.target.value)} spellCheck={false} />
                  </div>
                ),
              )}
            </div>
          </div>

          <div className={'more-info' + (moreOpen ? ' open' : '')}>
            <button className="more-info-toggle" onClick={() => setMoreOpen(!moreOpen)}>
              <span className="chevron">▼</span> More info
            </button>
            {moreOpen && (
              <div className="more-info-grid">
                {ADVANCED_EDITABLE.map((row) => (
                  <div className="edit-row" key={row.key}>
                    <span className="field-label">{row.label}</span>
                    <input className="input" value={draft[row.key]} onChange={(e) => set(row.key, e.target.value)} spellCheck={false} />
                  </div>
                ))}
                <ReadonlyRow label="Date Created" value={formatDate(track.file.created_unix)} />
                <ReadonlyRow label="Date Modified" value={formatDate(track.file.modified_unix)} />
                <ReadonlyRow label="Codec" value={codec} />
                <ReadonlyRow label="Bitrate" value={bitrate} />
                <ReadonlyRow label="Sample Rate" value={sampleRate} />
                <ReadonlyRow label="Channels" value={track.audio?.channels != null ? String(track.audio.channels) : '—'} />
              </div>
            )}
          </div>
        </div>

        <div className="overlay-footer">
          <button className="text-btn" onClick={() => (dirty ? window.confirm('Discard unsaved changes?') && closeEdit() : closeEdit())}>
            Cancel
          </button>
          <button className="save-btn" onClick={save} disabled={saving || !track.writable}>
            {track.writable ? (saving ? 'Saving…' : 'Save') : 'Read-only format'}
          </button>
        </div>
        <div
          className="overlay-resize"
          onPointerDown={startResize}
          onPointerMove={onGeometryMove}
          onPointerUp={endGeometry}
          title="Drag to resize"
        />
      </div>
    </div>
  )
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}

function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="edit-row">
      <span className="field-label">{label}</span>
      <span className="readonly-value">{value || '—'}</span>
    </div>
  )
}

function formatBitrate(kbps: number): string {
  return kbps >= 1000 ? (kbps / 1000).toFixed(1) + ' Mbps' : kbps + ' kbps'
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
