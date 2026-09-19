// Central app state: tracks, selection, ruleset, presets, overlays, toasts.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from './api'
import { appVersion as shellVersion } from './env'
import { ConfirmDialog } from './components/ConfirmDialog'
import { defaultParams } from './rules'
import { StoreContext, type BuilderDraft, type ConfirmRequest, type SortKey, type Store, type ToastState } from './store-context'
import type { ApplyResponse, Preset, RegistryResponse, RuleInstance, Ruleset, Track } from './types'
import { dirOf, joinPath } from './utils'

/** One undoable step: the list and selection as they were, and what changed. */
interface HistoryStep {
  tracks: Track[]
  selection: string[]
  /** Paths the action touched, so a re-read (if ever needed) knows where. */
  touched: string[]
}

let toastCounter = 0

export function StoreProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<RegistryResponse | null>(null)
  const [presets, setPresets] = useState<Preset[]>([])
  const [tracks, setTracks] = useState<Track[]>([])
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [loadingTracks, setLoadingTracks] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)
  // In the packaged app the Python sidecar takes a moment to come up, so the
  // first fetch or two are expected to fail. Retry before calling it an error.
  const [engineStarting, setEngineStarting] = useState(true)
  const [configDir, setConfigDir] = useState<string | null>(null)
  /** The engine's API version, which is the app's version. */
  const [version, setVersion] = useState<string | null>(null)
  /** The shell's build version — correct even when the engine never answers. */
  const [appVersion, setAppVersion] = useState<string | null>(null)

  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  // Mirrors of `tracks` and the selection. A history step is recorded *before*
  // an action runs, and by the time a write returns, state has already moved
  // on — so the step has to come from here rather than from the state value the
  // current render closed over.
  const tracksRef = useRef<Track[]>([])
  const selectionRef = useRef<string[]>([])
  useEffect(() => {
    tracksRef.current = tracks
  }, [tracks])
  useEffect(() => {
    selectionRef.current = selectedPaths
  }, [selectedPaths])
  const [search, setSearch] = useState('')
  // null = no sorting: tracks appear in the order they were found in the
  // folder (file-manager order). Sorting kicks in on the first column click.
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<1 | -1>(1)

  const [ruleset, setRuleset] = useState<Ruleset>({ name: 'Untitled ruleset', rules: [] })
  const [draft, setDraftState] = useState<BuilderDraft | null>(null)
  const [activePresetId, setActivePresetId] = useState<string | null>(null)

  // Set by both the DOM drag handlers (browser) and the native drop bridge
  // (packaged app), so the drop hint works the same in both.
  const [dragOver, setDragOver] = useState(false)
  const [editTrackPath, setEditTrackPath] = useState<string | null>(null)
  const [applyReview, setApplyReview] = useState<ApplyResponse | null>(null)
  const [applying, setApplying] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((text: string, kind: ToastState['kind'] = 'info') => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    const id = ++toastCounter
    setToast({ id, text, kind })
    toastTimer.current = setTimeout(() => {
      setToast((current) => (current && current.id === id ? null : current))
    }, 4200)
  }, [])

  // Ask before a destructive action. Resolves false when the user dismisses the
  // dialog by any route, so callers can use a plain `if (!ok) return`.
  //
  // A second request replaces the first and resolves it false: nothing in the
  // UI can raise two at once, but a dropped promise would hang the caller
  // forever, and hanging is worse than the wrong answer here.
  const confirm = useCallback(
    (request: Omit<ConfirmRequest, 'resolve'>) =>
      new Promise<boolean>((resolve) => {
        setConfirmRequest((previous) => {
          previous?.resolve(false)
          return { ...request, resolve }
        })
      }),
    [],
  )

  /**
   * The About box, raised by Help in the title bar and by Help ▸ About.
   *
   * Shown through the confirm dialog rather than a bespoke modal: it is a few
   * lines of text with one button, and a second dialog component for that would
   * be one more thing to keep styled consistently on every platform.
   */
  const showAbout = useCallback(() => {
    // The version falls back to the shell's build version. The engine reports
    // its own, but the About box is exactly what a user opens when the engine
    // is *not* answering — so at that moment it must not say "unknown".
    const shown = version ?? appVersion ?? 'unknown'
    const message = [
      'YAME (Yet Another Metadata Editor)',
      `Version ${shown}`,
      'GNU GPL v3.0 or later',
    ].join('\n')
    // `cancelLabel: null` — an information box has one button, not two.
    void confirm({ title: 'YAME.mp3', message, confirmLabel: 'Close', cancelLabel: null })
  }, [confirm, version, appVersion])

  /**
   * Undo/redo.
   *
   * Three rules, from how the user expects the shortcut to behave:
   *
   * 1. **Only edits are undoable.** Loading songs — opening a folder, adding
   *    files, a drop — sets the *baseline*. Undo must never unload the library
   *    or step back to a previous selection of it; the first load is the floor.
   * 2. **One edit, one step.** Removing ten songs with Backspace, or applying a
   *    ruleset to a whole batch, undoes in a single press.
   * 3. **Focus decides** which history the keystroke belongs to: a text field
   *    keeps its own, the track list owns everything else.
   *
   * Rule 3 is not cosmetic: `document.execCommand('undo')` targets whatever has
   * focus, and the search box autofocuses — so without the split, every Ctrl+Z
   * was consumed as search undo.
   *
   * Each step records the paths it touched, because undoing an *edit* has to
   * re-read those files: the tags on disk changed, so restoring the old in-memory
   * objects would show the user values that are no longer true.
   */
  const history = useRef<{ past: HistoryStep[]; future: HistoryStep[] }>({ past: [], future: [] })

  /** Record the state before an edit, so it can be undone. */
  const recordEdit = useCallback((snapshot: Track[], touched: string[]) => {
    const stacks = history.current
    stacks.past.push({ tracks: snapshot, selection: selectionRef.current, touched })
    // A list is a few hundred small objects: 50 steps is generous context for
    // very little memory, while unbounded growth in a long session is not.
    if (stacks.past.length > 50) stacks.past.shift()
    // A new edit invalidates the redo branch, as it does everywhere else.
    stacks.future.length = 0
  }, [])

  /**
   * Record a *load* as an action.
   *
   * Loading is undoable like anything else, but the first load is the floor:
   * there is nothing before it, so recording it would make undo able to empty
   * the window — which is exactly what must never happen.
   */
  const recordLoad = useCallback(() => {
    if (!tracksRef.current.length) return
    recordEdit(tracksRef.current, [])
  }, [recordEdit])

  /**
   * Drive the focused field's own undo stack.
   *
   * Guarded because `execCommand` is deprecated and not universally present —
   * it exists in WebKit and WebView2, which is where the app runs, but a
   * missing method here must not turn Ctrl+Z into a crash.
   */
  const fieldHistory = (command: 'undo' | 'redo') => {
    try {
      if (typeof document.execCommand === 'function') document.execCommand(command)
    } catch {
      /* nothing to undo, or unsupported — either way, nothing to report */
    }
  }

  /** True when the keystroke belongs to a text field rather than the list. */
  const typing = () => {
    const el = document.activeElement
    return (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    )
  }

  /**
   * Put a list back on screen, re-reading the files the step touched.
   *
   * Re-reading rather than reusing the remembered objects is the difference
   * between "undo" and "pretend": an edit changed the file on disk, so only the
   * disk knows what the tags are now.
   */
  /**
   * Put a recorded step back on screen. Synchronous — nothing is fetched.
   *
   * An earlier version re-read the touched files so the rows showed the tags as
   * they now are on disk. That is more truthful, but it cost an engine round
   * trip on every press, which the user felt as lag — and undo is meant to put
   * the list back, not to interrogate the files.
   */
  const restore = useCallback((step: HistoryStep) => {
    setTracks(step.tracks)
    // Only paths still present: a selection cannot name a file that is gone.
    setSelectedPaths(step.selection.filter((p) => step.tracks.some((t) => t.file.path === p)))
  }, [])

  const undo = useCallback(() => {
    if (typing()) {
      fieldHistory('undo')
      return
    }
    const stacks = history.current
    const previous = stacks.past.pop()
    if (!previous) return
    // The *current* state becomes the redo step, keeping the paths that this
    // step touched so redo re-reads the same files.
    stacks.future.push({ tracks: tracksRef.current, selection: selectionRef.current, touched: previous.touched })
    restore(previous)
  }, [restore])

  const redo = useCallback(() => {
    if (typing()) {
      fieldHistory('redo')
      return
    }
    const stacks = history.current
    const next = stacks.future.pop()
    if (!next) return
    stacks.past.push({ tracks: tracksRef.current, selection: selectionRef.current, touched: next.touched })
    restore(next)
  }, [restore])

  const init = useCallback(async () => {
    // The engine (a bundled sidecar in the packaged app) may still be starting.
    const deadline = Date.now() + 30000
    for (let attempt = 1; ; attempt++) {
      try {
        setRegistry(await api.registry())
        setEngineError(null)
        setEngineStarting(false)
        break
      } catch (err) {
        if (Date.now() > deadline) {
          setEngineError(err instanceof Error ? err.message : String(err))
          setEngineStarting(false)
          break
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * attempt, 1500)))
      }
    }
    api
      .presets()
      .then(setPresets)
      .catch(() => {
        /* presets are optional at startup */
      })
    // Asked of the shell rather than the engine: this is the About box's
    // fallback when the engine is unreachable.
    setAppVersion(shellVersion())

    api
      .health()
      .then((res) => {
        setConfigDir(res.config_dir)
        setVersion(res.version)
      })
      .catch(() => {
        /* the config path and version are only used for display */
      })
  }, [])

  // Sorting returns to natural (folder) order whenever a new folder replaces
  // the trackview.
  const resetSort = useCallback(() => {
    setSortKey(null)
    setSortDir(1)
  }, [])

  const loadFolder = useCallback((path: string, explicitPaths?: string[]) => {
    setLoadingTracks(true)
    setEngineError(null)
    const finish = () => setLoadingTracks(false)
    const load = (folderPathValue: string, paths: string[]) => {
      recordLoad()
      api
        .readTracks(paths)
        .then((res) => {
          setTracks(res.tracks)
          setFolderPath(folderPathValue)
          setSelectedPaths([])
          setSearch('')
          resetSort()
          if (res.errors && res.errors.length) {
            showToast(res.errors.length + ' file(s) could not be read', 'error')
          }
        })
        .catch((err) => {
          setEngineError(err instanceof Error ? err.message : String(err))
          showToast('Could not load the folder', 'error')
        })
        .finally(finish)
    }
    if (explicitPaths) {
      load(path, explicitPaths)
      return
    }
    api
      .browse(path)
      .then((res) => {
        if (!res.audio_files.length) {
          showToast('No audio files in this folder', 'info')
          finish()
          return
        }
        load(res.path, res.audio_files.map((f) => f.path))
      })
      .catch((err) => {
        setEngineError(err instanceof Error ? err.message : String(err))
        showToast('Could not open the folder', 'error')
        finish()
      })
  }, [showToast, resetSort, recordLoad])

  // Dev convenience: ?folder=/abs/path auto-loads a folder on startup.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const folder = params.get('folder')
    if (!folder) return
    const timer = setTimeout(() => {
      loadFolder(folder)
    }, 0)
    return () => clearTimeout(timer)
  }, [loadFolder])

  // Replace the whole trackview with the given files (e.g. "Open" / drops).
  const replacePaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) {
        recordLoad()
        setTracks([])
        setFolderPath(null)
        setSelectedPaths([])
        return
      }
      recordLoad()
      setLoadingTracks(true)
      try {
        const res = await api.readTracks(paths)
        setTracks(res.tracks)
        setFolderPath(res.tracks.length ? dirOf(res.tracks[0].file.path) : null)
        setSelectedPaths([])
        setSearch('')
        resetSort()
        if (res.errors && res.errors.length) {
          showToast(res.errors.length + ' file(s) could not be read', 'error')
        }
        if (res.tracks.length) {
          showToast('Loaded ' + res.tracks.length + ' track' + (res.tracks.length === 1 ? '' : 's'), 'success')
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        setLoadingTracks(false)
      }
    },
    [showToast, resetSort, recordLoad],
  )

  // Add tracks from subsequently picked folders/files without dropping the
  // ones already in the table.
  const appendPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return
      // Snapshot before the fetch: after it, the list may already have moved.
      recordLoad()
      setLoadingTracks(true)
      try {
        const res = await api.readTracks(paths)
        setTracks((current) => {
          const byPath = new Map(current.map((t) => [t.file.path, t]))
          for (const t of res.tracks) byPath.set(t.file.path, t)
          return Array.from(byPath.values())
        })
        if (res.tracks.length) {
          setFolderPath((current) => current ?? dirOf(res.tracks[0].file.path))
        }
        if (res.errors && res.errors.length) {
          showToast(res.errors.length + ' file(s) could not be read', 'error')
        }
        if (res.tracks.length) {
          showToast('Added ' + res.tracks.length + ' track' + (res.tracks.length === 1 ? '' : 's'), 'success')
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        setLoadingTracks(false)
      }
    },
    [showToast, recordLoad],
  )

  // Import a mixed selection of files and folders. The engine expands
  // directories recursively, so drag-and-drop and the native dialog share one
  // path and always agree on what counts as audio.
  const importPaths = useCallback(
    async (paths: string[], mode: 'replace' | 'append') => {
      if (!paths.length) return
      let expanded
      try {
        expanded = await api.expandPaths(paths)
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error')
        return
      }
      if (!expanded.files.length) {
        showToast(expanded.skipped.length ? 'No audio files in that selection' : 'Nothing to import', 'info')
        return
      }
      if (mode === 'replace') await replacePaths(expanded.files)
      else await appendPaths(expanded.files)

      if (expanded.truncated) showToast('Only the first 20,000 files were imported', 'info')
      else if (expanded.skipped.length) {
        showToast(expanded.skipped.length + ' item(s) were not audio and were skipped', 'info')
      }
    },
    [replacePaths, appendPaths, showToast],
  )

  const upsertTrack = useCallback((track: Track) => {
    setTracks((current) => {
      const idx = current.findIndex((t) => t.file.path === track.file.path)
      if (idx === -1) return [...current, track]
      const next = [...current]
      next[idx] = track
      return next
    })
  }, [])

  const removeTrack = useCallback(
    (path: string) => {
      recordEdit(tracksRef.current, [path])
      setTracks((current) => current.filter((t) => t.file.path !== path))
      setSelectedPaths((current) => current.filter((p) => p !== path))
      setEditTrackPath((current) => (current === path ? null : current))
    },
    [recordEdit],
  )

  /** Remove several songs as one undoable step — what Backspace does. */
  const removeTracks = useCallback(
    (paths: string[]) => {
      if (!paths.length) return
      const doomed = new Set(paths)
      recordEdit(tracksRef.current, paths)
      setTracks((current) => current.filter((t) => !doomed.has(t.file.path)))
      setSelectedPaths((current) => current.filter((p) => !doomed.has(p)))
      setEditTrackPath((current) => (current && doomed.has(current) ? null : current))
    },
    [recordEdit],
  )

  const toggleSelect = useCallback((path: string, additive: boolean) => {
    setSelectedPaths((current) => {
      if (additive) {
        return current.includes(path) ? current.filter((p) => p !== path) : [...current, path]
      }
      return current.includes(path) && current.length === 1 ? [] : [path]
    })
  }, [])

  const selectRange = useCallback((paths: string[]) => {
    setSelectedPaths((current) => {
      const set = new Set(current)
      for (const p of paths) set.add(p)
      return Array.from(set)
    })
  }, [])

  // Shift-click is an anchor-to-cursor range, so it replaces rather than
  // unions — otherwise a range could only ever grow.
  const setSelection = useCallback((paths: string[]) => setSelectedPaths(paths), [])

  const clearSelection = useCallback(() => setSelectedPaths([]), [])

  const cycleSort = useCallback(
    (key: SortKey) => {
      // Two independent updates — the previous version nested one setState
      // inside the other's updater, which StrictMode double-invocation
      // flipped back, so descending never stuck.
      if (sortKey === key) {
        setSortDir((dir) => (dir === 1 ? -1 : 1))
      } else {
        setSortKey(key)
        setSortDir(1)
      }
    },
    [sortKey],
  )

  // Structural ruleset changes detach the active preset (the ruleset no
  // longer matches what was loaded).
  const touchRuleset = useCallback(() => setActivePresetId(null), [])
  const mutateRuleset = useCallback(
    (fn: (rs: Ruleset) => Ruleset) => {
      touchRuleset()
      setRuleset(fn)
    },
    [touchRuleset],
  )

  const applyRulePatch = useCallback((ruleId: string, patch: Partial<RuleInstance>) => {
    setRuleset((rs) => ({
      ...rs,
      rules: rs.rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r)),
    }))
  }, [])

  const setDraft = useCallback(
    (next: BuilderDraft | null) => {
      if (next && next.ruleId) {
        const rule = ruleset.rules.find((r) => r.id === next.ruleId)
        setDraftState({
          ...next,
          originalParams: { ...(rule ? rule.params : next.params) },
          originalType: rule ? rule.type : next.type,
        })
        return
      }
      setDraftState(next)
    },
    [ruleset],
  )

  // Param edits are applied to the rule immediately, so Apply always uses
  // the current values in the builder's text boxes.
  const updateDraftParam = useCallback(
    (name: string, value: unknown) => {
      setDraftState((current) =>
        current ? { ...current, params: { ...current.params, [name]: value } } : current,
      )
      if (draft?.ruleId) {
        const rule = ruleset.rules.find((r) => r.id === draft.ruleId)
        if (rule) applyRulePatch(draft.ruleId, { params: { ...rule.params, [name]: value } })
      }
    },
    [draft, ruleset, applyRulePatch],
  )

  const updateDraftType = useCallback(
    (type: string) => {
      if (!draft || !registry) return
      const spec = registry.specs.find((s) => s.type === type)
      if (!spec) return
      const params = defaultParams(spec.params)
      setDraftState((current) => (current ? { ...current, type, params } : current))
      if (draft.ruleId) applyRulePatch(draft.ruleId, { type, params })
    },
    [draft, registry, applyRulePatch],
  )

  const cancelDraft = useCallback(() => {
    // Switching the type in the builder patches the rule live, so cancelling
    // has to put BOTH halves back — restoring only the params would leave the
    // new rule type holding the old type's inputs.
    if (draft?.ruleId) {
      const patch: Partial<RuleInstance> = {}
      if (draft.originalParams) patch.params = draft.originalParams
      if (draft.originalType) patch.type = draft.originalType
      if (Object.keys(patch).length) applyRulePatch(draft.ruleId, patch)
    }
    setDraftState(null)
  }, [draft, applyRulePatch])

  const commitDraft = useCallback(() => {
    if (!draft) return
    if (draft.ruleId) {
      // Edits are live; committing just closes the builder.
      setDraftState(null)
      return
    }
    const rule: RuleInstance = {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: draft.type,
      params: draft.params,
      enabled: true,
    }
    mutateRuleset((rs) => ({ ...rs, rules: [...rs.rules, rule] }))
    setDraftState(null)
  }, [draft, mutateRuleset])

  const removeRule = useCallback(
    (id: string) => {
      mutateRuleset((rs) => ({ ...rs, rules: rs.rules.filter((r) => r.id !== id) }))
      setDraftState((current) => (current && current.ruleId === id ? null : current))
    },
    [mutateRuleset],
  )

  const toggleRule = useCallback((id: string) => {
    setRuleset((rs) => ({
      ...rs,
      rules: rs.rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
    }))
  }, [])

  const reorderRules = useCallback(
    (dragId: string, targetId: string) => {
      if (dragId === targetId) return
      mutateRuleset((rs) => {
        const from = rs.rules.findIndex((r) => r.id === dragId)
        const to = rs.rules.findIndex((r) => r.id === targetId)
        if (from === -1 || to === -1) return rs
        const rules = [...rs.rules]
        const [rule] = rules.splice(from, 1)
        rules.splice(to, 0, rule)
        return { ...rs, rules }
      })
    },
    [mutateRuleset],
  )

  const openEdit = useCallback((path: string) => setEditTrackPath(path), [])
  const closeEdit = useCallback(() => setEditTrackPath(null), [])

  const writeFields = useCallback(
    async (path: string, fields: Record<string, string>, renameTo?: string | null): Promise<string[]> => {
      // Snapshot before the write, so this is undoable like any other edit.
      recordEdit(tracksRef.current, [path])
      const res = await api.writeTrack(path, fields, renameTo)
      if (renameTo) {
        // The file moved: drop the old path, adopt the new one.
        if (res.track) {
          removeTrack(path)
          upsertTrack(res.track)
          setSelectedPaths((current) =>
            current.includes(path) ? current.filter((p) => p !== path).concat(res.track ? [res.track.file.path] : []) : current,
          )
          setEditTrackPath((current) => (current === path && res.track ? res.track.file.path : current))
          return res.warnings
        }
      } else if (res.track) {
        upsertTrack(res.track)
      }
      return res.warnings
    },
    [removeTrack, upsertTrack, recordEdit],
  )

  const setCover = useCallback(
    async (path: string, mime: string, dataBase64: string) => {
      recordEdit(tracksRef.current, [path])
      const res = await api.setCover(path, mime, dataBase64)
      if (res.track) upsertTrack(res.track)
      res.warnings.forEach((w) => showToast(w, 'error'))
    },
    [showToast, upsertTrack, recordEdit],
  )

  // Apply an image that is already on disk as cover art (a file-manager drop or the
  // native image picker). Avoids base64 entirely.
  const setCoverFromFile = useCallback(
    async (path: string, imagePath: string) => {
      recordEdit(tracksRef.current, [path])
      const res = await api.setCoverFromFile(path, imagePath)
      if (res.track) upsertTrack(res.track)
      res.warnings.forEach((w) => showToast(w, 'error'))
    },
    [showToast, upsertTrack, recordEdit],
  )

  const removeCover = useCallback(
    async (path: string) => {
      recordEdit(tracksRef.current, [path])
      const res = await api.removeCover(path)
      if (res.track) upsertTrack(res.track)
      res.warnings.forEach((w) => showToast(w, 'error'))
    },
    [showToast, upsertTrack, recordEdit],
  )

  const startApply = useCallback(async () => {
    const targetPaths =
      selectedPaths.length > 0 ? selectedPaths : tracks.map((t) => t.file.path)
    if (!targetPaths.length) {
      showToast('Nothing to apply — open a folder first', 'info')
      return
    }
    const enabled = ruleset.rules.filter((r) => r.enabled)
    if (!enabled.length) {
      showToast('Add at least one rule to apply', 'info')
      return
    }
    try {
      const result = await api.apply(targetPaths, ruleset, true)
      setApplyReview(result)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }, [selectedPaths, tracks, ruleset, showToast])

  const confirmApply = useCallback(async () => {
    if (!applyReview) return
    const targetPaths = applyReview.results.map((r) => r.path)
    // Applying a ruleset is one edit, however many files it touches: a single
    // undo reverses the whole batch, which is what "undo the last action" means
    // when the last action was a batch.
    const before = tracksRef.current
    setApplying(true)
    try {
      const result = await api.apply(targetPaths, ruleset, false)
      recordEdit(before, targetPaths)
      setApplyReview(null)
      if (result.changed_files > 0) {
        showToast('Applied rules to ' + result.changed_files + ' file(s)', 'success')
      } else {
        showToast('No files changed', 'info')
      }
      // Refresh every file that was actually written (some may have been
      // renamed). Unchanged files keep their current row.
      const newPaths = result.results
        .filter((r) => r.written)
        .map((r) => r.new_filename !== r.filename && r.new_filename ? joinPath(dirOf(r.path), r.new_filename) : r.path)
      if (newPaths.length) {
        const res = await api.readTracks(newPaths)
        if (res.tracks.length) {
          const fresh = new Map(res.tracks.map((t) => [t.file.path, t]))
          setTracks((current) => {
            const out: Track[] = []
            for (const t of current) {
              const hit = fresh.get(t.file.path)
              if (hit) {
                out.push(hit)
                continue
              }
              const renamed = result.results.find(
                (rr) => rr.path === t.file.path && rr.written && rr.new_filename !== rr.filename,
              )
              if (renamed) {
                const newPath = joinPath(dirOf(renamed.path), renamed.new_filename)
                const moved = fresh.get(newPath)
                if (moved) {
                  out.push(moved)
                } else {
                  // Renamed but the re-read failed: keep the row with the new name.
                  out.push({ ...t, file: { ...t.file, path: newPath, filename: renamed.new_filename } })
                }
              } else {
                out.push(t)
              }
            }
            return out
          })
          setSelectedPaths([])
        }
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setApplying(false)
    }
  }, [applyReview, ruleset, showToast, recordEdit])

  const cancelApply = useCallback(() => setApplyReview(null), [])

  const savePreset = useCallback(
    async (name: string, presetId?: string | null) => {
      const preset = await api.savePreset(name, ruleset, presetId)
      setPresets((current) => {
        const idx = current.findIndex((p) => p.id === preset.id)
        if (idx === -1) return [...current, preset]
        const next = [...current]
        next[idx] = preset
        return next
      })
      setActivePresetId(preset.id)
      showToast('Preset saved', 'success')
    },
    [ruleset, showToast],
  )

  const loadPreset = useCallback(
    (preset: Preset) => {
      const rules = preset.ruleset.rules.map((r) => ({
        ...r,
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      }))
      setRuleset({ name: preset.ruleset.name || preset.name, rules })
      setDraftState(null)
      setActivePresetId(preset.id)
      showToast('Loaded preset "' + preset.name + '"', 'success')
    },
    [showToast],
  )

  const deletePreset = useCallback(
    async (id: string) => {
      await api.deletePreset(id)
      setPresets((current) => current.filter((p) => p.id !== id))
      setActivePresetId((current) => (current === id ? null : current))
    },
    [],
  )

  const importPresets = useCallback(
    async (entries: { id?: string; name: string; ruleset: Ruleset }[]): Promise<number> => {
      const imported = await api.importPresets(entries)
      setPresets((current) => {
        const merged = [...current]
        for (const preset of imported) {
          const idx = merged.findIndex((p) => p.id === preset.id)
          if (idx === -1) merged.push(preset)
          else merged[idx] = preset
        }
        return merged
      })
      return imported.length
    },
    [],
  )

  const value = useMemo<Store>(
    () => ({
      registry,
      presets,
      activePresetId,
      tracks,
      folderPath,
      loadingTracks,
      engineError,
      engineStarting,
      configDir,
      selectedPaths,
      search,
      sortKey,
      sortDir,
      ruleset,
      draft,
      dragOver,
      editTrackPath,
      applyReview,
      applying,
      toast,
      init,
      appendPaths,
      importPaths,
      removeTrack,
      toggleSelect,
      selectRange,
      setSelection,
      clearSelection,
      setSearch,
      cycleSort,
      setDraft,
      updateDraftParam,
      updateDraftType,
      cancelDraft,
      commitDraft,
      removeRule,
      toggleRule,
      reorderRules,
      openEdit,
      closeEdit,
      writeFields,
      setCover,
      setCoverFromFile,
      setDragOver,
      removeCover,
      startApply,
      confirmApply,
      cancelApply,
      savePreset,
      loadPreset,
      deletePreset,
      importPresets,
      showToast,
      confirm,
      showAbout,
      undo,
      redo,
      removeTracks,
    }),
    [
      registry, presets, activePresetId, tracks, folderPath, loadingTracks, engineError, engineStarting, configDir,
      selectedPaths, search, sortKey, sortDir, ruleset, draft, dragOver, editTrackPath,
      applyReview, applying, toast,
      init, appendPaths, importPaths, removeTrack,
      toggleSelect, selectRange, setSelection, clearSelection, setSearch, cycleSort,
      setDraft, updateDraftParam, updateDraftType, cancelDraft, commitDraft,
      removeRule, toggleRule, reorderRules, openEdit,
      closeEdit, writeFields, setCover, setCoverFromFile, removeCover,
      startApply, confirmApply, cancelApply, savePreset, loadPreset,
      deletePreset, importPresets, showToast, confirm, showAbout, undo, redo, removeTracks,
    ],
  )

  // The confirmation dialog is owned here rather than by a component: `confirm`
  // is a store action, and keeping the dialog next to the state that backs it
  // means a caller cannot ask without a dialog being mounted to answer.
  return (
    <StoreContext.Provider value={value}>
      {children}
      <ConfirmDialog state={confirmRequest} onClose={() => setConfirmRequest(null)} />
    </StoreContext.Provider>
  )
}
