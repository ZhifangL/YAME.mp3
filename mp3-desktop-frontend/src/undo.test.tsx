// Undo/redo across the two histories.
//
// The rule the user asked for: with a text field focused, the shortcut belongs
// to that field; otherwise it belongs to the track list. Before this, every
// Ctrl+Z went to the search box (which autofocuses), so the list could not be
// undone at all.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import { REGISTRY_FIXTURE, stubApi, trackFixture } from './test/api-stub'
import { StoreProvider } from './store'
import { useStore } from './store-context'

const PATHS = ['/music/a.mp3', '/music/b.mp3', '/music/c.mp3']

/** Renders the store and exposes it, loading three tracks as App does. */
function Harness({ onReady }: { onReady: (store: ReturnType<typeof useStore>) => void }) {
  const store = useStore()
  useEffect(() => {
    onReady(store)
  })
  useEffect(() => {
    void store.importPaths(PATHS, 'replace')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div>
      <input aria-label="a text field" />
      <span data-testid="count">{store.tracks.length}</span>
    </div>
  )
}

async function mount() {
  const api = stubApi({
    '/api/rules/registry': REGISTRY_FIXTURE,
    '/api/presets': [],
    '/api/health': { status: 'ok', version: '1.0.0', config_dir: '/tmp/yame' },
    '/api/tracks/read': { tracks: PATHS.map((p) => trackFixture(p)), errors: [] },
    '/api/paths/expand': { files: PATHS, skipped: [], truncated: false },
  })
  let store: ReturnType<typeof useStore> | null = null
  render(
    <StoreProvider>
      <Harness onReady={(s) => (store = s)} />
    </StoreProvider>,
  )
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
  return { api, store: () => store! }
}

describe('undo and redo of the track list', () => {
  it('removing songs can be undone and redone', async () => {
    const { store } = await mount()

    store().removeTracks(['/music/b.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))

    // Focus something that is not a text field, or the keystroke would be
    // routed to the field's own history.
    ;(document.activeElement as HTMLElement | null)?.blur()
    store().undo()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))

    store().redo()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
  })

  it('removing several songs is one step, not several', async () => {
    const { store } = await mount()

    store().removeTracks(['/music/a.mp3', '/music/c.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'))

    ;(document.activeElement as HTMLElement | null)?.blur()
    store().undo()
    // One undo restores both; if each removal were its own step this would
    // leave one track missing.
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
  })

  it('a new edit clears the redo branch', async () => {
    const { store } = await mount()

    store().removeTracks(['/music/a.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
    ;(document.activeElement as HTMLElement | null)?.blur()
    store().undo()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))

    // A fresh removal after an undo must not leave the old redo reachable.
    store().removeTracks(['/music/c.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
    store().redo()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
  })

  it('with a text field focused, undo leaves the list alone', async () => {
    const { user, store } = { user: userEvent.setup(), ...(await mount()) }

    store().removeTracks(['/music/a.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))

    // The search box and every other field goes through here.
    await user.click(screen.getByLabelText('a text field'))
    store().undo()

    // Still two: that keystroke belonged to the field, not the list.
    expect(screen.getByTestId('count')).toHaveTextContent('2')
  })

  it('undoing with nothing to undo does nothing', async () => {
    const { store } = await mount()
    ;(document.activeElement as HTMLElement | null)?.blur()
    store().undo()
    expect(screen.getByTestId('count')).toHaveTextContent('3')
  })
})
