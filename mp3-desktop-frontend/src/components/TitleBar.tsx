import { useEffect, useRef } from 'react'
import { savePlaylistFile } from '../desktop'
import { hostPlatform, isTauri } from '../env'
import { pickMusic } from '../pickers-helpers'
import { useStore } from '../store-context'
import { WindowControls } from './WindowControls'
import { useWindowDrag } from '../useWindowChrome'

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  )
}

export function TitleBar() {
  const { search, setSearch, tracks, selectedPaths, showToast, importPaths, showAbout } = useStore()
  const searchInput = useRef<HTMLInputElement>(null)
  const barRef = useWindowDrag()

  // Windows and Linux draw their own title bar, so they get our own caption
  // buttons. macOS keeps its traffic lights, which live inside this same bar.
  const drawsOwnChrome = isTauri() && hostPlatform() !== 'macos'

  // Ctrl+F / Cmd+F reaches the menu bar's Search item, which the menu handler
  // routes here. Focus directly so the caret lands in the field.
  useEffect(() => {
    const focus = () => {
      searchInput.current?.focus()
      searchInput.current?.select()
    }
    window.addEventListener('yame://focus-search', focus)
    return () => window.removeEventListener('yame://focus-search', focus)
  }, [])

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
      (chosen[0].file.path.split(/[/\\]/).slice(0, -1).pop() || 'YAME').replace(/[^\w\- ]+/g, '').trim() || 'YAME'
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
        <button onClick={showAbout} title="About YAME.mp3">
          Help
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

      {drawsOwnChrome && <WindowControls />}
    </header>
  )
}
