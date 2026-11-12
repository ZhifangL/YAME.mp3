// The engine client's request timeout.
//
// A call to a wedged engine used to stay pending forever, so the UI stopped
// responding with nothing to show the user. `api.ts` bounds every call; these
// tests pin the bound, the wording, and that the timer does not leak.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { stubApi } from './test/api-stub'

afterEach(() => {
  // Also done by the global setup, but a failing test must not leave the fake
  // clock installed for the next one.
  vi.useRealTimers()
})

describe('the engine request timeout', () => {
  it('gives up after 60 seconds instead of staying pending forever', async () => {
    vi.useFakeTimers()
    // The engine accepted the connection and then wedged: the one case a
    // "cannot reach" check cannot catch.
    stubApi({ '/api/health': () => new Promise<never>(() => {}) })

    const pending = api.health()
    // Attached before the clock moves, so the rejection is never unhandled.
    const settled = expect(pending).rejects.toThrow(/did not respond within 60 seconds/)

    await vi.advanceTimersByTimeAsync(60_000)
    await settled
  })

  it('does not fire the timeout when the engine answers in time', async () => {
    vi.useFakeTimers()
    stubApi({ '/api/health': { status: 'ok', version: '1.1.0', config_dir: '/tmp/yame' } })

    await expect(api.health()).resolves.toMatchObject({ status: 'ok' })
    // Cleared on the way out: one live 60s timer per call would accumulate for
    // the life of the session.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports an unreachable engine, not a timeout', async () => {
    // A refused connection fails immediately. The two messages are worth
    // keeping apart because they suggest different fixes: retry, or start the
    // engine.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await expect(api.health()).rejects.toThrow('Cannot reach the YAME engine. Is it running?')
  })

  it('still surfaces an HTTP error body from the engine', async () => {
    // The timeout must not swallow the normal error path.
    stubApi({ '/api/presets/nope': { status: 404, body: { detail: 'Preset not found.' } } })

    await expect(api.deletePreset('nope')).rejects.toThrow('Preset not found.')
  })
})

// --------------------------------------------------------------- batch apply
//
// `/api/apply` answers with newline-delimited JSON — one event per file — so the
// client can show progress and bound *silence* rather than total duration. There
// is no total budget to test: a batch of any size is fine while it keeps moving.

const RULESET = { name: 'r', rules: [] }

function fileResult(filename: string) {
  return {
    path: '/music/' + filename,
    filename,
    new_filename: filename,
    error: null,
    changes: [
      { field: 'title', label: 'Title', before: '', after: 'X', rule_type: 'WRITE', rule_label: 'Write' },
    ],
    warnings: [],
    written: true,
  }
}

function ndjson(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

/** A well-formed batch: start, one event per file, done. */
function applyBody(filenames: string[]): string {
  return ndjson([
    { type: 'start', total: filenames.length, dry_run: false },
    ...filenames.map((f, i) => ({ type: 'file', index: i, result: fileResult(f) })),
    { type: 'done', total_files: filenames.length, changed_files: filenames.length, dry_run: false },
  ])
}

function streamed(body: string): Response {
  return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })
}

/** A body that sends `body` and then stays open, like an engine that wedged. */
function stalled(body: string): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body))
      },
    }),
    { headers: { 'Content-Type': 'application/x-ndjson' } },
  )
}

describe('a streamed batch apply', () => {
  it('assembles the events and reports progress file by file', async () => {
    stubApi({ '/api/apply': () => streamed(applyBody(['a.mp3', 'b.mp3'])) })
    const seen: { done: number; total: number }[] = []

    const out = await api.apply(['/music/a.mp3'], RULESET, false, (p) => seen.push(p))

    expect(out.total_files).toBe(2)
    expect(out.changed_files).toBe(2)
    expect(out.results.map((r) => r.filename)).toEqual(['a.mp3', 'b.mp3'])
    expect(seen).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ])
  })

  it('refuses to report a truncated batch as a success', async () => {
    // The engine dying mid-batch has already written whatever it got through, so
    // the client must not present the missing files as "nothing to do".
    stubApi({
      '/api/apply': () =>
        streamed(
          ndjson([
            { type: 'start', total: 2, dry_run: false },
            { type: 'file', index: 0, result: fileResult('a.mp3') },
          ]),
        ),
    })

    await expect(api.apply(['/music/a.mp3'], RULESET, false)).rejects.toThrow(
      /stopped before the batch finished.*1 of 2 file\(s\) were processed/s,
    )
  })

  it('gives up after 60 seconds of silence, not after a fixed total', async () => {
    vi.useFakeTimers()
    // `start` and one file arrive, then nothing: the engine is wedged, and the
    // only thing that can tell us so is the absence of further events.
    stubApi({
      '/api/apply': () =>
        stalled(
          ndjson([
            { type: 'start', total: 1_000, dry_run: false },
            { type: 'file', index: 0, result: fileResult('a.mp3') },
          ]),
        ),
    })

    const pending = api.apply(['/music/a.mp3'], RULESET, false)
    const settled = expect(pending).rejects.toThrow(/stopped responding partway through/)

    await vi.advanceTimersByTimeAsync(59_000)
    // Still waiting: a 1,000-file batch is allowed to take a long time.
    await vi.advanceTimersByTimeAsync(1_000)
    await settled
  })

  it('reads the body in one go where the webview cannot stream', async () => {
    // An old WKWebView: a Response with no readable body. The batch still works,
    // it just cannot report progress while it runs.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          body: null,
          text: async () => applyBody(['a.mp3']),
        } as unknown as Response
      }),
    )

    const out = await api.apply(['/music/a.mp3'], RULESET, false)

    expect(out.total_files).toBe(1)
    expect(out.results[0].filename).toBe('a.mp3')
  })

  it('passes the engine\'s own error through rather than calling it unreachable', async () => {
    // The 400s are raised before the stream starts, so they arrive as JSON.
    stubApi({ '/api/apply': { status: 400, body: { detail: 'The ruleset has no rules.' } } })

    await expect(api.apply(['/music/a.mp3'], RULESET, false)).rejects.toThrow(
      'The ruleset has no rules.',
    )
  })

  it('still applies the batch against an engine older than the stream', async () => {
    // An engine built before /api/apply streamed answers with ONE JSON object and
    // no events at all. That is a normal state of affairs — `pnpm run desktop:dev`
    // talks to whatever sidecar is already staged and does not rebuild it, and the
    // shell attaches to a running engine when it finds no binary — so a good batch
    // must not be reported as a failure because it arrived in the older envelope.
    // Only the progress is missing.
    stubApi({
      '/api/apply': () =>
        new Response(
          JSON.stringify({
            results: [fileResult('a.mp3')],
            total_files: 1,
            changed_files: 1,
            dry_run: false,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    })

    const out = await api.apply(['/music/a.mp3'], RULESET, false)

    expect(out.total_files).toBe(1)
    expect(out.results[0].filename).toBe('a.mp3')
  })

  it('blames a version mismatch, not the user\'s files, when nothing is recognisable', async () => {
    // The report this replaces was "0 of 0 file(s) were processed", which reads
    // as though the batch failed on the files. It did not: no batch was ever
    // understood, and the fix is to line the two halves up.
    stubApi({ '/api/apply': () => new Response('this is not an apply response') })

    await expect(api.apply(['/music/a.mp3'], RULESET, false)).rejects.toThrow(
      /did not answer the way this version of the interface expects/,
    )
  })
})
