import { useEffect, useRef } from 'react'
import { savePlaylistFile } from '../desktop'
import { isTauri } from '../env'
import { pickMusic } from '../pickers-helpers'
import { useStore } from '../store-context'

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  )
}

/** Let the header be dragged to move the window, the way a Mac title bar is. */
function useWindowDrag() {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const bar = ref.current
    if (!bar) return
    // Only the bar itself is a drag handle; buttons and the search field keep
    // their own clicks.
    const onMouseDown = async (e: MouseEvent) => {
      if (e.button !== 0 || e.detail > 1) return
      if ((e.target as HTMLElement).closest('button, input, a, .no-drag')) return
      const tauri = (window as unknown as {
        __TAURI__?: { window?: { getCurrentWindow(): { startDragging(): Promise<void> } } }
      }).__TAURI__
      try {
        await tauri?.window?.getCurrentWindow().startDragging()
      } catch {
        /* not running under Tauri, or the permission is missing */
      }
    }
    bar.addEventListener('mousedown', onMouseDown)
    return () => bar.removeEventListener('mousedown', onMouseDown)
  }, [])

  return ref
}

export function TitleBar() {
  const { search, setSearch, tracks, selectedPaths, showToast, importPaths } = useStore()
  const searchInput = useRef<HTMLInputElement>(null)
  const barRef = useWindowDrag()

  const createPlaylist = async () => {
    const chosen = tracks.filter((t) => selectedPaths.includes(t.file.path))
    if (!chosen.length) {
      showToast('Select at least one track first', 'info')
      return
    }
    const lines = ['#EXTM3U']
    for (const t of chosen) {
      const seconds = Math.round(t.audio?.duration_seconds ?? 0)
      if (seconds > 0) {
        lines.push('#EXTINF:' + seconds + ',' + (t.fields.artist || '') + ' - ' + (t.fields.title || t.file.filename))
      }
      lines.push(t.file.path)
    }
    const contents = lines.join('\n')
    const folderName =
      (chosen[0].file.path.split('/').slice(0, -1).pop() || 'YAME').replace(/[^\w\- ]+/g, '').trim() || 'YAME'
    const defaultName = folderName + ' playlist.m3u'

    // The packaged app gets a real save sheet, so the user picks the folder
    // and the file name; the browser falls back to a download.
    let savedPath: string | null
    try {
      savedPath = await savePlaylistFile(defaultName, contents)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
    if (savedPath === null && isTauri()) {
      return // the user cancelled the save sheet
    }
    if (savedPath === null) {
      const blob = new Blob([contents], { type: 'audio/x-mpegurl' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = defaultName
      a.click()
      URL.revokeObjectURL(url)
    }
    showToast(
      'Playlist saved (' + chosen.length + ' track' + (chosen.length === 1 ? '' : 's') + ')',
      'success',
    )
  }

  return (
    <header className="titlebar" ref={barRef}>
      <div className="wordmark">
        <span className="dot" />
        YAME.mp3
      </div>

      <div className="nav-divider" />

      <nav className="nav-actions no-drag">
        <button onClick={() => pickMusic('replace', importPaths)} title="Open music — replaces the current list">
          Open
        </button>
        <button onClick={() => pickMusic('append', importPaths)} title="Add music to the current list">
          Add
        </button>
        <button
          onClick={createPlaylist}
          disabled={selectedPaths.length === 0}
          title="Save an .m3u playlist of the selected tracks"
        >
          Create playlist
        </button>
      </nav>

      <div className="search-box no-drag" onClick={() => searchInput.current?.focus()}>
        <SearchIcon />
        <input
          id="yame-search"
          ref={searchInput}
          type="text"
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
      </div>
    </header>
  )
}
