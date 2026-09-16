// Integration test for the delete flow.
//
// This is the bug the confirm dialog exists to fix: deletion used to be guarded
// by `window.confirm`, which a Tauri webview may answer with false without ever
// drawing anything — so "Delete selected" silently did nothing. The store,
// PresetManager and the real dialog are wired together here, so the guard is
// exercised end to end rather than in isolation.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import { PresetManager } from './PresetManager'
import { REGISTRY_FIXTURE, stubApi } from '../test/api-stub'
import { StoreProvider } from '../store'
import { useStore } from '../store-context'
import type { Preset } from '../types'

const PRESETS: Preset[] = [
  {
    id: 'p1',
    name: 'Podcast cleanup',
    ruleset: { name: 'Podcast cleanup', rules: [{ id: 'r1', type: 'WRITE', params: {}, enabled: true }] },
    updated_unix: 1_700_000_000,
  },
]

/**
 * Loads the store the way App does. `init()` belongs to the app shell rather
 * than the provider, so a test that mounts the provider alone would sit on an
 * empty preset list and prove nothing.
 */
function Bootstrap({ children }: { children: React.ReactNode }) {
  const { init } = useStore()
  useEffect(() => {
    init()
  }, [init])
  return <>{children}</>
}

function renderManager() {
  const api = stubApi({
    '/api/rules/registry': REGISTRY_FIXTURE,
    '/api/presets': PRESETS,
    '/api/health': { status: 'ok', version: '1.0.0', config_dir: '/tmp/yame' },
  })
  const user = userEvent.setup()
  render(
    <StoreProvider>
      <Bootstrap>
        <PresetManager onClose={() => {}} />
      </Bootstrap>
    </StoreProvider>,
  )
  return { api, user }
}

/** Wait for the provider's async startup to populate the preset list. */
async function selectThePreset(user: ReturnType<typeof userEvent.setup>) {
  const checkbox = await screen.findByRole('checkbox')
  await user.click(checkbox)
  return checkbox
}

describe('deleting a ruleset', () => {
  it('asks before deleting, and deletes when confirmed', async () => {
    const { api, user } = renderManager()
    await selectThePreset(user)

    await user.click(screen.getByRole('button', { name: 'Delete selected' }))

    // The app's own dialog, not window.confirm.
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/Delete 1 ruleset\?/)).toBeInTheDocument()
    // Nothing has been deleted yet — the guard runs before the request.
    expect(api.callsTo('/api/presets').filter((c) => c.method === 'DELETE')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(api.callsTo('/api/presets/p1').filter((c) => c.method === 'DELETE')).toHaveLength(1)
    })
  })

  it('deletes nothing when the dialog is cancelled', async () => {
    const { api, user } = renderManager()
    await selectThePreset(user)

    await user.click(screen.getByRole('button', { name: 'Delete selected' }))
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
    // The list is untouched, so the user can try again.
    expect(screen.getByText('Podcast cleanup')).toBeInTheDocument()
  })

  it('deletes nothing when the dialog is dismissed with Escape', async () => {
    const { api, user } = renderManager()
    await selectThePreset(user)

    await user.click(screen.getByRole('button', { name: 'Delete selected' }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
  })

  it('words the prompt for the number of rulesets selected', async () => {
    const { user } = renderManager()
    await selectThePreset(user)
    await user.click(screen.getByRole('button', { name: 'Delete selected' }))
    expect(await screen.findByText(/Delete 1 ruleset\?/)).toBeInTheDocument()
    expect(screen.getByText(/Files it already changed are not affected/)).toBeInTheDocument()
  })
})
