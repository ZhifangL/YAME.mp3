// The undo/redo diagnostics.
//
// Small, but load-bearing: it is how a misbehaviour gets reported, and it has to
// show the one thing a description cannot — whether the action was delivered
// once or twice for a single press.
import { describe, expect, it, vi } from 'vitest'
import { diagnosticsText, noteDiag } from './diagnostics'

describe('undo/redo diagnostics', () => {
  it('says so plainly when nothing has happened', async () => {
    // A fresh module, because the log is module-level and the tests below add to
    // it — asserting on a shared log would pass for the wrong reason.
    vi.resetModules()
    const fresh = await import('./diagnostics')
    expect(fresh.diagnosticsText()).toBe('No undo/redo activity recorded yet.')
  })

  it('shows a duplicated delivery as two entries, which is the whole point', () => {
    // One press delivered by both the menu accelerator and the page handler.
    noteDiag({
      at: 1000,
      action: 'undo',
      via: 'menu',
      typing: false,
      settling: false,
      past: 1,
      future: 0,
      tracks: 3,
    })
    noteDiag({
      at: 1000,
      action: 'undo',
      via: 'key',
      typing: false,
      settling: false,
      past: 0,
      future: 1,
      tracks: 3,
    })

    const lines = diagnosticsText().split('\n')
    // Both deliveries are visible, distinguished by their source.
    expect(lines.some((l) => l.includes('undo via=menu'))).toBe(true)
    expect(lines.some((l) => l.includes('undo via=key'))).toBe(true)
  })

  it('records the state each delivery saw, so a skip can be told from a no-op', () => {
    noteDiag({
      at: 2000,
      action: 'redo',
      via: 'key',
      typing: true,
      settling: true,
      past: 2,
      future: 5,
      tracks: 7,
    })
    const line = diagnosticsText().split('\n').find((l) => l.includes('at=2000'))
    expect(line).toBeDefined()
    // The four facts that distinguish the possible causes.
    expect(line).toContain('typing=true')
    expect(line).toContain('settling=true')
    expect(line).toContain('past=2')
    expect(line).toContain('future=5')
  })

  it('never leaves a field undefined, whatever the entry', () => {
    noteDiag({
      at: 3000,
      action: 'undo',
      via: 'key',
      typing: false,
      settling: false,
      past: 0,
      future: 0,
      tracks: 0,
    })
    expect(diagnosticsText()).not.toMatch(/undefined|NaN/)
  })
})
