import { useRef, useState } from 'react'
import { useStore } from '../store-context'
import { PresetManager } from './PresetManager'
import { RuleBuilder } from './RuleBuilder'
import { RuleCard } from './RuleCard'

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function RulesSidebar() {
  const {
    registry,
    ruleset,
    draft,
    setDraft,
    tracks,
    selectedPaths,
    presets,
    activePresetId,
    loadPreset,
    startApply,
    savePreset,
    showToast,
  } = useStore()
  const [naming, setNaming] = useState(false)
  const [presetName, setPresetName] = useState(ruleset.name)
  const [manageOpen, setManageOpen] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const builderRef = useRef<HTMLDivElement>(null)

  const enabledCount = ruleset.rules.filter((r) => r.enabled).length
  const applyTarget = selectedPaths.length > 0 ? selectedPaths.length : tracks.length
  const activePreset = presets.find((p) => p.id === activePresetId) ?? null
  const headerLabel = activePreset ? activePreset.name : 'Your ruleset'

  const startNaming = () => {
    setPresetName(ruleset.name)
    setNaming(true)
    requestAnimationFrame(() => nameInput.current?.select())
  }

  const commitName = async () => {
    const name = presetName.trim()
    if (!name) {
      showToast('Give the preset a name', 'error')
      return
    }
    await savePreset(name, activePreset ? activePreset.id : null)
    setNaming(false)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <div className="sidebar-header">
          <span className="kicker" title={activePreset ? 'Loaded from preset' : ''}>
            {headerLabel}
          </span>
          <button className="icon-btn" onClick={() => { setDraft(null); builderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }} title="Add a rule">
            <PlusIcon />
          </button>
        </div>

        {/* Fixed builder slot — the rules list below never jumps. */}
        <div ref={builderRef}>
          {draft ? (
            <RuleBuilder />
          ) : (
            <div className="builder">
              <div className="builder-title">
                <span className="kicker">New rule</span>
              </div>
              <div className="rule-menu">
                {(registry?.specs ?? []).map((spec) => (
                  <button
                    key={spec.type}
                    onClick={() => setDraft({ ruleId: null, type: spec.type, params: defaultsFor(spec) })}
                    title={spec.description}
                  >
                    {spec.label}
                  </button>
                ))}
              </div>
              <p className="field-help" style={{ margin: 0 }}>
                Pick a rule type, fill it in and add it — rules run top to bottom.
              </p>
            </div>
          )}
        </div>

        <div className="ruleset-header">
          <span className="kicker">
            Rules {ruleset.rules.length > 0 ? '(' + ruleset.rules.length + ')' : ''}
          </span>
          <select
            className="select preset-select"
            value={activePresetId ?? ''}
            onChange={(e) => {
              const id = e.target.value
              if (id === '__manage__') {
                setManageOpen(true)
                return
              }
              const preset = presets.find((p) => p.id === id)
              if (preset) loadPreset(preset)
            }}
            title="Load a saved preset"
          >
            <option value="">Presets…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="__manage__">— Manage rulesets…</option>
          </select>
        </div>

        <div className="rules-list">
          {ruleset.rules.map((rule) => (
            <RuleCard key={rule.id} rule={rule} />
          ))}
          {ruleset.rules.length === 0 && (
            <p className="field-help" style={{ margin: '2px 2px 0', lineHeight: 1.5 }}>
              No rules yet. A rule is one step — e.g. replace “ - ” with “ – ” in the Title field.
              Rules run top to bottom when you apply them.
            </p>
          )}
        </div>

        <div className="sidebar-actions">
          <button className="apply-btn" onClick={startApply} disabled={enabledCount === 0 || tracks.length === 0}>
            ▶ {applyTarget === tracks.length ? 'Apply to all files' : 'Apply to selected (' + applyTarget + ')'}
          </button>

          {naming ? (
            <div className="field-row">
              <input
                ref={nameInput}
                className="input"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName()
                  if (e.key === 'Escape') setNaming(false)
                }}
                placeholder="Preset name"
              />
              <div className="builder-actions">
                <button className="text-btn" onClick={() => setNaming(false)}>
                  Cancel
                </button>
                <button className="text-btn primary" onClick={commitName}>
                  Save
                </button>
              </div>
            </div>
          ) : (
            <button className="save-preset-btn" onClick={startNaming} disabled={ruleset.rules.length === 0}>
              Save as preset
            </button>
          )}
        </div>
      </div>
      {manageOpen && <PresetManager onClose={() => setManageOpen(false)} />}
    </aside>
  )
}

function defaultsFor(spec: { type: string; params: { name: string; kind: string; default?: unknown; choices?: { key: string }[] }[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of spec.params) {
    if (p.kind === 'parse_pattern') out[p.name] = '* - *'
    else if (p.kind === 'parse_assignments') out[p.name] = {}
    else if (p.kind === 'image') out[p.name] = null
    else if (p.kind === 'bool') out[p.name] = p.default ?? true
    else out[p.name] = p.default ?? (p.kind === 'choice' && p.choices?.length ? p.choices[0].key : '')
  }
  return out
}
