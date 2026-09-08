// Shared "no cover art" placeholder: a soft vinyl disc with a note,
// used in both the detail panel and the edit window for consistency.
export function MusicArt({ noteSize = 22 }: { noteSize?: number }) {
  return (
    <div className="vinyl" aria-hidden="true">
      <svg
        width={noteSize}
        height={noteSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#6d28d9"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ position: 'relative', zIndex: 1 }}
      >
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    </div>
  )
}
