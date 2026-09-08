import { useState } from 'react'
import { describeRule } from '../rules'
import { useStore } from '../store-context'
import type { RuleInstance } from '../types'

export function RuleCard({ rule }: { rule: RuleInstance }) {
  const { registry, draft, setDraft, removeRule, toggleRule, reorderRules } = useStore()
  const [dragOver, setDragOver] = useState(false)
  if (!registry) return null
  const editing = draft?.ruleId === rule.id
  const summary = describeRule(registry, rule)

  return (
    <div
      className={'rule-card' + (editing ? ' editing' : '') + (rule.enabled ? '' : ' disabled') + (dragOver ? ' drag-over' : '')}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', rule.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const dragId = e.dataTransfer.getData('text/plain')
        if (dragId) reorderRules(dragId, rule.id)
      }}
      onClick={() => {
        if (!editing) setDraft({ ruleId: rule.id, type: rule.type, params: { ...rule.params } })
      }}
      title={editing ? 'Editing — change the inputs in the rule builder above' : 'Drag to reorder · click to edit'}
    >
      <button
        className={'toggle' + (rule.enabled ? ' on' : '')}
        onClick={(e) => {
          e.stopPropagation()
          toggleRule(rule.id)
        }}
        title={rule.enabled ? 'Rule on — click to skip this rule' : 'Rule off — click to enable'}
      >
        <span className="knob" />
      </button>
      <span className="rule-card-text">{summary}</span>
      <button
        className="rule-x"
        onClick={(e) => {
          e.stopPropagation()
          removeRule(rule.id)
        }}
        title="Remove rule"
      >
        ✕
      </button>
    </div>
  )
}
