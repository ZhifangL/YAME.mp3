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
  it('undoes the last edit, not the last load', async () => {
    // The reported bug: pressing Cmd+Z after removing a song jumped back to the
    // previous set of loaded songs instead of reversing the removal.
    const { store } = await mount()

    store().removeTracks(['/music/b.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))

    store().undo()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
    // Still the same three files — not an older selection of them.
    expect(store().tracks.map((t) => t.file.path)).toEqual(PATHS)
  })

  it('never unloads the library on undo', async () => {
    // One load, then undo repeatedly: the list must survive every press.
    const { store } = await mount()
    for (let i = 0; i < 5; i++) store().undo()
    expect(screen.getByTestId('count')).toHaveTextContent('3')
  })

  it('a second load moves the baseline, so undo cannot return to the first', async () => {
    const { store } = await mount()
    // Loading again is not an edit: it becomes the new floor.
    store().removeTracks(['/music/a.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))

    await store().appendPaths(['/music/d.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))

    store().undo()
    // Nothing to undo: the load cleared the history rather than adding to it.
    expect(screen.getByTestId('count')).toHaveTextContent('3')
  })

  it('removing several songs is one step, not several', async () => {
    const { store } = await mount()

    store().removeTracks(['/music/a.mp3', '/music/c.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'))

    store().undo()
    // One undo restores both; if each removal were its own step this would
    // leave one track missing.
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
  })

  it('can be redone after an undo', async () => {
    const { store } = await mount()

    store().removeTracks(['/music/b.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
    store().undo()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))

    store().redo()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
  })

  it('a new edit clears the redo branch', async () => {
    const { store } = await mount()

    store().removeTracks(['/music/a.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
    store().undo()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))

    store().removeTracks(['/music/c.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
    store().redo()
    // The redo of the *first* removal is gone; the list stays as it is.
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
  })

  it('with a text field focused, undo leaves the list alone', async () => {
    const { store } = await mount()
    const user = userEvent.setup()

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
    store().undo()
    expect(screen.getByTestId('count')).toHaveTextContent('3')
  })
})
