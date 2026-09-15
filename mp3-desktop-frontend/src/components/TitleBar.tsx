import { useRef } from 'react'
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

export function TitleBar() {
  const { search, setSearch, tracks, selectedPaths, showToast } = useStore()
  const searchInput = useRef<HTMLInputElement>(null)

  const createPlaylist = () => {
    const chosen = tracks.filter((t) => selectedPaths.includes(t.file.path))
    if (!chosen.length) {
      showToast('Select at least one track first', 'info')
      return
    }
    const lines = ['#EXTM3U']
    for (const t of chosen) {
      const seconds = Math.round(t.audio?.duration_seconds ?? 0)
      if (seconds > 0) lines.push('#EXTINF:' + seconds + ',' + (t.fields.artist || '') + ' - ' + (t.fields.title || t.file.filename))
      lines.push(t.file.path)
    }
    const folderName = (chosen[0].file.path.split('/').slice(0, -1).pop() || 'TagForge').replace(/[^\w\- ]+/g, '').trim()
    const blob = new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = folderName + ' playlist.m3u'
    a.click()
    URL.revokeObjectURL(url)
    showToast('Playlist saved (' + chosen.length + ' track' + (chosen.length === 1 ? '' : 's') + ')', 'success')
  }

  return (
    <header className="titlebar">
      <div className="wordmark">
        <span className="dot" />
        TagForge
      </div>

      <div className="nav-divider" />

      <nav className="nav-actions">
        <button onClick={() => pickMusic('replace')} title="Open a folder — replaces the current list">
          Open
        </button>
        <button onClick={() => pickMusic('append')} title="Add a folder to the current list">
          Add
        </button>
        <button onClick={createPlaylist} disabled={selectedPaths.length === 0} title="Save an .m3u playlist of the selected tracks">
          Create playlist
        </button>
      </nav>

      <div className="search-box" onClick={() => searchInput.current?.focus()}>
        <SearchIcon />
        <input
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
