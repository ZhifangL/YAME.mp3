import { useState } from 'react'
import { defaultParams } from '../rules'
import { useStore } from '../store-context'
import { PresetManager } from './PresetManager'
import { RuleBuilder } from './RuleBuilder'
import { RuleCard } from './RuleCard'
import { SavePresetModal } from './SavePresetModal'

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
  } = useStore()
  const [manageOpen, setManageOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)

  const enabledCount = ruleset.rules.filter((r) => r.enabled).length
  const applyTarget = selectedPaths.length > 0 ? selectedPaths.length : tracks.length
  const activePreset = presets.find((p) => p.id === activePresetId) ?? null
  const headerLabel = activePreset ? activePreset.name : 'Your ruleset'
  // Rules transform real files and preview against them, so with nothing
  // loaded there is nothing to build a rule against.
  const hasMusic = tracks.length > 0

  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <div className="sidebar-header">
          <span className="kicker" title={activePreset ? 'Loaded from preset' : ''}>
            {headerLabel}
          </span>
          <button className="icon-btn" onClick={() => setDraft(null)} title="Add a rule">
            <PlusIcon />
          </button>
        </div>

        {/* Fixed builder slot — the rules list below never jumps. */}
        <div>
          {draft ? (
            <RuleBuilder />
          ) : (
            <div className="builder">
              <div className="builder-title">
                <span className="kicker">New rule</span>
              </div>
              <div className={'rule-menu' + (hasMusic ? '' : ' disabled')}>
                {(registry?.specs ?? []).map((spec) => (
                  <button
                    key={spec.type}
                    disabled={!hasMusic}
                    onClick={() => setDraft({ ruleId: null, type: spec.type, params: defaultParams(spec.params) })}
                    title={hasMusic ? spec.description : 'Add music first — rules are built against your tracks'}
                  >
                    {spec.label}
                  </button>
                ))}
              </div>
              {!hasMusic && (
                <p className="field-help" style={{ margin: 0, lineHeight: 1.5 }}>
                  Add music to start building rules.
                </p>
              )}
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
            {presets.length > 0 && <option disabled>──────────────</option>}
            <option value="__manage__">Manage rulesets…</option>
          </select>
        </div>

        <div className="rules-list">
          {ruleset.rules.map((rule) => (
            <RuleCard key={rule.id} rule={rule} />
          ))}
          {ruleset.rules.length === 0 && (
            <p className="field-help" style={{ margin: '2px 2px 0', lineHeight: 1.5 }}>
              No rules yet. Add a rule, then click “Apply” to see its changes.
              Rules run top to bottom when you apply them.
            </p>
          )}
        </div>

        <div className="sidebar-actions">
          <button className="apply-btn" onClick={startApply} disabled={enabledCount === 0 || tracks.length === 0}>
            ▶ {applyTarget === tracks.length ? 'Apply to all files' : 'Apply to selected (' + applyTarget + ')'}
          </button>

          <button className="save-preset-btn" onClick={() => setSaveOpen(true)} disabled={ruleset.rules.length === 0}>
            Save as preset
          </button>
        </div>
      </div>
      {manageOpen && <PresetManager onClose={() => setManageOpen(false)} />}
      {saveOpen && <SavePresetModal onClose={() => setSaveOpen(false)} />}
    </aside>
  )
}
