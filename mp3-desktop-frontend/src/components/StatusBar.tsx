import { useStore } from '../store-context'
import { formatDuration, formatSize } from '../utils'

export function StatusBar() {
  const { tracks, selectedPaths, applyProgress, applying } = useStore()
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
      {/* The dry run has no modal of its own — it opens one when it finishes —
          so a long read is reported here. */}
      {applyProgress && (
        <span className="statusbar-progress">
          {applying ? 'Applying' : 'Checking'} {applyProgress.done} of {applyProgress.total}…
        </span>
      )}
    </footer>
  )
}
