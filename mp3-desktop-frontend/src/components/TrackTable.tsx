import { useMemo, useRef } from 'react'
import { useStore, type SortKey } from '../store-context'
import type { Track } from '../types'
import { formatDuration, formatSize, yearOf } from '../utils'

interface Column {
  key: SortKey
  label: string
  className: string
  frozen?: boolean
  value: (t: Track) => string | number
}

const COLUMNS: Column[] = [
  { key: 'filename', label: 'Filename', className: 'col-filename', frozen: true, value: (t) => t.file.filename },
  { key: 'title', label: 'Title', className: 'col-title', frozen: true, value: (t) => t.fields.title ?? '' },
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
    toggleSelect,
    selectRange,
    clearSelection,
    openEdit,
    openFolderBrowser,
  } = useStore()
  const lastIndex = useRef<number | null>(null)

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
    const col = COLUMNS.find((c) => c.key === sortKey) ?? COLUMNS[0]
    return [...list].sort((a, b) => {
      const av = col.value(a)
      const bv = col.value(b)
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * sortDir
    })
  }, [tracks, search, sortKey, sortDir])

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
      <div className="empty-state">
        <div className="empty-icon">
          <FolderIcon />
        </div>
        <h2>Open a folder of music</h2>
        <p>
          TagForge reads the tags of every supported file and lets you fix them in bulk with a
          few rules — no scripting required.
        </p>
        <button className="primary-btn" onClick={openFolderBrowser}>
          Open folder
        </button>
        {engineError && <div className="engine-error">{engineError}</div>}
      </div>
    )
  }

  return (
    <div className="table-wrap">
      <div
        className="table-scroll"
        onClick={(e) => {
          // Clicking blank space below the rows clears the selection.
          if (e.target === e.currentTarget) clearSelection()
        }}
      >
        <table className="tracks">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <SortableHeader key={col.key} col={col} />
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((track, index) => {
              const selected = selectedPaths.includes(track.file.path)
              return (
                <tr
                  key={track.file.path}
                  className={selected ? 'selected' : ''}
                  onClick={(e) => handleClick(e, track, index)}
                  onDoubleClick={() => openEdit(track.file.path)}
                >
                  <td className="col-filename frozen">{track.file.filename}</td>
                  <td className={'col-title frozen' + (track.fields.title ? '' : ' muted')}>{track.fields.title || '—'}</td>
                  <td className={track.fields.artist ? '' : 'muted'}>{track.fields.artist || '—'}</td>
                  <td className={track.fields.album ? '' : 'muted'}>{track.fields.album || '—'}</td>
                  <td className="muted">{track.fields.album_artist || '—'}</td>
                  <td className="muted">{yearOf(track) || '—'}</td>
                  <td className="muted">{track.fields.track_number || '—'}</td>
                  <td className="muted">{track.fields.disc_number || '—'}</td>
                  <td className="muted">{track.fields.genre || '—'}</td>
                  <td className="muted">{track.fields.composer || '—'}</td>
                  <td className="muted">{formatDuration(track.audio?.duration_seconds ?? null)}</td>
                  <td className="muted">{formatSize(track.file.size_bytes)}</td>
                  <td className="muted">{track.fields.comment || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SortableHeader({ col }: { col: Column }) {
  const { sortKey, sortDir, cycleSort } = useStore()
  const sorted = sortKey === col.key
  return (
    <th
      className={col.className + (col.frozen ? ' frozen' : '') + (sorted ? ' sorted' : '')}
      onClick={() => cycleSort(col.key)}
      title={'Sort by ' + col.label}
    >
      {col.label}
      <span className="arrow">{sorted ? (sortDir === 1 ? '▲' : '▼') : '▽'}</span>
    </th>
  )
}
