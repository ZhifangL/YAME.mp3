// Shared client-side types mirroring the backend JSON contract
// (mp3-metadata-api/app/schemas.py).

export interface AudioInfo {
  duration_seconds: number | null
  bitrate_kbps: number | null
  sample_rate_hz: number | null
  channels: number | null
  codec: string | null
  codec_detail: string | null
  mode: string | null
  bitrate_mode: string | null
}

export interface CoverInfo {
  mime: string
  data_base64: string
}

export interface TrackFile {
  path: string
  filename: string
  size_bytes: number
  modified_unix: number
  created_unix: number | null
}

export interface Track {
  file: TrackFile
  audio: AudioInfo
  fields: Record<string, string>
  cover: CoverInfo | null
  writable: boolean
  warnings: string[]
}

export interface FolderEntry {
  name: string
  path: string
}

export interface BrowseResponse {
  path: string
  parent: string | null
  folders: FolderEntry[]
  audio_files: FolderEntry[]
}

// ---------------------------------------------------------------- rules

export interface RuleParamChoice {
  key: string
  label: string
}

export interface RuleParamSpec {
  name: string
  label: string
  kind: 'field' | 'text' | 'choice' | 'bool' | 'separator' | 'image' | 'parse_pattern' | 'parse_assignments'
  choices: RuleParamChoice[]
  default: unknown
  placeholder: string | null
  help: string | null
  /** The rule cannot be committed until this param is filled in. */
  required: boolean
  /** Field keys this picker must not offer (e.g. the circular file name). */
  exclude: string[]
  /** 'target' offers writable fields only; 'source' also allows read-only ones. */
  role: 'target' | 'source'
}

export interface RuleSpec {
  type: string
  label: string
  description: string
  params: RuleParamSpec[]
}

export interface RuleField {
  key: string
  label: string
  kind: string
  pseudo: boolean
  writable: boolean
  /** True for fields that must never be blanked, such as the file name. */
  must_not_be_empty: boolean
}

export interface RegistryResponse {
  specs: RuleSpec[]
  fields: RuleField[]
  /** Lowercase, dot-prefixed extensions the engine can read (".mp3"). */
  audio_suffixes: string[]
}

export interface RuleInstance {
  id: string
  type: string
  params: Record<string, unknown>
  enabled: boolean
}

export interface Ruleset {
  name: string
  rules: RuleInstance[]
}

export interface ChangeRecord {
  field: string
  label: string
  before: string
  after: string
  rule_type: string | null
  rule_label: string | null
}

export interface ApplyFileResult {
  path: string
  filename: string
  new_filename: string
  error: string | null
  changes: ChangeRecord[]
  warnings: string[]
  written: boolean
}

export interface ApplyResponse {
  results: ApplyFileResult[]
  total_files: number
  changed_files: number
  dry_run: boolean
}

export interface Preset {
  id: string
  name: string
  ruleset: Ruleset
  updated_unix: number
}
