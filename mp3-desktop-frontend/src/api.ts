// Thin client for the YAME engine (FastAPI on 127.0.0.1).
// Vite proxies /api to the engine during dev; the packaged Tauri build talks
// to the sidecar directly, so the base URL is resolved at call time.
import { apiBase } from './env'
import type {
  ApplyFileResult,
  ApplyResponse,
  BrowseResponse,
  ChangeRecord,
  Preset,
  RegistryResponse,
  Ruleset,
  RuleInstance,
  Track,
} from './types'

export interface HealthResponse {
  status: string
  version: string
  /** Where presets and the port file live (shown in the UI). */
  config_dir: string
}

/**
 * How long one engine call may take before the client gives up.
 *
 * Every call is to a loopback HTTP service that answers in milliseconds, so a
 * request still outstanding after a minute is wedged rather than slow — and
 * without a bound the promise stays pending forever and the UI simply stops
 * responding, with nothing to show the user. 60s is far longer than any local
 * call needs while still being short enough to surface as an error.
 *
 * This is a *client-side* budget. Aborting does not stop work already running
 * in the engine, so a batch apply abandoned here may still finish on disk —
 * the one case to think about if a very large apply ever reports a timeout.
 */
const REQUEST_TIMEOUT_SECONDS = 60
const REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_SECONDS * 1000

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // An AbortController rather than `AbortSignal.timeout()`: the latter is
  // Safari 16+, and the macOS build supports 10.15, whose WKWebView predates
  // it — the whole app would fail to make a request at all. `abort()` with no
  // reason is equally old and universally available, so the distinction
  // between "timed out" and "unreachable" is carried by a flag.
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(apiBase() + path, { ...init, signal: controller.signal })
  } catch (err) {
    // Worth telling apart: "it is taking too long" suggests retrying, while
    // "it is not there" suggests the engine never started.
    throw timedOut
      ? new Error(
          'The YAME engine did not respond within ' + REQUEST_TIMEOUT_SECONDS + ' seconds.',
          { cause: err },
        )
      : new Error('Cannot reach the YAME engine. Is it running?', { cause: err })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    let detail = res.status + ' ' + res.statusText
    try {
      const body = await res.json()
      if (body && typeof body.detail === 'string') detail = body.detail
    } catch {
      /* keep status text */
    }
    throw new Error(detail)
  }
  return (await res.json()) as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------- batch apply

/** How far a running batch has got, reported file by file. */
export interface ApplyProgress {
  done: number
  total: number
}

/**
 * How long a *streaming* apply may go silent before the client gives up.
 *
 * A batch reports progress file by file, so the bound that matters is the gap
 * between events, not the total. No single file legitimately takes a minute, and
 * a batch of any size is fine as long as it keeps moving — which is the point:
 * there is no total budget here, because a number large enough for 50,000 files
 * would be useless as a hang detector for five.
 */
const STREAM_IDLE_TIMEOUT_SECONDS = 60

/**
 * The budget for a *buffered* apply, used only where the webview cannot stream.
 *
 * There is no honest fixed number for this either, so it scales with the work: a
 * batch costs a fixed overhead plus a per-file cost, and the per-file allowance
 * is deliberately generous (a large FLAC with embedded artwork can take hundreds
 * of milliseconds). The cap exists because a buffered call has no progress to
 * prove it is alive — "still working" and "wedged" cannot be told apart, so an
 * hour is where we stop guessing in the user's favour.
 */
const BUFFERED_BASE_MS = 60_000
const BUFFERED_PER_FILE_MS = 500
const BUFFERED_MAX_MS = 60 * 60_000

type ApplyEvent =
  | { type: 'start'; total: number; dry_run: boolean }
  | { type: 'file'; index: number; result: ApplyFileResult }
  | { type: 'done'; total_files: number; changed_files: number; dry_run: boolean }

/** Can this webview read a response incrementally? */
function canStreamBody(res: Response): boolean {
  return typeof res.body?.getReader === 'function'
}

/** What one of the readers below made of the body. */
interface ApplyRead {
  results: ApplyFileResult[]
  summary: ApplyEvent | null
  total: number
  /** Raw body, kept only while nothing has been recognised (see `raw` below). */
  raw: string
}

/** True once an event of the expected shape has been understood. */
function isApplyEvent(value: unknown): value is ApplyEvent {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return type === 'start' || type === 'file' || type === 'done'
}

/**
 * The engine's answer before `/api/apply` streamed: one JSON object holding
 * every result.
 *
 * This is not hypothetical. `pnpm run desktop:dev` runs against whatever engine
 * is already staged in `src-tauri/binaries/` and does **not** rebuild it, and the
 * shell attaches to an already-running engine when it cannot find a binary — so
 * an interface newer than its engine is a normal state of affairs, and a batch
 * that works perfectly well should not be reported as a failure because it
 * arrived in the older envelope.
 */
function olderEngineResponse(raw: string): ApplyResponse | null {
  const text = raw.trim()
  if (!text.startsWith('{')) return null
  let parsed: Partial<ApplyResponse>
  try {
    parsed = JSON.parse(text) as Partial<ApplyResponse>
  } catch {
    return null
  }
  if (!parsed || !Array.isArray(parsed.results)) return null
  const results = parsed.results
  return {
    results,
    total_files: typeof parsed.total_files === 'number' ? parsed.total_files : results.length,
    changed_files:
      typeof parsed.changed_files === 'number'
        ? parsed.changed_files
        : results.filter((r) => (r.changes ?? []).length > 0).length,
    dry_run: Boolean(parsed.dry_run),
  }
}

/** The engine's error detail, or the status line when there is no JSON body. */
async function errorDetail(res: Response): Promise<string> {
  let detail = res.status + ' ' + res.statusText
  try {
    const body = await res.json()
    if (body && typeof body.detail === 'string') detail = body.detail
  } catch {
    /* keep the status line */
  }
  return detail
}

/** Decode NDJSON into events, noting how far the batch got. */
async function readNdjson(
  res: Response,
  armIdleTimer: (ms: number) => void,
  onProgress?: (progress: ApplyProgress) => void,
): Promise<ApplyRead> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const results: ApplyFileResult[] = []
  let summary: ApplyEvent | null = null
  let total = 0
  let buffer = ''
  // Held only until something is recognised: an engine older than the stream
  // sends one JSON object with no newlines at all, and the only way to tell is
  // to look at the whole body. Once a real event parses, this is dropped so a
  // large batch is never buffered twice.
  let raw = ''

  const handle = (line: string) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A truncated last line is what a dropped connection looks like. It is
      // not reported here: leaving `summary` unset already produces the honest
      // "stopped before the batch finished" error, with a count of what landed.
      return
    }
    if (!isApplyEvent(parsed)) return
    raw = ''
    const event = parsed
    if (event.type === 'start') {
      total = event.total
      onProgress?.({ done: 0, total })
    } else if (event.type === 'file') {
      results.push(event.result)
      onProgress?.({ done: results.length, total })
    } else if (event.type === 'done') {
      summary = event
    }
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    // Bytes arrived, so the engine is alive: the silence budget starts again.
    armIdleTimer(STREAM_IDLE_TIMEOUT_SECONDS * 1000)
    const text = decoder.decode(value, { stream: true })
    buffer += text
    if (!summary && results.length === 0 && total === 0) raw += text
    let cut = buffer.indexOf('\n')
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim()
      buffer = buffer.slice(cut + 1)
      if (line) handle(line)
      cut = buffer.indexOf('\n')
    }
  }
  // A final line with no trailing newline still counts.
  if (buffer.trim()) handle(buffer.trim())

  return { results, summary, total, raw: raw || buffer }
}

/** Assemble the whole body at once, for webviews without incremental reads. */
async function readBuffered(
  res: Response,
  armIdleTimer: (ms: number) => void,
  budgetMs: number,
  onProgress?: (progress: ApplyProgress) => void,
): Promise<ApplyRead> {
  // The one call that cannot report progress gets the batch-scaled budget, armed
  // before the body is awaited — nothing else can tell us it is still alive.
  armIdleTimer(budgetMs)
  const text = await res.text()
  const results: ApplyFileResult[] = []
  let summary: ApplyEvent | null = null
  let total = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isApplyEvent(parsed)) continue
    const event = parsed
    if (event.type === 'start') {
      total = event.total
    } else if (event.type === 'file') {
      results.push(event.result)
    } else if (event.type === 'done') {
      summary = event
    }
  }
  // No incremental feedback was possible, so report the end state in one go.
  onProgress?.({ done: results.length, total })
  return { results, summary, total, raw: text }
}

/**
 * Run a ruleset, reporting progress as each file is answered.
 *
 * `/api/apply` streams newline-delimited JSON (see the engine's route
 * docstring), which is what makes the client able to bound *silence* rather than
 * total duration — see `STREAM_IDLE_TIMEOUT_SECONDS`. Where the webview cannot
 * read a body incrementally it falls back to one buffered read with a budget
 * scaled to the batch.
 */
async function applyStream(
  paths: string[],
  ruleset: Ruleset,
  dryRun: boolean,
  onProgress?: (progress: ApplyProgress) => void,
): Promise<ApplyResponse> {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const armIdleTimer = (ms: number) => {
    clearTimeout(timer)
    if (ms <= 0) return
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, ms)
  }
  const networkError = (err: unknown): Error => {
    if (timedOut) {
      return new Error(
        'The YAME engine stopped responding partway through. The batch may be ' +
          'incomplete — check the files before trying again.',
        { cause: err },
      )
    }
    return new Error('Cannot reach the YAME engine. Is it running?', { cause: err })
  }

  const ruleList = ruleset.rules.map((r: RuleInstance) => ({
    type: r.type,
    params: r.params,
    enabled: r.enabled,
  }))
  const payload = JSON.stringify({
    paths,
    ruleset: { name: ruleset.name, rules: ruleList },
    dry_run: dryRun,
  })

  armIdleTimer(STREAM_IDLE_TIMEOUT_SECONDS * 1000)

  try {
    let res: Response
    try {
      res = await fetch(apiBase() + '/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      })
    } catch (err) {
      throw networkError(err)
    }

    // The 400s (no paths, no rules) are raised before the stream starts, so this
    // is an ordinary JSON error body.
    if (!res.ok) throw new Error(await errorDetail(res))

    let out: ApplyRead
    try {
      out = canStreamBody(res)
        ? await readNdjson(res, armIdleTimer, onProgress)
        : await readBuffered(
            res,
            armIdleTimer,
            Math.min(BUFFERED_MAX_MS, BUFFERED_BASE_MS + paths.length * BUFFERED_PER_FILE_MS),
            onProgress,
          )
    } catch (err) {
      throw networkError(err)
    }

    if (!out.summary || out.summary.type !== 'done') {
      // Nothing that looked like progress: the engine answered in its older,
      // single-object form. The batch itself is perfectly good, so take it —
      // only the progress reporting is missing.
      const older = olderEngineResponse(out.raw)
      if (older) {
        console.warn(
          '[yame] the engine answered /api/apply without streaming, so it is an ' +
            'older build than this interface. The batch is unaffected, but there ' +
            'will be no progress while it runs. Rebuild it with `pnpm run sidecar` ' +
            'if you are running from source.',
        )
        onProgress?.({ done: older.results.length, total: older.total_files })
        return older
      }

      if (out.results.length === 0 && out.total === 0) {
        // Not a partial batch — no batch at all. Saying "0 of 0 file(s) were
        // processed" would blame the user's files for what is a protocol
        // mismatch, which is the most confusing possible way to report it.
        throw new Error(
          'The YAME engine did not answer the way this version of the interface ' +
            'expects. Quit and reopen YAME; if you are running from source, the ' +
            'bundled engine is probably out of date (`pnpm run sidecar`).',
        )
      }

      // Silence must never be mistaken for success: a batch that stopped early
      // has already written whatever it got through.
      throw new Error(
        'The engine stopped before the batch finished. ' +
          out.results.length +
          ' of ' +
          out.total +
          ' file(s) were processed — check them before retrying.',
      )
    }

    return {
      results: out.results,
      total_files: out.summary.total_files,
      changed_files: out.summary.changed_files,
      dry_run: out.summary.dry_run,
    }
  } finally {
    clearTimeout(timer)
  }
}

export const api = {
  health: (): Promise<HealthResponse> => request<HealthResponse>('/health'),

  browse: (path: string): Promise<BrowseResponse> =>
    request<BrowseResponse>('/browse?path=' + encodeURIComponent(path)),

  registry: (): Promise<RegistryResponse> => request<RegistryResponse>('/rules/registry'),

  readTracks: (paths: string[]): Promise<{ tracks: Track[]; errors?: { path: string; error: string }[] }> =>
    post('/tracks/read', { paths }),

  writeTrack: (path: string, fields: Record<string, string>, renameTo?: string | null): Promise<{ track: Track | null; warnings: string[] }> =>
    post('/tracks/write', { path, fields, rename_to: renameTo ?? null }),

  setCover: (path: string, mime: string, dataBase64: string): Promise<{ track: Track | null; warnings: string[] }> =>
    post('/tracks/cover', { path, mime, data_base64: dataBase64 }),

  removeCover: (path: string): Promise<{ track: Track | null; warnings: string[] }> =>
    post('/tracks/cover', { path, remove: true }),

  /** Embed an image that is already on disk (a drop / the native picker). */
  setCoverFromFile: (path: string, imagePath: string): Promise<{ track: Track | null; warnings: string[] }> =>
    post('/tracks/cover-from-file', { path, image_path: imagePath }),

  previewBatch: (
    candidates: { filename: string; folder: string; fields: Record<string, string>; cover: { mime: string; data_base64: string } | null }[],
    rule: RuleInstance,
  ): Promise<{ changes: ChangeRecord[]; fields: Record<string, string>; filename: string; matched_index: number | null }> =>
    post('/preview-batch', { candidates, rule: { type: rule.type, params: rule.params, enabled: rule.enabled } }),

  resolveFolder: (name: string, entries: string[], previousPath?: string | null): Promise<{ path: string | null }> =>
    post('/resolve-folder', { name, entries, previous_path: previousPath ?? null }),

  resolveFiles: (names: string[], previousPath?: string | null): Promise<{ paths: string[] }> =>
    post('/resolve-files', { names, previous_path: previousPath ?? null }),

  /** Flatten a mixed selection of audio files and folders (a file-manager drag). */
  expandPaths: (paths: string[]): Promise<{ files: string[]; skipped: string[]; truncated: boolean }> =>
    post('/paths/expand', { paths }),

  /** Run a ruleset, streaming per-file progress. See `applyStream`. */
  apply: (
    paths: string[],
    ruleset: Ruleset,
    dryRun: boolean,
    onProgress?: (progress: ApplyProgress) => void,
  ): Promise<ApplyResponse> => applyStream(paths, ruleset, dryRun, onProgress),

  presets: (): Promise<Preset[]> => request<Preset[]>('/presets'),

  savePreset: (name: string, ruleset: Ruleset, presetId?: string | null): Promise<Preset> =>
    request<Preset>('/presets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ruleset: { name, rules: ruleset.rules.map((r) => ({ type: r.type, params: r.params, enabled: r.enabled })) }, preset_id: presetId ?? null }),
    }),

  deletePreset: (presetId: string): Promise<{ deleted: string }> =>
    request<{ deleted: string }>('/presets/' + encodeURIComponent(presetId), { method: 'DELETE' }),

  importPresets: (presets: unknown[]): Promise<Preset[]> =>
    post<Preset[]>('/presets/import', { presets }),
}
