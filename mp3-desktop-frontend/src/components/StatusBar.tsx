import { useStore } from '../store-context'
import { formatDuration, formatSize } from '../utils'

export function StatusBar() {
  const { tracks, selectedPaths } = useStore()
  const selected = tracks.filter((t) => selectedPaths.includes(t.file.path))
  const totalDur = tracks.reduce((sum, t) => sum + (t.audio?.duration_seconds ?? 0), 0)
  const selDur = selected.reduce((sum, t) => sum + (t.audio?.duration_seconds ?? 0), 0)
  const totalSize = tracks.reduce((sum, t) => sum + t.file.size_bytes, 0)
  const selSize = selected.reduce((sum, t) => sum + t.file.size_bytes, 0)

  return (
    <footer className="statusbar">
      <span>
        {selected.length > 0 ? (
          <>
            {selected.length} selected · {formatDuration(selDur)} · {formatSize(selSize)}
          </>
        ) : (
          <>
            {tracks.length} track{tracks.length === 1 ? '' : 's'} · {formatDuration(totalDur)} ·{' '}
            {formatSize(totalSize)}
          </>
        )}
      </span>
      <span className="spacer" />
    </footer>
  )
}
