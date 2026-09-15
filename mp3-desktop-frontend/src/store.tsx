// Central app state: tracks, selection, ruleset, presets, overlays, toasts.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from './api'
import { defaultParams } from './rules'
import { StoreContext, type BuilderDraft, type SortKey, type Store, type ToastState } from './store-context'
import type { ApplyResponse, Preset, RegistryResponse, RuleInstance, Ruleset, Track } from './types'

let toastCounter = 0

export function StoreProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<RegistryResponse | null>(null)
  const [presets, setPresets] = useState<Preset[]>([])
  const [tracks, setTracks] = useState<Track[]>([])
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [loadingTracks, setLoadingTracks] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)

  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [search, setSearch] = useState('')
  // null = no sorting: tracks appear in the order they were found in the
  // folder (Finder order). Sorting kicks in on the first column click.
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<1 | -1>(1)

  const [ruleset, setRuleset] = useState<Ruleset>({ name: 'Untitled ruleset', rules: [] })
  const [draft, setDraftState] = useState<BuilderDraft | null>(null)
  const [activePresetId, setActivePresetId] = useState<string | null>(null)

  const [editTrackPath, setEditTrackPath] = useState<string | null>(null)
  const [applyReview, setApplyReview] = useState<ApplyResponse | null>(null)
  const [applying, setApplying] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((text: string, kind: ToastState['kind'] = 'info') => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    const id = ++toastCounter
    setToast({ id, text, kind })
    toastTimer.current = setTimeout(() => {
      setToast((current) => (current && current.id === id ? null : current))
    }, 4200)
  }, [])

  const init = useCallback(() => {
    api
      .registry()
      .then(setRegistry)
      .catch((err) => {
        setEngineError(err instanceof Error ? err.message : String(err))
      })
    api
      .presets()
      .then(setPresets)
      .catch(() => {
        /* presets are optional at startup */
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
  }, [showToast])

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
        setTracks([])
        setFolderPath(null)
        setSelectedPaths([])
        return
      }
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
    [showToast],
  )

  // Add tracks from subsequently picked folders/files without dropping the
  // ones already in the table.
  const appendPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return
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
    [showToast],
  )

  const reloadTrack = useCallback(
    async (path: string) => {
      const res = await api.readTracks([path])
      if (res.tracks.length) {
        const track = res.tracks[0]
        setTracks((current) => current.map((t) => (t.file.path === path ? track : t)))
      }
    },
    [],
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

  const removeTrack = useCallback((path: string) => {
    setTracks((current) => current.filter((t) => t.file.path !== path))
    setSelectedPaths((current) => current.filter((p) => p !== path))
    setEditTrackPath((current) => (current === path ? null : current))
  }, [])

  const clearTracks = useCallback(() => {
    setTracks([])
    setFolderPath(null)
    setSelectedPaths([])
    setEditTrackPath(null)
  }, [])

  const toggleSelect = useCallback((path: string, additive: boolean) => {
    setSelectedPaths((current) => {
      if (additive) {
        return current.includes(path) ? current.filter((p) => p !== path) : [...current, path]
      }
      return current.includes(path) && current.length === 1 ? [] : [path]
    })
  }, [])

  const selectOnly = useCallback((path: string) => {
    setSelectedPaths([path])
  }, [])

  const selectRange = useCallback((paths: string[]) => {
    setSelectedPaths((current) => {
      const set = new Set(current)
      for (const p of paths) set.add(p)
      return Array.from(set)
    })
  }, [])

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
        setDraftState({ ...next, originalParams: { ...(rule ? rule.params : next.params) } })
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
    if (draft?.ruleId && draft.originalParams) {
      applyRulePatch(draft.ruleId, { params: draft.originalParams })
    }
    setDraftState(null)
  }, [draft, applyRulePatch])

  const addRule = useCallback(
    (type: string) => {
      if (!registry) return
      const spec = registry.specs.find((s) => s.type === type)
      if (!spec) return
      const rule: RuleInstance = {
        id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type,
        params: defaultParams(spec.params),
        enabled: true,
      }
      mutateRuleset((rs) => ({ ...rs, rules: [...rs.rules, rule] }))
      setDraftState({ ruleId: rule.id, type, params: rule.params })
    },
    [registry, mutateRuleset],
  )

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

  const setName = useCallback((name: string) => {
    setRuleset((current) => ({ ...current, name }))
  }, [])

  const openEdit = useCallback((path: string) => setEditTrackPath(path), [])
  const closeEdit = useCallback(() => setEditTrackPath(null), [])

  const writeFields = useCallback(
    async (path: string, fields: Record<string, string>, renameTo?: string | null): Promise<string[]> => {
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
    [removeTrack, upsertTrack],
  )

  const setCover = useCallback(
    async (path: string, mime: string, dataBase64: string) => {
      const res = await api.setCover(path, mime, dataBase64)
      if (res.track) upsertTrack(res.track)
      res.warnings.forEach((w) => showToast(w, 'error'))
    },
    [showToast, upsertTrack],
  )

  const removeCover = useCallback(
    async (path: string) => {
      const res = await api.removeCover(path)
      if (res.track) upsertTrack(res.track)
      res.warnings.forEach((w) => showToast(w, 'error'))
    },
    [showToast, upsertTrack],
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
    setApplying(true)
    try {
      const result = await api.apply(targetPaths, ruleset, false)
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
        .map((r) => r.new_filename !== r.filename && r.new_filename ? dirOf(r.path) + '/' + r.new_filename : r.path)
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
                const newPath = dirOf(renamed.path) + '/' + renamed.new_filename
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
  }, [applyReview, ruleset, showToast])

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
      selectedPaths,
      search,
      sortKey,
      sortDir,
      ruleset,
      draft,
      editTrackPath,
      applyReview,
      applying,
      toast,
      init,
      loadFolder,
      appendPaths,
      replacePaths,
      reloadTrack,
      upsertTrack,
      removeTrack,
      clearTracks,
      toggleSelect,
      selectOnly,
      selectRange,
      clearSelection,
      setSearch,
      cycleSort,
      setDraft,
      updateDraftParam,
      updateDraftType,
      cancelDraft,
      addRule,
      commitDraft,
      removeRule,
      toggleRule,
      reorderRules,
      setName,
      openEdit,
      closeEdit,
      writeFields,
      setCover,
      removeCover,
      startApply,
      confirmApply,
      cancelApply,
      savePreset,
      loadPreset,
      deletePreset,
      importPresets,
      showToast,
    }),
    [
      registry, presets, activePresetId, tracks, folderPath, loadingTracks, engineError,
      selectedPaths, search, sortKey, sortDir, ruleset, draft, editTrackPath,
      applyReview, applying, toast,
      init, loadFolder, appendPaths, replacePaths, reloadTrack, upsertTrack, removeTrack, clearTracks,
      toggleSelect, selectOnly, selectRange, clearSelection, setSearch, cycleSort,
      setDraft, updateDraftParam, updateDraftType, cancelDraft, addRule, commitDraft,
      removeRule, toggleRule, reorderRules, setName, openEdit,
      closeEdit, writeFields, setCover, removeCover,
      startApply, confirmApply, cancelApply, savePreset, loadPreset,
      deletePreset, importPresets, showToast,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}
