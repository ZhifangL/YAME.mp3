import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { parseAssignments, previewSummary, specFor } from '../rules'
import { useStore } from '../store-context'
import type { RegistryResponse, RuleParamSpec, Track } from '../types'

const SAMPLE_TRACK = {
  filename: 'Ado - Odo (128kbit_AAC).mp3',
  folder: '/Music/Ado',
  fields: {
    title: 'Odo - Live',
    artist: 'Ado',
    album: 'Kyougen',
    date: '2022',
    comment: 'https://www.youtube.com/watch?v=x',
  },
}

interface PreviewState {
  text: string
  hasChanges: boolean
  error: boolean
}

export function RuleBuilder() {
  const { registry, draft, tracks, selectedPaths, updateDraftType, commitDraft, cancelDraft } = useStore()
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const spec = registry && draft ? specFor(registry, draft.type) : null
  // Preview candidates in order: the selected tracks (in table order), then
  // the first track, then a built-in sample. The engine returns the first
  // candidate the rule actually changes.
  const selectedTracks = tracks.filter((t) => selectedPaths.includes(t.file.path))
  const orderedCandidates: Track[] = [...selectedTracks]
  if (tracks.length) orderedCandidates.push(tracks[0])
  const candidateList = orderedCandidates.length
    ? orderedCandidates
        .filter((t, i, all) => all.findIndex((x) => x.file.path === t.file.path) === i)
        .slice(0, 20)
    : []
  const candidatesJson = JSON.stringify(
    candidateList.map((t) => ({
      filename: t.file.filename,
      folder: dirOf(t.file.path),
      fields: t.fields,
      cover: t.cover,
    })),
  )
  const draftType = draft?.type ?? ''
  const draftParamsJson = JSON.stringify(draft?.params)
  const hasSample = candidateList.length > 0

  useEffect(() => {
    if (!draftType || !spec) return
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      const rule = { id: 'preview', type: draftType, params: JSON.parse(draftParamsJson), enabled: true }
      const run = hasSample
        ? api.previewBatch(JSON.parse(candidatesJson), rule)
        : api.preview(SAMPLE_TRACK.filename, SAMPLE_TRACK.folder, SAMPLE_TRACK.fields, rule)
      run
        .then((res) => {
          setPreview({
            text: formatPreview(res),
            hasChanges: res.changes.length > 0,
            error: false,
          })
        })
        .catch(() => setPreview({ text: 'Preview unavailable — engine offline', hasChanges: false, error: true }))
    }, 350)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [draftType, draftParamsJson, candidatesJson, hasSample, spec])

  if (!registry || !draft || !spec) return null

  const valid = validateDraft(registry, spec.params, draft.params)
  const editing = Boolean(draft.ruleId)

  return (
    <div className="builder">
      <div className="builder-title">
        <span className="kicker">{editing ? 'Edit rule' : 'Rule builder'}</span>
        <select
          className="select rule-select"
          value={draft.type}
          onChange={(e) => updateDraftType(e.target.value)}
        >
          {registry.specs.map((s) => (
            <option key={s.type} value={s.type}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <p className="field-help" style={{ margin: '-4px 0 0' }}>
        {spec.description}
      </p>

      {spec.params
        .filter((param) => !(spec.type === 'PARSE FILENAME' && param.name === 'include_extension'))
        .map((param) => (
          <ParamEditor key={param.name} param={param} />
        ))}

      <div className={'builder-preview' + (preview && !preview.hasChanges ? ' no-changes' : '')}>
        {preview == null ? (
          <span className="muted">Preview…</span>
        ) : preview.error ? (
          <span>{preview.text}</span>
        ) : preview.hasChanges ? (
          <span>
            Preview: <strong>{preview.text}</strong>
          </span>
        ) : (
          <span>No changes</span>
        )}
      </div>

      <div className="builder-actions">
        <button className="text-btn" onClick={cancelDraft}>
          Cancel
        </button>
        <button className="text-btn primary" disabled={!valid} onClick={commitDraft} title={valid ? '' : 'Fill in the highlighted inputs'}>
          {editing ? 'Done' : 'Add to ruleset'}
        </button>
      </div>
    </div>
  )
}

function formatPreview(res: { changes: { field: string; before: string; after: string }[]; filename: string }): string {
  const cover = res.changes.find((c) => c.field === '__cover__')
  if (cover) {
    return cover.after === 'remove' ? 'Cover art: remove existing artwork' : 'Cover art: ' + cover.after
  }
  return previewSummary(
    res.changes.map((c) => ({ ...c, label: c.field, rule_type: null, rule_label: null })),
    res.filename,
  )
}

function validateDraft(registry: RegistryResponse, params: RuleParamSpec[], values: Record<string, unknown>): boolean {
  for (const p of params) {
    const v = values[p.name]
    switch (p.kind) {
      case 'field': {
        if (typeof v !== 'string' || !registry.fields.some((f) => f.key === v)) return false
        break
      }
      case 'text':
      case 'choice': {
        // empty text is allowed (e.g. REPLACE with '') but undefined is not
        if (v == null) return false
        break
      }
      case 'parse_pattern': {
        if (typeof v !== 'string' || !v.trim()) return false
        break
      }
      case 'image': {
        // An image is always required for Set Cover Art.
        if (!(v && typeof v === 'object' && (v as { data_base64?: string }).data_base64)) return false
        break
      }
      default:
        break
    }
  }
  return true
}

function ParamEditor({ param }: { param: RuleParamSpec }) {
  const { registry, draft, updateDraftParam } = useStore()
  if (!registry || !draft) return null
  const value = draft.params[param.name]

  if (param.kind === 'field') {
    return (
      <div className="field-row">
        <span className="field-label">{param.label}</span>
        <select
          className="select"
          value={String(value ?? '')}
          onChange={(e) => updateDraftParam(param.name, e.target.value)}
        >
          {registry.fields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
    )
  }

  if (param.kind === 'text' || param.kind === 'separator') {
    return (
      <div className="field-row">
        <span className="field-label">{param.label}</span>
        <input
          className="input"
          type="text"
          placeholder={param.placeholder ?? ''}
          value={String(value ?? '')}
          onChange={(e) => updateDraftParam(param.name, e.target.value)}
          spellCheck={false}
        />
        {param.help && <span className="field-help">{param.help}</span>}
      </div>
    )
  }

  if (param.kind === 'choice') {
    return (
      <div className="field-row">
        <span className="field-label">{param.label}</span>
        <select
          className="select"
          value={String(value ?? '')}
          onChange={(e) => updateDraftParam(param.name, e.target.value)}
        >
          {param.choices.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
    )
  }

  if (param.kind === 'bool') {
    return (
      <label className="check-row">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => updateDraftParam(param.name, e.target.checked)}
        />
        {param.label}
      </label>
    )
  }

  if (param.kind === 'image') {
    return <ImageParamEditor value={value as { mime?: string; data_base64?: string } | null} />
  }

  if (param.kind === 'parse_pattern') {
    return <ParsePatternEditor pattern={String(value ?? '')} />
  }

  return null
}

function ImageParamEditor({ value }: { value: { mime?: string; data_base64?: string } | null }) {
  const { updateDraftParam } = useStore()
  const fileInput = useRef<HTMLInputElement>(null)
  const hasImage = Boolean(value && value.data_base64)

  const onPick = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) return
    const dataUrl = await readAsDataUrl(file)
    const mime = dataUrl.slice(5, dataUrl.indexOf(';'))
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    updateDraftParam('image', { mime, data_base64: b64, name: file.name })
  }

  return (
    <div className="field-row">
      <span className="field-label">Cover image</span>
      <div className="image-pick-row">
        {hasImage ? (
          <img
            className="image-pick-thumb"
            src={'data:' + (value!.mime || 'image/png') + ';base64,' + value!.data_base64}
            alt="Chosen cover"
          />
        ) : (
          <span className="image-pick-empty">No image chosen</span>
        )}
        <button className="text-btn" onClick={() => fileInput.current?.click()}>
          Choose image…
        </button>
        {hasImage && (
          <button className="text-btn" onClick={() => updateDraftParam('image', null)}>
            Clear
          </button>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onPick(file)
          e.target.value = ''
        }}
      />
      {/*<span className="field-help">Embed this image in every file the ruleset is applied to.</span>*/}
    </div>
  )
}

function ParsePatternEditor({ pattern }: { pattern: string }) {
  const { registry, draft, updateDraftParam } = useStore()
  const assignments = useMemo(
    () => (registry && draft ? parseAssignments(draft.params, pattern) : []),
    [registry, draft, pattern],
  )
  if (!registry || !draft) return null
  const includeExtension = Boolean(draft.params.include_extension)

  return (
    <div className="field-row">
      <span className="field-label">Pattern</span>
      <input
        className="input"
        type="text"
        placeholder="Artist - Title"
        value={pattern}
        onChange={(e) => updateDraftParam('pattern', e.target.value)}
        spellCheck={false}
      />
      <span className="field-help" style={{ paddingBottom: '8px' }}>
        Each * captures a chunk - assign chunks to fields below
      </span>
      {assignments.map((a) => (
        <div key={a.index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="field-label" style={{ width: 72, flex: 'none' }}>
            Capture {a.index}
          </span>
            <select
                className="select"
                style={{
                    flex: 1,
                    color: !a.field ? '#888888' : 'inherit',
                    fontStyle: !a.field ? 'italic' : 'normal',
                }}
                value={a.field}
                onChange={(e) => {
                    const next = { ...(draft.params.assignments as Record<string, string>) }
                    if (e.target.value) next[String(a.index)] = e.target.value
                    else delete next[String(a.index)]
                    updateDraftParam('assignments', next)
                }}
            >
                <option value="" style={{ fontStyle: 'italic', color: '#888888' }}>
                    (skip)
                </option>
                {registry.fields.map((f) => (
                    <option key={f.key} value={f.key} style={{ fontStyle: 'normal', color: 'initial' }}>
                        {f.label}
                    </option>
                ))}
            </select>
        </div>
      ))}
      {assignments.length === 0 && <span className="field-help">Add a * or ? to the pattern to create captures.</span>}
      <label className="check-row">
        <input
          type="checkbox"
          checked={includeExtension}
          onChange={(e) => updateDraftParam('include_extension', e.target.checked)}
        />
        Include file extension in the match
      </label>
    </div>
  )
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
