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
  /** Snapshot taken when editing started, so Cancel can undo both. */
  originalParams?: Record<string, unknown>
  originalType?: string
}

export interface ToastState {
  id: number
  text: string
  kind: 'info' | 'success' | 'error'
}

/**
 * One pending confirmation.
 *
 * `window.confirm` is not dependable inside a Tauri webview — if it returns
 * false without showing anything, a destructive action silently does nothing.
 * The app therefore asks through its own dialog, which also matches the rest of
 * the UI instead of looking like a browser artefact.
 */
export interface ConfirmRequest {
  title: string
  message?: string
  /** Defaults to "OK". */
  confirmLabel?: string
  /**
   * Defaults to "Cancel". Set to null for an informational dialog with a single
   * action, so it does not show the same button twice.
   */
  cancelLabel?: string | null
  /** Styles the confirm button as destructive. */
  danger?: boolean
  resolve: (value: boolean) => void
}

export interface Store {
  registry: RegistryResponse | null
  presets: Preset[]
  activePresetId: string | null
  tracks: Track[]
  folderPath: string | null
  loadingTracks: boolean
  engineError: string | null
  /** True until the engine has answered for the first time. */
  engineStarting: boolean
  /** Where the engine keeps presets + the port file (display only). */
  configDir: string | null

  selectedPaths: string[]
  search: string
  sortKey: SortKey | null
  sortDir: 1 | -1

  ruleset: Ruleset
  draft: BuilderDraft | null

  /** True while a file drag is over the window (DOM or native). */
  dragOver: boolean
  setDragOver: (value: boolean) => void
  editTrackPath: string | null
  applyReview: ApplyResponse | null
  applying: boolean
  toast: ToastState | null

  init: () => void
  appendPaths: (paths: string[]) => Promise<void>
  /** Import a mixed selection of audio files and folders (expanded by the engine). */
  importPaths: (paths: string[], mode: 'replace' | 'append') => Promise<void>
  removeTrack: (path: string) => void

  toggleSelect: (path: string, additive: boolean) => void
  selectRange: (paths: string[]) => void
  /** Replace the selection outright (shift-click, which may shrink it). */
  setSelection: (paths: string[]) => void
  clearSelection: () => void
  setSearch: (value: string) => void
  cycleSort: (key: SortKey) => void

  setDraft: (draft: BuilderDraft | null) => void
  updateDraftParam: (name: string, value: unknown) => void
  updateDraftType: (type: string) => void
  cancelDraft: () => void
  commitDraft: () => void
  removeRule: (id: string) => void
  toggleRule: (id: string) => void
  reorderRules: (dragId: string, targetId: string) => void

  openEdit: (path: string) => void
  closeEdit: () => void

  writeFields: (path: string, fields: Record<string, string>, renameTo?: string | null) => Promise<string[]>
  setCover: (path: string, mime: string, dataBase64: string) => Promise<void>
  setCoverFromFile: (path: string, imagePath: string) => Promise<void>
  removeCover: (path: string) => Promise<void>

  startApply: () => Promise<void>
  confirmApply: () => Promise<void>
  cancelApply: () => void

  savePreset: (name: string, presetId?: string | null) => Promise<void>
  loadPreset: (preset: Preset) => void
  deletePreset: (id: string) => Promise<void>
  importPresets: (entries: { id?: string; name: string; ruleset: Ruleset }[]) => Promise<number>

  showToast: (text: string, kind?: ToastState['kind']) => void

  /**
   * Ask the user to confirm something destructive. Resolves false when they
   * dismiss it in any way, so callers can guard with a plain `if (!ok) return`.
   */
  confirm: (request: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>

  /** Show the About box: version, where presets live, and the licence. */
  showAbout: () => void

  /**
   * Undo/redo for whatever text field has focus.
   *
   * Routed through the store so the Edit menu and the keyboard share one
   * implementation, and so a screen with its own history (the track editor) can
   * take over from the browser's per-field undo.
   */
  undo: () => void
  redo: () => void
  /**
   * Let a screen supply its own undo/redo, returning true when it handled the
   * action. Pass null on unmount. The text fields' own history is the default.
   */
  registerHistory: (handler: (() => boolean) | null) => void
}

export const StoreContext = createContext<Store | null>(null)

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore must be used inside StoreProvider')
  return store
}
