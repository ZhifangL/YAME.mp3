import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store-context'

export function SavePresetModal({ onClose }: { onClose: () => void }) {
  const { ruleset, presets, activePresetId, savePreset, showToast, configDir } = useStore()
  const [name, setName] = useState(ruleset.name)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      showToast('Give the preset a name', 'error')
      return
    }
    setSaving(true)
    try {
      const existing = presets.find((p) => p.id === activePresetId)
      await savePreset(trimmed, existing ? existing.id : null)
      onClose()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <div className="preset-save-modal">
        <div className="modal-header">
          <h3>Save as preset</h3>
          <button className="overlay-close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <div className="preset-save-body">
          <span className="field-label">Preset name</span>
          <input
            ref={inputRef}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') onClose()
            }}
            placeholder="My cleanup ruleset"
            spellCheck={false}
          />
          <span className="field-help">
            {ruleset.rules.length} rule{ruleset.rules.length === 1 ? '' : 's'} will be saved.
            {configDir ? ' Presets live in ' + configDir + ' and can be' : ' Presets can be'} exported
            from “Manage rulesets”.
          </span>
        </div>
        <div className="modal-footer">
          <button className="text-btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="save-btn" onClick={save} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
