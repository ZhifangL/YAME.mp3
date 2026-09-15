// Context + hook + shared types for the app store. Kept in its own file so
// store.tsx only exports the provider component (fast-refresh friendly).
import { createContext, useContext } from 'react'
import type {
  ApplyResponse,
  Preset,
  RegistryResponse,
  Ruleset,
  Track,
} from './types'

export type SortKey =
  | 'filename'
  | 'title'
  | 'artist'
  | 'album'
  | 'album_artist'
  | 'year'
  | 'track_number'
  | 'disc_number'
  | 'genre'
  | 'composer'
  | 'comment'
  | 'duration'
  | 'size'

export interface BuilderDraft {
  ruleId: string | null
  type: string
  params: Record<string, unknown>
  originalParams?: Record<string, unknown>
}

export interface ToastState {
  id: number
  text: string
  kind: 'info' | 'success' | 'error'
}

export interface Store {
  registry: RegistryResponse | null
  presets: Preset[]
  activePresetId: string | null
  tracks: Track[]
  folderPath: string | null
  loadingTracks: boolean
  engineError: string | null
  /** Where the engine keeps presets + the port file (display only). */
  configDir: string | null

  selectedPaths: string[]
  search: string
  sortKey: SortKey | null
  sortDir: 1 | -1

  ruleset: Ruleset
  draft: BuilderDraft | null

  editTrackPath: string | null
  applyReview: ApplyResponse | null
  applying: boolean
  toast: ToastState | null

  init: () => void
  loadFolder: (folderPath: string, paths?: string[]) => void
  appendPaths: (paths: string[]) => Promise<void>
  replacePaths: (paths: string[]) => Promise<void>
  upsertTrack: (track: Track) => void
  removeTrack: (path: string) => void

  toggleSelect: (path: string, additive: boolean) => void
  selectRange: (paths: string[]) => void
  clearSelection: () => void
  setSearch: (value: string) => void
  cycleSort: (key: SortKey) => void

  setDraft: (draft: BuilderDraft | null) => void
  updateDraftParam: (name: string, value: unknown) => void
  updateDraftType: (type: string) => void
  cancelDraft: () => void
  addRule: (type: string) => void
  commitDraft: () => void
  removeRule: (id: string) => void
  toggleRule: (id: string) => void
  reorderRules: (dragId: string, targetId: string) => void
  setName: (name: string) => void

  openEdit: (path: string) => void
  closeEdit: () => void

  writeFields: (path: string, fields: Record<string, string>, renameTo?: string | null) => Promise<string[]>
  setCover: (path: string, mime: string, dataBase64: string) => Promise<void>
  removeCover: (path: string) => Promise<void>

  startApply: () => Promise<void>
  confirmApply: () => Promise<void>
  cancelApply: () => void

  savePreset: (name: string, presetId?: string | null) => Promise<void>
  loadPreset: (preset: Preset) => void
  deletePreset: (id: string) => Promise<void>
  importPresets: (entries: { id?: string; name: string; ruleset: Ruleset }[]) => Promise<number>

  showToast: (text: string, kind?: ToastState['kind']) => void
}

export const StoreContext = createContext<Store | null>(null)

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore must be used inside StoreProvider')
  return store
}
