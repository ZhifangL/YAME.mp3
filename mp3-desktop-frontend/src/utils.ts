// Small formatting helpers.

export function formatDuration(seconds: number | null): string {
  if (seconds == null || !isFinite(seconds)) return '–:––'
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m + ':' + String(s).padStart(2, '0')
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

export function formatDate(unix: number | null): string {
  if (!unix) return ''
  const d = new Date(unix * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

export function yearOf(track: { fields: Record<string, string> }): string {
  const date = track.fields.date ?? ''
  const m = date.match(/\d{4}/)
  return m ? m[0] : ''
}
