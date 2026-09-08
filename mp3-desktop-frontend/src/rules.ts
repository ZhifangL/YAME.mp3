// Client-side rule helpers: defaults, human summaries, preview text.
// The engine (Python) is authoritative for results; these helpers only
// describe and format for display.
import type { ChangeRecord, RegistryResponse, RuleInstance, RuleParamSpec } from './types'

export function defaultParams(specParams: RuleParamSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of specParams) {
    if (p.kind === 'parse_pattern') {
      out[p.name] = '* - *'
      continue
    }
    if (p.kind === 'parse_assignments') {
      out[p.name] = {}
      continue
    }
    if (p.kind === 'bool') {
      out[p.name] = p.default ?? true
      continue
    }
    out[p.name] = p.default ?? (p.kind === 'choice' && p.choices.length ? p.choices[0].key : '')
  }
  return out
}

export function fieldLabel(registry: RegistryResponse, key: string): string {
  const f = registry.fields.find((f) => f.key === key)
  return f ? f.label : key
}

export function specFor(registry: RegistryResponse, type: string) {
  return registry.specs.find((s) => s.type === type)
}

export function describeRule(registry: RegistryResponse, rule: RuleInstance): string {
  const spec = specFor(registry, rule.type)
  if (!spec) return rule.type
  const p = rule.params
  switch (rule.type) {
    case 'CLEAR':
      return 'Clear ' + fieldLabel(registry, str(p.field))
    case 'REPLACE':
      return 'Replace "' + str(p.find) + '" with "' + str(p.replace) + '" in ' + fieldLabel(registry, str(p.field))
    case 'WRITE':
      return 'Write "' + str(p.value) + '" to ' + fieldLabel(registry, str(p.field))
    case 'APPEND':
      return 'Append "' + str(p.value) + '" to ' + fieldLabel(registry, str(p.field))
    case 'COPY FROM':
      return 'Copy ' + fieldLabel(registry, str(p.source)) + ' \u2192 ' + fieldLabel(registry, str(p.field))
    case 'PARSE FILENAME':
      return 'Parse file name with "' + str(p.pattern) + '"'
    case 'SET COVER': {
      const image = p.image as { mime?: string; data_base64?: string } | null | undefined
      if (image && image.data_base64) {
        const ext = String(image.mime || 'image').split('/').pop() || 'image'
        return 'Set cover art (' + ext + ')'
      }
      return 'Remove cover art'
    }
    case 'CHANGE CASE': {
      const mode = String(p.mode ?? 'title')
      const choice = spec.params
        .find((sp) => sp.name === 'mode')
        ?.choices.find((c) => c.key === mode)
      return 'Change ' + fieldLabel(registry, str(p.field)) + ' to ' + (choice ? choice.label : mode)
    }
    default:
      return spec.label
  }
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

export function previewLine(change: ChangeRecord): string {
  return '"' + change.before + '" \u2192 "' + change.after + '"'
}

export function previewSummary(changes: ChangeRecord[], filename: string): string {
  if (!changes.length) return 'No change for ' + filename
  const parts = changes.map((c) => c.label + ': ' + previewLine(c))
  return parts.join('  \u00b7  ')
}

export function countCaptures(pattern: string): number {
  let n = 0
  for (const ch of pattern) {
    if (ch === '*' || ch === '?') n++
  }
  return n
}

export function parseAssignments(
  params: Record<string, unknown>,
  pattern: string,
): { index: number; field: string }[] {
  const existing = (params.assignments as Record<string, string>) ?? {}
  const n = countCaptures(pattern)
  const out: { index: number; field: string }[] = []
  for (let i = 1; i <= n; i++) {
    out.push({ index: i, field: existing[String(i)] ?? '' })
  }
  return out
}
