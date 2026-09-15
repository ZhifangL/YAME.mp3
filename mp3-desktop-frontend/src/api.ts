// Thin client for the TagForge engine (FastAPI on 127.0.0.1).
// Vite proxies /api to the engine during dev; the packaged Tauri build talks
// to the sidecar directly, so the base URL is resolved at call time.
import { apiBase } from './env'
import type {
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(apiBase() + path, init)
  } catch (err) {
    throw new Error('Cannot reach the TagForge engine. Is it running?', { cause: err })
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

export const api = {
  health: (): Promise<HealthResponse> => request<HealthResponse>('/health'),

  browse: (path?: string, recursive = false): Promise<BrowseResponse> =>
    request<BrowseResponse>(
      '/browse' + (path ? '?path=' + encodeURIComponent(path) : '') + (recursive ? (path ? '&' : '?') + 'recursive=true' : ''),
    ),

  registry: (): Promise<RegistryResponse> => request<RegistryResponse>('/rules/registry'),

  readTracks: (paths: string[]): Promise<{ tracks: Track[]; errors?: { path: string; error: string }[] }> =>
    post('/tracks/read', { paths }),

  writeTrack: (path: string, fields: Record<string, string>, renameTo?: string | null): Promise<{ track: Track | null; warnings: string[] }> =>
    post('/tracks/write', { path, fields, rename_to: renameTo ?? null }),

  setCover: (path: string, mime: string, dataBase64: string): Promise<{ track: Track | null; warnings: string[] }> =>
    post('/tracks/cover', { path, mime, data_base64: dataBase64 }),

  removeCover: (path: string): Promise<{ track: Track | null; warnings: string[] }> =>
    post('/tracks/cover', { path, remove: true }),

  preview: (filename: string, folder: string, fields: Record<string, string>, rule: RuleInstance): Promise<{ changes: ChangeRecord[]; fields: Record<string, string>; filename: string }> =>
    post('/preview', { filename, folder, fields, rule: { type: rule.type, params: rule.params, enabled: rule.enabled } }),

  previewBatch: (
    candidates: { filename: string; folder: string; fields: Record<string, string>; cover: { mime: string; data_base64: string } | null }[],
    rule: RuleInstance,
  ): Promise<{ changes: ChangeRecord[]; fields: Record<string, string>; filename: string; matched_index: number | null }> =>
    post('/preview-batch', { candidates, rule: { type: rule.type, params: rule.params, enabled: rule.enabled } }),

  resolveFolder: (name: string, entries: string[], previousPath?: string | null): Promise<{ path: string | null }> =>
    post('/resolve-folder', { name, entries, previous_path: previousPath ?? null }),

  resolveFiles: (names: string[], previousPath?: string | null): Promise<{ paths: string[] }> =>
    post('/resolve-files', { names, previous_path: previousPath ?? null }),

  apply: (paths: string[], ruleset: Ruleset, dryRun: boolean): Promise<ApplyResponse> =>
    post('/apply', { paths, ruleset: { name: ruleset.name, rules: ruleset.rules.map((r) => ({ type: r.type, params: r.params, enabled: r.enabled })) }, dry_run: dryRun }),

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
