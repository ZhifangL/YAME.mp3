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
  const { search, setSearch } = useStore()
  return (
    <header className="titlebar">
      <div className="wordmark">
        <span className="dot" />
        TagForge
      </div>
      <div className="search-box">
        <SearchIcon />
        <input
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
