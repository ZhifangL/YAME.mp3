// A short record of what undo and redo were asked to do, and when.
//
// This exists because undo misbehaviour has been reported three times and
// diagnosed from prose three times, wrongly twice. The one question that
// actually settles it is "how many times was the action dispatched for one
// press, and what did each delivery see?" — so both are recorded, and the
// record is reachable without an inspector.
//
// Kept out of `store.tsx` on purpose: exporting a plain function from a module
// that also exports a component breaks Fast Refresh, and eslint enforces it.

export interface DiagEntry {
  /** Milliseconds since the page loaded. */
  at: number
  action: 'undo' | 'redo'
  /**
   * Which path delivered it. A native menu accelerator and the page's key
   * handler are independent, so one press delivered twice shows as two entries
   * with the same `at` and different `via`.
   */
  via: 'key' | 'menu'
  /** True when focus was in a text field, so the field's own history took it. */
  typing: boolean
  /** True when a previous restore had not committed yet. */
  settling: boolean
  past: number
  future: number
  tracks: number
}

const entries: DiagEntry[] = []

if (typeof window !== 'undefined') {
  ;(window as unknown as { __YAME_DIAG__?: DiagEntry[] }).__YAME_DIAG__ = entries
}

/** One line per delivery, so a duplicate is unmistakable. */
function format(entry: DiagEntry): string {
  return (
    `${entry.action} via=${entry.via} typing=${entry.typing} ` +
    `settling=${entry.settling} past=${entry.past} future=${entry.future} ` +
    `tracks=${entry.tracks} at=${entry.at}`
  )
}

export function noteDiag(entry: DiagEntry): void {
  entries.push(entry)
  // Keep it small: enough for a burst around one keystroke, not a session log.
  if (entries.length > 200) entries.shift()
  console.log('[yame diag] ' + format(entry))
}

/** The record as text, for a bug report. */
export function diagnosticsText(): string {
  if (!entries.length) return 'No undo/redo activity recorded yet.'
  return entries.map(format).join('\n')
}
