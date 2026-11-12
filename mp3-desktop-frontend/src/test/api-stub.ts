// Request stubs for the engine API.
//
// Every network call in the app goes through `src/api.ts`, which fetches
// relative to `apiBase()`. Routing the stub on the path (rather than faking
// `api.ts` module by module) keeps the base-URL resolution and the error
// handling inside the test, which is where the packaging bugs actually live.
import { vi } from 'vitest'

export interface RouteContext {
  path: string
  body: unknown
  method: string
  init?: RequestInit
}

type RouteResult = unknown | { status: number; body: unknown }

/** A route may depend on the request body it is answering. */
type Route = RouteResult | ((body: unknown) => RouteResult)

function abortError(): Error {
  const err = new Error('The operation was aborted.')
  err.name = 'AbortError'
  return err
}

/**
 * Attach a caller's abort signal to a response body, as the real `fetch` does.
 *
 * `api.ts` leans on that: the batch timeout aborts the request and expects the
 * pending `reader.read()` to *reject*. A stub whose body ignored the signal
 * could not test a stalled stream at all — the read would simply never settle.
 */
function withAbort(res: Response, signal?: AbortSignal | null): Response {
  if (!signal || !res.body) return res

  const source = res.body.getReader()
  let aborted = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (aborted) {
        controller.error(abortError())
        return
      }
      const { value, done } = await source.read()
      // Checked after the await too: cancelling the source settles a pending
      // read as "done", which would otherwise look like a clean end of stream.
      if (aborted) {
        controller.error(abortError())
        return
      }
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      return source.cancel(reason)
    },
  })

  signal.addEventListener(
    'abort',
    () => {
      aborted = true
      void source.cancel(abortError())
    },
    { once: true },
  )

  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

/**
 * Reject with an `AbortError` if `signal` aborts before `value` settles.
 *
 * The real `fetch` does this, and `api.ts` now depends on it: its 60s timeout
 * aborts the request, and the client distinguishes "timed out" from "could not
 * connect" by whether it was the one that aborted. Without this, a test cannot
 * tell a request that was abandoned from one that simply never answered.
 */
async function raceAbort<T>(value: T | Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return value
  if (signal.aborted) throw abortError()
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(value).then(
      (settled) => {
        signal.removeEventListener('abort', onAbort)
        resolve(settled)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

export interface ApiStub {
  /** Every request made, in order. */
  calls: RouteContext[]
  /** Requests whose path ends with `suffix`. */
  callsTo: (suffix: string) => RouteContext[]
}

/**
 * Stub `fetch`, answering the engine paths the UI uses.
 *
 * A route returning `{status, body}` produces that status; anything else is a
 * 200 with that JSON body. Unrouted paths fail loudly so a test can never pass
 * because a request silently 404'd.
 */
export function stubApi(routes: Record<string, Route>): ApiStub {
  const calls: RouteContext[] = []

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    // The engine origin is absolute in the packaged app and relative in dev;
    // reduce both to the path so routes are written once.
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0]
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = undefined
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    calls.push({ path, body, method, init })

    const route = routes[path]
    if (route === undefined) {
      throw new Error(`stubApi: unrouted request ${method} ${path}`)
    }
    // A route may be a function of the request, so a stub can answer according
    // to what was asked for — `POST /api/tracks/read` returning exactly the
    // paths it was given, for instance. Awaited, because an async route would
    // otherwise resolve to a Promise and the caller would read `undefined` from
    // it — silently, inside its own error handling. Raced against the request's
    // abort signal, so a route that never answers behaves like a real hung
    // request rather than hanging the test.
    const result = await raceAbort(
      typeof route === 'function' ? (route as (body: unknown) => RouteResult)(body) : route,
      init?.signal,
    )

    // A route may hand back a whole `Response` when it needs control the JSON
    // shortcuts cannot give — a streamed body, for instance, which is how
    // `/api/apply` answers.
    if (result instanceof Response) return withAbort(result, init?.signal)

    if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
      const { status, body: payload } = result as { status: number; body: unknown }
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(result ?? null), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  vi.stubGlobal('fetch', vi.fn(impl))

  return {
    calls,
    callsTo: (suffix) => calls.filter((call) => call.path.endsWith(suffix)),
  }
}

/** The engine's `GET /api/rules/registry` shape, with one rule and one field. */
export const REGISTRY_FIXTURE = {
  specs: [
    {
      type: 'WRITE',
      label: 'Write',
      description: 'Overwrite a field with a fixed value.',
      params: [
        { name: 'field', label: 'In field', kind: 'field', default: 'title' },
        { name: 'value', label: 'Value', kind: 'text', placeholder: 'New value' },
      ],
    },
  ],
  fields: [
    { key: 'title', label: 'Title', kind: 'text', pseudo: false, writable: true, must_not_be_empty: false },
    { key: 'filename', label: 'File Name', kind: 'text', pseudo: true, writable: true, must_not_be_empty: true },
  ],
  audio_suffixes: ['.mp3', '.flac', '.m4a'],
}

/** A `Track` as `POST /api/tracks/read` returns it. */
export function trackFixture(path: string, fields: Record<string, string> = {}) {
  return {
    file: {
      path,
      filename: path.split(/[/\\]/).pop() ?? path,
      size_bytes: 1024,
      modified_unix: 1_700_000_000,
      created_unix: 1_700_000_000,
    },
    audio: {
      duration_seconds: 120,
      bitrate_kbps: 320,
      sample_rate_hz: 44100,
      channels: 2,
      codec: 'MP3',
      codec_detail: 'MPEG 1 Layer III',
      mode: 'Joint stereo',
      bitrate_mode: 'CBR',
    },
    fields: { title: '', artist: '', album: '', ...fields },
    cover: null,
    writable: true,
    warnings: [],
  }
}
