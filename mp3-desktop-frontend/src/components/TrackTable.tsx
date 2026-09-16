import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { copyFiles, openWithChooser, openWithDefault, pasteFiles, revealInFinder } from '../desktop'
import { pickMusic } from '../pickers-helpers'
import { useStore, type SortKey } from '../store-context'
import type { Track } from '../types'
import { formatDuration, formatSize, yearOf } from '../utils'

interface Column {
  key: SortKey
  label: string
  className: string
  value: (t: Track) => string | number
}

const ALL_COLUMNS: Column[] = [
  { key: 'filename', label: 'Filename', className: 'col-filename', value: (t) => t.file.filename },
  { key: 'title', label: 'Title', className: 'col-title', value: (t) => t.fields.title ?? '' },
  { key: 'artist', label: 'Artist', className: 'col-artist', value: (t) => t.fields.artist ?? '' },
  { key: 'album', label: 'Album', className: 'col-album', value: (t) => t.fields.album ?? '' },
  { key: 'album_artist', label: 'Album Artist', className: 'col-albumartist', value: (t) => t.fields.album_artist ?? '' },
  { key: 'year', label: 'Year', className: 'col-year', value: (t) => yearOf(t) },
  { key: 'track_number', label: 'Track', className: 'col-track', value: (t) => t.fields.track_number ?? '' },
  { key: 'disc_number', label: 'Disc', className: 'col-disc', value: (t) => t.fields.disc_number ?? '' },
  { key: 'genre', label: 'Genre', className: 'col-genre', value: (t) => t.fields.genre ?? '' },
  { key: 'composer', label: 'Composer', className: 'col-composer', value: (t) => t.fields.composer ?? '' },
  { key: 'duration', label: 'Length', className: 'col-duration', value: (t) => t.audio?.duration_seconds ?? 0 },
  { key: 'size', label: 'Size', className: 'col-size', value: (t) => t.file.size_bytes },
  { key: 'comment', label: 'Comment', className: 'col-comment', value: (t) => t.fields.comment ?? '' },
]

const ALL_BY_KEY = new Map(ALL_COLUMNS.map((c) => [c.key, c]))

const DEFAULT_WIDTHS: Record<SortKey, number> = {
  filename: 250,
  title: 200,
  artist: 160,
  album: 170,
  album_artist: 160,
  year: 62,
  track_number: 56,
  disc_number: 56,
  genre: 120,
  composer: 160,
  duration: 72,
  size: 76,
  comment: 240,
}

interface ColumnState {
  order: SortKey[]
  frozen: SortKey[]
  hidden: SortKey[]
  widths: Record<string, number>
}

const COLUMN_STATE_KEY = 'tagforge.columns.v1'
const DEFAULT_ORDER = ALL_COLUMNS.map((c) => c.key)

function loadColumnState(): ColumnState {
  const state: ColumnState = { order: [...DEFAULT_ORDER], frozen: ['filename'], hidden: [], widths: { ...DEFAULT_WIDTHS } }
  try {
    const raw = localStorage.getItem(COLUMN_STATE_KEY)
    if (!raw) return state
    const parsed = JSON.parse(raw) as Partial<ColumnState>
    const valid = (k: string): k is SortKey => ALL_BY_KEY.has(k as SortKey)
    if (Array.isArray(parsed.order)) {
      const order = parsed.order.filter(valid)
      for (const k of DEFAULT_ORDER) if (!order.includes(k)) order.push(k)
      state.order = order
    }
    if (Array.isArray(parsed.frozen)) state.frozen = parsed.frozen.filter(valid)
    if (Array.isArray(parsed.hidden)) state.hidden = parsed.hidden.filter(valid)
    if (parsed.widths && typeof parsed.widths === 'object') {
      for (const [k, v] of Object.entries(parsed.widths)) {
        if (valid(k) && typeof v === 'number') state.widths[k] = v
      }
    }
  } catch {
    /* corrupt state — fall back to defaults */
  }
  return state
}

interface FreezeMenu {
  x: number
  y: number
  key: SortKey
}

interface RowMenu {
  x: number
  y: number
  path: string
}

function FolderIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      <path d="M9.5 13.5l1.8 1.8 3.4-3.6" />
    </svg>
  )
}

export function TrackTable() {
  const {
    tracks,
    loadingTracks,
    engineError,
    selectedPaths,
    search,
    sortKey,
    sortDir,
    registry,
    toggleSelect,
    selectRange,
    clearSelection,
    openEdit,
    removeTrack,
    folderPath,
    appendPaths,
    replacePaths,
    showToast,
  } = useStore()
  const lastIndex = useRef<number | null>(null)
  const [colState, setColState] = useState<ColumnState>(loadColumnState)
  const [freezeMenu, setFreezeMenu] = useState<FreezeMenu | null>(null)
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null)
  const [hoveredPath, setHoveredPath] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  // Persist column layout (order, freeze, visibility, widths) across sessions.
  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_STATE_KEY, JSON.stringify(colState))
    } catch {
      /* storage unavailable — session-only layout */
    }
  }, [colState])

  // Close menus on outside interactions (but keep clicks inside them alive).
  useEffect(() => {
    if (!freezeMenu && !rowMenu) return
    const close = (e: Event) => {
      const target = e.target as HTMLElement
      if (e.type === 'mousedown' && (target.closest?.('.freeze-menu') || target.closest?.('.row-menu'))) return
      setFreezeMenu(null)
      setRowMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [freezeMenu, rowMenu])

  // Ctrl/Cmd+A selects every track.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'a' || !(e.metaKey || e.ctrlKey)) return
      const target = e.target as HTMLElement
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      e.preventDefault()
      clearSelection()
      selectRange(tracks.map((t) => t.file.path))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tracks, clearSelection, selectRange])

  const frozenSet = new Set(colState.frozen)
  const hiddenSet = new Set(colState.hidden)
  const columns = useMemo(() => {
    const ordered = colState.order.map((k) => ALL_BY_KEY.get(k)!).filter(Boolean)
    return ordered.filter((c) => !hiddenSet.has(c.key))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colState.order, colState.hidden])
  const frozenCols = columns.filter((c) => frozenSet.has(c.key))
  const mainCols = columns.filter((c) => !frozenSet.has(c.key))

  const toggleFreeze = (key: SortKey) => {
    setColState((cur) => ({
      ...cur,
      frozen: cur.frozen.includes(key) ? cur.frozen.filter((k) => k !== key) : [...cur.frozen, key],
    }))
  }

  const toggleHidden = (key: SortKey) => {
    setColState((cur) => ({
      ...cur,
      // Hidden columns keep their frozen flag so it persists while unviewed.
      hidden: cur.hidden.includes(key) ? cur.hidden.filter((k) => k !== key) : [...cur.hidden, key],
    }))
  }

  // Move a column within its pane (frozen ↔ frozen, unfrozen ↔ unfrozen),
  // inserting before or after the target column.
  const moveColumn = (dragKey: SortKey, targetKey: SortKey, side: 'before' | 'after') => {
    if (dragKey === targetKey) return
    setColState((cur) => {
      const bothFrozen = frozenSet.has(dragKey) && frozenSet.has(targetKey)
      const bothUnfrozen = !frozenSet.has(dragKey) && !frozenSet.has(targetKey)
      if (!bothFrozen && !bothUnfrozen) return cur
      const order = [...cur.order]
      const from = order.indexOf(dragKey)
      if (from === -1) return cur
      order.splice(from, 1)
      const targetIndex = order.indexOf(targetKey)
      if (targetIndex === -1) return cur
      const insertAt = side === 'before' ? targetIndex : targetIndex + 1
      order.splice(insertAt, 0, dragKey)
      return { ...cur, order }
    })
  }

  // Column resize (edge drag on headers only).
  const resizeRef = useRef<{ key: SortKey; startX: number; startW: number } | null>(null)
  const onResizeDown = (e: React.PointerEvent, key: SortKey) => {
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { key, startX: e.clientX, startW: colState.widths[key] ?? DEFAULT_WIDTHS[key] }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current
    if (!r) return
    const w = Math.max(40, Math.min(900, r.startW + (e.clientX - r.startX)))
    setColState((cur) => ({ ...cur, widths: { ...cur.widths, [r.key]: w } }))
  }
  const onResizeUp = () => {
    resizeRef.current = null
  }

  // Column reorder (drag the header body; HTML5 drag & drop).
  //
  // A gap between two columns can be named two ways: "after A" or "before B".
  // Drawing both would put two different-looking indicators on the same gap
  // (A's right edge and B's left edge), so every gap is normalised to the
  // "before B" form. Only the very last column in a pane keeps an "after",
  // because there is no following column to point at.
  const [overKey, setOverKey] = useState<SortKey | null>(null)
  const [overSide, setOverSide] = useState<'before' | 'after' | null>(null)
  const frozenPaneRef = useRef<HTMLTableElement>(null)
  const mainPaneRef = useRef<HTMLTableElement>(null)

  const normalizeInsertion = (
    key: SortKey,
    side: 'before' | 'after',
  ): { key: SortKey; side: 'before' | 'after' } => {
    if (side === 'before') return { key, side }
    const cols = frozenSet.has(key) ? frozenCols : mainCols
    const index = cols.findIndex((c) => c.key === key)
    const next = index >= 0 ? cols[index + 1] : undefined
    return next ? { key: next.key, side: 'before' } : { key, side: 'after' }
  }

  // While a header drag is in flight, watch the whole window so drops that
  // land beyond the table edges (e.g. to the left of the first column) still
  // work: past the left edge = insert before the first column, past the right
  // edge = insert after the last one. The listeners attach synchronously in
  // dragstart so even immediate drops are caught.
  const dragInfoRef = useRef<{ key: SortKey; frozen: boolean } | null>(null)

  const edgeAt = (x: number): { key: SortKey; side: 'before' | 'after' } | null => {
    const info = dragInfoRef.current
    if (!info) return null
    const pane = info.frozen ? frozenPaneRef.current : mainPaneRef.current
    const cols = info.frozen ? frozenCols : mainCols
    if (!pane || !cols.length) return null
    const rect = pane.getBoundingClientRect()
    if (x < rect.left) return { key: cols[0].key, side: 'before' }
    if (x > rect.right) return { key: cols[cols.length - 1].key, side: 'after' }
    return null
  }

  const onWindowDragOver = (e: DragEvent) => {
    if ((e.target as HTMLElement).closest?.('th')) return // header handler owns it
    const edge = edgeAt(e.clientX)
    if (!edge) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    setOverKey(edge.key)
    setOverSide(edge.side)
  }

  const onWindowDrop = (e: DragEvent) => {
    if ((e.target as HTMLElement).closest?.('th')) return
    const edge = edgeAt(e.clientX)
    setOverKey(null)
    setOverSide(null)
    const info = dragInfoRef.current
    if (edge && info) moveColumn(info.key, edge.key, edge.side)
  }

  const onHeaderDragStart = (e: React.DragEvent, key: SortKey) => {
    e.dataTransfer.setData('text/plain', key)
    e.dataTransfer.effectAllowed = 'move'
    dragInfoRef.current = { key, frozen: frozenSet.has(key) }
    window.addEventListener('dragover', onWindowDragOver)
    window.addEventListener('drop', onWindowDrop)
  }

  // Which gap the cursor is currently over, in normalised form.
  const insertionAt = (e: React.DragEvent, key: SortKey) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const side: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
    return normalizeInsertion(key, side)
  }

  const onHeaderDragOver = (e: React.DragEvent, key: SortKey) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const insertion = insertionAt(e, key)
    setOverKey(insertion.key)
    setOverSide(insertion.side)
  }
  const onHeaderDrop = (e: React.DragEvent, key: SortKey) => {
    e.preventDefault()
    const dragKey = e.dataTransfer.getData('text/plain') as SortKey
    setOverKey(null)
    setOverSide(null)
    // Decide the insertion gap from the drop position itself (the dragover
    // state may not have committed yet when drop lands right after it).
    const insertion = insertionAt(e, key)
    if (dragKey && dragKey !== insertion.key) moveColumn(dragKey, insertion.key, insertion.side)
  }
  const onHeaderDragEnd = () => {
    window.removeEventListener('dragover', onWindowDragOver)
    window.removeEventListener('drop', onWindowDrop)
    dragInfoRef.current = null
    setOverKey(null)
    setOverSide(null)
  }

  const frozenWidth = frozenCols.reduce((sum, c) => sum + (colState.widths[c.key] ?? DEFAULT_WIDTHS[c.key]), 0)
  const totalWidth = columns.reduce((sum, c) => sum + (colState.widths[c.key] ?? DEFAULT_WIDTHS[c.key]), 0)

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    let list = tracks
    if (query) {
      list = tracks.filter((t) => {
        const hay = [
          t.file.filename,
          t.fields.title,
          t.fields.artist,
          t.fields.album,
          t.fields.album_artist,
          t.fields.genre,
          t.fields.composer,
          t.fields.comment,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return query.split(/\s+/).every((part) => hay.includes(part))
      })
    }
    if (!sortKey) return [...list] // natural (folder) order
    const col = columns.find((c) => c.key === sortKey)
    if (!col) return [...list]
    return [...list].sort((a, b) => {
      const av = col.value(a)
      const bv = col.value(b)
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * sortDir
    })
  }, [tracks, search, sortKey, sortDir, columns])

  const handleClick = (e: React.MouseEvent, track: Track, index: number) => {
    const additive = e.metaKey || e.ctrlKey
    if (e.shiftKey && lastIndex.current != null && !additive) {
      const start = Math.min(lastIndex.current, index)
      const end = Math.max(lastIndex.current, index)
      selectRange(visible.slice(start, end + 1).map((t) => t.file.path))
      return
    }
    toggleSelect(track.file.path, additive)
    lastIndex.current = index
  }

  const onRowContext = (e: React.MouseEvent, path: string) => {
    e.preventDefault()
    if (!selectedPaths.includes(path)) {
      clearSelection()
      selectRange([path])
    }
    setRowMenu({ x: e.clientX, y: e.clientY, path })
  }

  const rowAction = async (action: string) => {
    if (!rowMenu) return
    const path = rowMenu.path
    setRowMenu(null)
    try {
      switch (action) {
        case 'open':
          await openWithDefault(path)
          break
        case 'open-with':
          await openWithChooser(path)
          break
        case 'copy':
          await copyFiles(selectedPaths.includes(path) && selectedPaths.length > 1 ? selectedPaths : [path])
          showToast('Copied ' + (selectedPaths.length > 1 ? selectedPaths.length + ' files' : 'file') + ' to the clipboard', 'success')
          break
        case 'paste': {
          const paths = await pasteFiles(folderPath)
          if (paths.length) await appendPaths(paths)
          else showToast('No audio files on the clipboard', 'info')
          break
        }
        case 'remove':
          removeTrack(path)
          break
        case 'finder':
          await revealInFinder(path)
          break
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'info')
    }
  }

  const onDragOver = (e: React.DragEvent) => {
    const hasFiles = Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === 'file')
    if (hasFiles) {
      e.preventDefault()
      setDragOver(true)
    }
  }

  const onDragLeave = () => setDragOver(false)

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const suffixes = new Set(registry?.audio_suffixes?.length ? registry.audio_suffixes : FALLBACK_AUDIO_EXTENSIONS)
    const items = Array.from(e.dataTransfer?.items ?? [])
    const names: string[] = []
    let folderPick: { name: string; entries: string[] } | null = null
    for (const item of items) {
      if (item.kind !== 'file') continue
      const entry = (item as unknown as { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()
      if (entry && entry.isDirectory) {
        if (!folderPick) folderPick = await readDirEntries(entry as FileSystemDirectoryEntry)
      } else {
        const file = item.getAsFile()
        if (file && isAudioFile(file.name, suffixes)) names.push(file.name)
      }
    }
    if (folderPick) {
      try {
        const res = await api.resolveFolder(folderPick.name, folderPick.entries, folderPath)
        if (res.path) {
          const browse = await api.browse(res.path, true)
          if (browse.audio_files.length) await replacePaths(browse.audio_files.map((f) => f.path))
          else showToast('No audio files in that folder', 'info')
        } else {
          showToast('Could not locate the dropped folder on disk', 'error')
        }
      } catch {
        showToast('Could not locate the dropped folder on disk', 'error')
      }
    } else if (names.length) {
      try {
        const res = await api.resolveFiles(names, folderPath)
        if (res.paths.length) await replacePaths(res.paths)
        const missing = names.length - res.paths.length
        if (missing > 0) showToast(missing + ' file(s) could not be located', 'error')
        if (!res.paths.length) showToast('Could not locate the dropped files on disk', 'error')
      } catch {
        showToast('Could not locate the dropped files on disk', 'error')
      }
    }
  }

  if (loadingTracks) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <FolderIcon />
        </div>
        <p>Reading tags…</p>
      </div>
    )
  }

  if (!tracks.length) {
    return (
      <div
        className={'empty-state' + (dragOver ? ' drop-active' : '')}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="empty-icon">
          <FolderIcon />
        </div>
        <h2>Add music to get started</h2>
        <p>
          Pick a folder — or drop files and folders here — and TagForge reads every supported
          tag so you can fix them in bulk with rules.
        </p>
        <div className="empty-actions">
          <button className="primary-btn" onClick={() => pickMusic('replace')}>
            Add music
          </button>
        </div>
        {dragOver && <div className="drop-hint">Drop to replace the list</div>}
        {engineError && <div className="engine-error">{engineError}</div>}
      </div>
    )
  }

  const onHeaderContext = (e: React.MouseEvent, key: SortKey) => {
    e.preventDefault()
    setFreezeMenu({ x: e.clientX, y: e.clientY, key })
  }

  return (
    <div
      className={'table-wrap' + (dragOver ? ' drop-active' : '')}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && <div className="drop-hint">Drop to replace the list</div>}
      <div
        className="table-scroll"
        onClick={(e) => {
          if (e.target === e.currentTarget) clearSelection()
        }}
      >
        <div className="table-panes" style={{ width: frozenWidth + totalWidth }}>
          {frozenCols.length > 0 && (
            <table ref={frozenPaneRef} className="tracks frozen-pane" style={{ width: frozenWidth }}>
              <thead>
                <tr>
                  {frozenCols.map((col) => (
                    <SortableHeader
                      key={col.key}
                      col={col}
                      width={colState.widths[col.key] ?? DEFAULT_WIDTHS[col.key]}
                      over={overKey === col.key}
                      onContextMenu={onHeaderContext}
                      onResizeDown={onResizeDown}
                      onResizeMove={onResizeMove}
                      onResizeUp={onResizeUp}
                      onDragStart={onHeaderDragStart}
                      onDragOver={onHeaderDragOver}
                      onDrop={onHeaderDrop}
                      onDragEnd={onHeaderDragEnd}
                      overSide={overSide}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((track, index) => (
                  <TableRow
                    key={track.file.path}
                    cols={frozenCols}
                    track={track}
                    index={index}
                    selected={selectedPaths.includes(track.file.path)}
                    hovered={hoveredPath === track.file.path}
                    onHover={setHoveredPath}
                    onClick={(e) => handleClick(e, track, index)}
                    onDoubleClick={() => openEdit(track.file.path)}
                    onContextMenu={(e) => onRowContext(e, track.file.path)}
                  />
                ))}
              </tbody>
            </table>
          )}
          <table ref={mainPaneRef} className="tracks main-pane" style={{ width: totalWidth }}>
            <thead>
              <tr>
                {mainCols.map((col) => (
                  <SortableHeader
                    key={col.key}
                    col={col}
                    width={colState.widths[col.key] ?? DEFAULT_WIDTHS[col.key]}
                    over={overKey === col.key}
                    onContextMenu={onHeaderContext}
                    onResizeDown={onResizeDown}
                    onResizeMove={onResizeMove}
                    onResizeUp={onResizeUp}
                    onDragStart={onHeaderDragStart}
                    onDragOver={onHeaderDragOver}
                    onDrop={onHeaderDrop}
                    onDragEnd={onHeaderDragEnd}
                    overSide={overSide}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((track, index) => (
                <TableRow
                  key={track.file.path}
                  cols={mainCols}
                  track={track}
                  index={index}
                  selected={selectedPaths.includes(track.file.path)}
                  hovered={hoveredPath === track.file.path}
                  onHover={setHoveredPath}
                  onClick={(e) => handleClick(e, track, index)}
                  onDoubleClick={() => openEdit(track.file.path)}
                  onContextMenu={(e) => onRowContext(e, track.file.path)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {freezeMenu && (
        <div className="freeze-menu" style={{ left: freezeMenu.x, top: freezeMenu.y }}>
          <button
            className="freeze-action"
            onClick={() => {
              toggleFreeze(freezeMenu.key)
              setFreezeMenu(null)
            }}
          >
            {frozenSet.has(freezeMenu.key) ? 'Unfreeze column' : 'Freeze column'}
          </button>
          <div className="freeze-divider" />
          {ALL_COLUMNS.map((col) => (
            <button
              key={col.key}
              className="column-toggle"
              onClick={() => toggleHidden(col.key)}
              title={'Show/hide the ' + col.label + ' column'}
            >
              <span className="tick">{hiddenSet.has(col.key) ? ' ' : '✓'}</span>
              {col.label}
            </button>
          ))}
          {/*<div className="freeze-hint">Right-click to freeze it · drag headers to reorder · drag the edge to resize</div>*/}
        </div>
      )}

      {rowMenu && (
        <div className="row-menu" style={{ left: rowMenu.x, top: rowMenu.y }}>
          <button onClick={() => rowAction('open')}>Open</button>
          <button onClick={() => rowAction('open-with')}>Open with…</button>
          <div className="freeze-divider" />
          <button onClick={() => rowAction('copy')}>Copy</button>
          <button onClick={() => rowAction('paste')}>Paste</button>
          <div className="freeze-divider" />
          <button onClick={() => rowAction('remove')}>Remove from list</button>
          <button onClick={() => rowAction('finder')}>Show in Finder</button>
        </div>
      )}
    </div>
  )
}

function TableRow({
  cols,
  track,
  index,
  selected,
  hovered,
  onHover,
  onClick,
  onDoubleClick,
  onContextMenu,
}: {
  cols: Column[]
  track: Track
  index: number
  selected: boolean
  hovered: boolean
  onHover: (path: string | null) => void
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  return (
    <tr
      className={(selected ? 'selected' : '') + (hovered ? ' hover' : '')}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => onHover(track.file.path)}
      onMouseLeave={() => onHover(null)}
      style={index === 0 ? { borderTop: 'none' } : undefined}
    >
      {cols.map((col) => (
        <td key={col.key} className={col.className + cellMutedClass(col, track)}>
          {cellText(col, track)}
        </td>
      ))}
    </tr>
  )
}

function cellText(col: Column, track: Track): string {
  switch (col.key) {
    case 'duration':
      return formatDuration(track.audio?.duration_seconds ?? null)
    case 'size':
      return formatSize(track.file.size_bytes)
    case 'year':
      return yearOf(track) || '—'
    default:
      return String(col.value(track) || '—')
  }
}

function cellMutedClass(col: Column, track: Track): string {
  // Only *empty* cells are muted — populated ones keep full contrast, so the
  // table reads as data rather than as a wall of grey.
  return String(col.value(track) || '') ? '' : ' muted'
}

function SortableHeader({
  col,
  width,
  over,
  overSide,
  onContextMenu,
  onResizeDown,
  onResizeMove,
  onResizeUp,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  col: Column
  width: number
  over: boolean
  overSide: 'before' | 'after' | null
  onContextMenu: (e: React.MouseEvent, key: SortKey) => void
  onResizeDown: (e: React.PointerEvent, key: SortKey) => void
  onResizeMove: (e: React.PointerEvent) => void
  onResizeUp: (e: React.PointerEvent) => void
  onDragStart: (e: React.DragEvent, key: SortKey) => void
  onDragOver: (e: React.DragEvent, key: SortKey) => void
  onDrop: (e: React.DragEvent, key: SortKey) => void
  onDragEnd: () => void
}) {
  const { sortKey, sortDir, cycleSort } = useStore()
  const sorted = sortKey === col.key
  return (
    <th
      className={
        col.className +
        (sorted ? ' sorted' : '') +
        (over ? (overSide === 'after' ? ' reorder-over ins-after' : ' reorder-over ins-before') : '')
      }
      style={{ width }}
      data-col={col.key}
      draggable
      onClick={() => cycleSort(col.key)}
      onContextMenu={(e) => onContextMenu(e, col.key)}
      onDragStart={(e) => onDragStart(e, col.key)}
      onDragOver={(e) => onDragOver(e, col.key)}
      onDrop={(e) => onDrop(e, col.key)}
      onDragEnd={onDragEnd}
      // title={'Sort by ' + col.label + ' · right-click to freeze/hide · drag to reorder · drag the edge to resize'}
      title={'Sort by ' + col.label}
    >
      {col.label}
      <span className="arrow">{sorted ? (sortDir === 1 ? '▲' : '▼') : '▽'}</span>
      <span
        className="col-resizer"
        onPointerDown={(e) => onResizeDown(e, col.key)}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
      />
    </th>
  )
}

const FALLBACK_AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.m4b', '.aac', '.mp4', '.flac', '.ogg', '.oga', '.opus', '.wav', '.wave', '.aiff', '.aif', '.wma', '.asf', '.mpc', '.ape', '.wv', '.tta'])

function isAudioFile(name: string, suffixes: Set<string>): boolean {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return suffixes.has(name.slice(dot).toLowerCase())
}

async function readDirEntries(dir: FileSystemDirectoryEntry): Promise<{ name: string; entries: string[] }> {
  const entries: string[] = []
  const read = (d: FileSystemDirectoryEntry, prefix: string): Promise<void> =>
    new Promise((resolve) => {
      const reader = d.createReader()
      const step = () => {
        reader.readEntries(
          async (batch) => {
            if (!batch.length) {
              resolve()
              return
            }
            for (const entry of batch) {
              if (entry.isFile) {
                entries.push(prefix + entry.name)
              } else if (entry.isDirectory) {
                await read(entry as FileSystemDirectoryEntry, prefix + entry.name + '/')
              }
            }
            step()
          },
          () => resolve(),
        )
      }
      step()
    })
  await read(dir, '')
  return { name: dir.name, entries }
}
