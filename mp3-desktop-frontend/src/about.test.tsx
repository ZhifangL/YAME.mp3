// The About box, reached from Help in the title bar and Help ▸ About.
//
// Small, but it is what a user opens when something is wrong, so the version
// has to be right even when the engine is not answering — see the fallback in
// the store.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REGISTRY_FIXTURE, stubApi } from './test/api-stub'
import { StoreProvider } from './store'
import { useStore } from './store-context'

function Harness() {
  const { showAbout, init } = useStore()
  useEffect(() => {
    init()
  }, [init])
  return <button onClick={showAbout}>help</button>
}

describe('the About box', () => {
  it('shows the name, version and licence, one per line', async () => {
    stubApi({
      '/api/rules/registry': REGISTRY_FIXTURE,
      '/api/presets': [],
      '/api/health': { status: 'ok', version: '1.1.0', config_dir: '/tmp/yame' },
    })
    const user = userEvent.setup()
    render(
      <StoreProvider>
        <Harness />
      </StoreProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'help' }))
    const dialog = await screen.findByRole('dialog')

    // One paragraph whose *text* carries the newlines. CSS `pre-line` is what
    // turns them into lines; without it HTML collapses them and the three facts
    // run together, which is how this read before.
    const message = dialog.querySelector('.confirm-message')
    expect(message?.textContent).toBe(
      'YAME (Yet Another Metadata Editor)\nVersion 1.1.0\nGNU GPL v3.0 or later',
    )
  })

  it('offers a single button, since there is nothing to cancel', async () => {
    stubApi({
      '/api/rules/registry': REGISTRY_FIXTURE,
      '/api/presets': [],
      '/api/health': { status: 'ok', version: '1.1.0', config_dir: '/tmp/yame' },
    })
    const user = userEvent.setup()
    render(
      <StoreProvider>
        <Harness />
      </StoreProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'help' }))
    await screen.findByRole('dialog')
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(2)) // help + Close
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })
})

describe('the About box text is actually laid out on separate lines', () => {
  it('the dialog preserves newlines', () => {
    // The content above carries "\n", but HTML collapses those into spaces
    // unless CSS says otherwise — which is exactly why the first version read
    // as one run-on line. jsdom does not apply stylesheets, so the rule that
    // makes it work is asserted directly.
    // `import.meta.url` is rewritten by Vite, so resolve from the project root
    // instead — vitest runs with the frontend package as its cwd.
    const raw = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf8')
    // Comments removed first: they contain braces and backslash-n, and would
    // otherwise run the match past the rule it is looking for.
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = /\.confirm-message\s*\{[^}]*white-space:\s*pre-line/.test(css)
    expect(rule).toBe(true)
  })
})
