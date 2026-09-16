import { useRef, useState } from 'react'
import { useStore } from '../store-context'
import type { Preset } from '../types'

export function PresetManager({ onClose }: { onClose: () => void }) {
  const { presets, deletePreset, importPresets, showToast, configDir, confirm } = useStore()
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const fileInput = useRef<HTMLInputElement>(null)

  const toggle = (id: string) => {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const exportSelected = () => {
    const selected = presets.filter((p) => checked.has(p.id))
    if (!selected.length) {
      showToast('Select at least one ruleset to export', 'error')
      return
    }
    const payload = { yame_presets: 1, exported_unix: Date.now() / 1000, presets: selected }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = selected.length === 1 ? selected[0].name + '.yame.json' : 'yame-presets.json'
    a.click()
    URL.revokeObjectURL(url)
    showToast('Exported ' + selected.length + ' ruleset' + (selected.length === 1 ? '' : 's'), 'success')
  }

  const onImportFile = async (file: File) => {
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const entries: { id?: string; name: string; ruleset: unknown }[] = Array.isArray(data.presets) ? data.presets : [data]
      const valid = entries.filter(
        (e) => e && typeof e.name === 'string' && e.ruleset && typeof e.ruleset === 'object',
      )
      if (!valid.length) {
        showToast('No valid rulesets found in this file', 'error')
        return
      }
      const count = await importPresets(valid as { id?: string; name: string; ruleset: never }[])
      showToast('Imported ' + count + ' ruleset' + (count === 1 ? '' : 's'), 'success')
    } catch {
      showToast('This file is not a valid YAME presets export', 'error')
    }
  }

  const deleteSelected = async () => {
    const ids = Array.from(checked)
    if (!ids.length) {
      showToast('Select at least one ruleset to delete', 'error')
      return
    }
    const count = ids.length
    const ok = await confirm({
      title: 'Delete ' + count + ' ruleset' + (count === 1 ? '' : 's') + '?',
      message:
        count === 1
          ? 'This ruleset will be removed. Files it already changed are not affected.'
          : 'These rulesets will be removed. Files they already changed are not affected.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    let deleted = 0
    for (const id of ids) {
      try {
        await deletePreset(id)
        deleted++
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error')
      }
    }
    setChecked(new Set())
    if (deleted) {
      showToast('Deleted ' + deleted + ' ruleset' + (deleted === 1 ? '' : 's'), 'success')
    }
  }

  return (
    <div className="overlay-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="preset-modal">
        <div className="modal-header">
          <h3>Manage rulesets</h3>
          <button className="overlay-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="preset-list">
          {presets.length === 0 && <p className="field-help">No saved rulesets yet.</p>}
          {presets.map((preset) => (
            <label className="preset-row" key={preset.id}>
              <input
                type="checkbox"
                checked={checked.has(preset.id)}
                onChange={() => toggle(preset.id)}
              />
              <span className="preset-name">{preset.name}</span>
              <span className="preset-meta">{preset.ruleset.rules.length} rule{preset.ruleset.rules.length === 1 ? '' : 's'}</span>
              <ExportOne preset={preset} />
            </label>
          ))}
        </div>
        <div className="preset-footer">
          <span className="field-help">
            {configDir ? 'Stored in ' + configDir : 'Stored in the app config folder'}
          </span>
        </div>
        <div className="modal-footer">
          <button className="text-btn" onClick={() => fileInput.current?.click()}>
            Import…
          </button>
          <button className="text-btn" onClick={exportSelected}>
            Export selected
          </button>
          <button className="text-btn danger" onClick={deleteSelected} disabled={checked.size === 0}>
            Delete selected
          </button>
          <span style={{ flex: 1 }} />
          <button className="text-btn primary" onClick={onClose}>
            Done
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onImportFile(file)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}

function ExportOne({ preset }: { preset: Preset }) {
  const download = () => {
    const payload = { yame_presets: 1, presets: [preset] }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = preset.name + '.yame.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <button className="preset-download" onClick={download} title="Export this ruleset">
      ↓
    </button>
  )
}
