// Small formatting + DOM helpers shared across components.

export function formatDuration(seconds: number | null): string {
  if (seconds == null || !isFinite(seconds)) return '–:––'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
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

/**
 * The separator to join with, taken from the directory part of a path.
 *
 * Windows paths are not always uniformly backslashed — a user typing
 * `C:/Music/song.mp3` is describing the same file — so the last separator
 * present wins. A bare drive (`C:`, which `dirOf` returns for a file at the
 * root of a drive) has no separator to read, and there the backslash is the one
 * that means what we want: `C:\song.mp3` is absolute, while `C:song.mp3` is
 * relative to that drive's current directory.
 */
function separatorFor(dir: string): '/' | '\\' {
  const slash = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
  if (slash !== -1) return dir[slash] as '/' | '\\'
  return /^[a-zA-Z]:$/.test(dir) ? '\\' : '/'
}

/** Directory part of a path ('' when the path has no separator). */
export function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  // idx === -1 means no separator at all, so there is no directory. idx === 0
  // is a POSIX root ("/song.mp3"): the directory is "/", which joinPath then
  // reattaches — returning "" would silently turn the result into a relative
  // path. A Windows drive root ("C:\\song.mp3") keeps its "C:" by the same
  // rule, minus the separator.
  if (idx > 0) return path.slice(0, idx)
  if (idx === 0) return path[0]
  return ''
}

/**
 * Join a directory and a file name with exactly one separator.
 *
 * The separator follows the directory, so a Windows folder stays a Windows
 * path. Getting this wrong is not cosmetic: the apply flow rebuilds each
 * renamed file's path with this function before re-reading it, and a
 * mis-joined path reads back as "file not found".
 */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name
  const trimmed = dir.replace(/[/\\]+$/, '')
  // A bare root ("/", "C:\\", "\\\\") must not be trimmed into nothing.
  if (!trimmed && !/^[a-zA-Z]:$/.test(dir)) return dir + name
  return trimmed + separatorFor(dir) + name
}

export interface ImagePayload {
  mime: string
  data_base64: string
  name: string
}

/** Read an image File into the {mime, data_base64} shape the engine expects. */
export function readImageFile(file: File): Promise<ImagePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      const comma = dataUrl.indexOf(',')
      const mime = dataUrl.slice(5, dataUrl.indexOf(';'))
      resolve({
        mime: mime || file.type || 'image/jpeg',
        data_base64: dataUrl.slice(comma + 1),
        name: file.name,
      })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
