// Undo/redo across the two histories.
//
// The rule the user asked for: with a text field focused, the shortcut belongs
// to that field; otherwise it belongs to the track list. Before this, every
// Ctrl+Z went to the search box (which autofocuses), so the list could not be
// undone at all.
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import { REGISTRY_FIXTURE, stubApi, trackFixture } from './test/api-stub'
import { StoreProvider } from './store'
import { useStore } from './store-context'

const PATHS = ['/music/a.mp3', '/music/b.mp3', '/music/c.mp3']

/**
 * Perform a store action and let React commit it.
 *
 * A user's actions are always separated by a commit — the state a handler reads
 * is the state the previous render produced. Calling two actions in one
 * synchronous block skips that, which is a test artefact rather than a
 * scenario, so every action here goes through this.
 */
async function act_(run: () => unknown) {
  await act(async () => {
    await run()
  })
  // One more turn: the store mirrors its list in an effect, so an action issued
  // in the same tick as the previous one can read the list from before it. A
  // real user's actions are separated by a commit; this is the test equivalent.
  await act(async () => {})
}


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
      {/* So a test can read what the user would be told. */}
      <span data-testid="toast">{store.toast?.text ?? ''}</span>
    </div>
  )
}

const failWrites = { value: false }

async function mount() {
  failWrites.value = false
  const api = stubApi({
    '/api/rules/registry': REGISTRY_FIXTURE,
    '/api/presets': [],
    '/api/health': { status: 'ok', version: '1.0.0', config_dir: '/tmp/yame' },
    // Honours the requested paths: appending a file must return *that* file,
    // or the appended row would duplicate one already in the list.
    '/api/tracks/read': ((body: unknown) => {
      const asked = (body as { paths?: string[] } | undefined)?.paths ?? []
      return { tracks: asked.map((path) => trackFixture(path)), errors: [] }
    }) as never,
    // Flattens what it is given, as the engine does.
    '/api/paths/expand': ((body: unknown) => {
      const asked = (body as { paths?: string[] } | undefined)?.paths ?? []
      return { files: asked, skipped: [], truncated: false }
    }) as never,
    // A write returns the track as it now is, which is what the row shows — and
    // is how the engine answers a real save. `failWrites` lets a test make the
    // *next* write fail, as a read-only or moved file would.
    '/api/tracks/write': ((body: unknown) => {
      if (failWrites.value) {
        return { status: 422, body: { detail: 'Permission denied' } }
      }
      const { path, fields } = (body ?? {}) as { path?: string; fields?: Record<string, string> }
      const track = trackFixture(path ?? '')
      return { track: { ...track, fields: { ...track.fields, ...(fields ?? {}) } }, warnings: [] }
    }) as never,
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
    // The reported bug: Cmd+Z after removing a song jumped to the previous set
    // of loaded songs instead of reversing the removal.
    const { store } = await mount()

    await act_(() => store().removeTracks(['/music/b.mp3']))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))

    await act_(() => store().undo())
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
    expect(store().tracks.map((t) => t.file.path)).toEqual(PATHS)
  })

  it('never unloads the first batch, however many times undo is pressed', async () => {
    // The first load is the floor: undo returns to it and stops there.
    const { store } = await mount()
    for (let i = 0; i < 5; i++) store().undo()
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
    expect(store().tracks.map((t) => t.file.path)).toEqual(PATHS)
  })

  it('undoes a load back to the previous set of songs, and then stops', async () => {
    const { store } = await mount()
    await store().appendPaths(['/music/d.mp3'])
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('4'))

    await act_(() => store().undo())
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
    expect(store().tracks.map((t) => t.file.path)).toEqual(PATHS)

    // Nothing left to take back, and the batch is still there.
    await act_(() => store().undo())
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
  })

  it('removing several songs is one step, not several', async () => {
    const { store } = await mount()

    await act_(() => store().removeTracks(['/music/a.mp3', '/music/c.mp3']))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'))

    await act_(() => store().undo())
    // One undo restores both; if each removal were its own step this would
    // leave one track missing.
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
  })

  it('can be redone after an undo', async () => {
    const { store } = await mount()

    await act_(() => store().removeTracks(['/music/b.mp3']))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
    await act_(() => store().undo())
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))

    await act_(() => store().redo())
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
  })

  it('a new action clears the redo branch', async () => {
    const { store } = await mount()

    await act_(() => store().removeTracks(['/music/a.mp3']))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
    await act_(() => store().undo())
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))

    await act_(() => store().removeTracks(['/music/c.mp3']))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
    await act_(() => store().redo())
    // The redo of the *first* removal is gone; the list stays as it is.
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
  })

  it('with a text field focused, undo leaves the list alone', async () => {
    const { store } = await mount()
    const user = userEvent.setup()

    await act_(() => store().removeTracks(['/music/a.mp3']))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))

    // The search box and every other field goes through here.
    await user.click(screen.getByLabelText('a text field'))
    await act_(() => store().undo())

    // Still two: that keystroke belonged to the field, not the list.
    expect(screen.getByTestId('count')).toHaveTextContent('2')
  })

  it('undoing with nothing to undo does nothing', async () => {
    const { store } = await mount()
    await act_(() => store().undo())
    expect(screen.getByTestId('count')).toHaveTextContent('3')
  })

  it('undo restores the previous selection as well as the list', async () => {
    const { store } = await mount()

    await act_(() => store().setSelection(['/music/b.mp3']))
    // Awaited render between the two: the mirrors update on commit, and a real
    // user's selection and their keystroke are separate events. Calling both in
    // one tick would be a test artefact, not a scenario.
    await waitFor(() => expect(store().selectedPaths).toEqual(['/music/b.mp3']))

    await act_(() => store().removeTracks(['/music/b.mp3']))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))

    await act_(() => store().undo())
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
    expect(store().selectedPaths).toEqual(['/music/b.mp3'])
  })
  it('one press does one step, after a load and after an edit', async () => {
    // The reported bug: undoing a load sometimes needed two presses. It
    // happened when a step was recorded that matched the current list, so the
    // first press swapped like for like and looked like nothing happened.
    const { store } = await mount()
    await act_(() => store().removeTracks(['/music/b.mp3']))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))

    await act_(() => store().appendPaths(['/music/d.mp3']))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))

    // Two actions, so two steps: each press must move exactly one.
    await act_(() => store().undo())
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
    await act_(() => store().undo())
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))

    // Back at the first batch, which is the floor.
    await act_(() => store().undo())
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))
  })

  it('undoes a single-track metadata edit', async () => {
    // The reported bug: editing a song's metadata could not be undone, while
    // load/remove undos worked. The history compared rows by *path*, and an
    // edit is precisely the change that leaves the path alone — so the edit
    // looked like "no change" and was discarded as a duplicate step.
    const { store } = await mount()

    await act_(() => store().writeFields('/music/b.mp3', { title: 'Edited' }))
    await waitFor(() =>
      expect(store().tracks.find((t) => t.file.path === '/music/b.mp3')?.fields.title).toBe('Edited'),
    )

    await act_(() => store().undo())
    await waitFor(() =>
      expect(store().tracks.find((t) => t.file.path === '/music/b.mp3')?.fields.title).not.toBe('Edited'),
    )

    // And redo puts the edit back.
    await act_(() => store().redo())
    await waitFor(() =>
      expect(store().tracks.find((t) => t.file.path === '/music/b.mp3')?.fields.title).toBe('Edited'),
    )
  })

  it('keeps an edit distinct from the state before it, across reloads', async () => {
    // The second reported bug: after A → B → A(edited), undoing back through
    // the loads showed A *unedited* in the oldest step and edited in the newer
    // one. That is what the path-only comparison produced — the edited and
    // unedited lists were indistinguishable, so the history collapsed them.
    const { store } = await mount()
    const first = PATHS

    await act_(() => store().importPaths(['/music/x.mp3'], 'replace'))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'))
    await act_(() => store().importPaths(first, 'replace'))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'))

    await act_(() => store().writeFields('/music/b.mp3', { title: 'Edited' }))
    await waitFor(() =>
      expect(store().tracks.find((t) => t.file.path === '/music/b.mp3')?.fields.title).toBe('Edited'),
    )

    // Undo the edit, then the last load: the list from the *first* load must be
    // the unedited one, and the edit must be reachable again by redo.
    await act_(() => store().undo())
    await waitFor(() =>
      expect(store().tracks.find((t) => t.file.path === '/music/b.mp3')?.fields.title).not.toBe('Edited'),
    )
    await act_(() => store().redo())
    await waitFor(() =>
      expect(store().tracks.find((t) => t.file.path === '/music/b.mp3')?.fields.title).toBe('Edited'),
    )
  })
  it('writes the undone values back to the file', async () => {
    // The reported bug: undo repainted the row but left the edit on disk, so
    // the displayed values and the file disagreed. Undo has to *undo*.
    const { api, store } = await mount()

    await act_(() => store().writeFields('/music/b.mp3', { title: 'Edited' }))
    await waitFor(() =>
      expect(store().tracks.find((t) => t.file.path === '/music/b.mp3')?.fields.title).toBe('Edited'),
    )
    const writesAfterEdit = api.callsTo('/api/tracks/write').length

    await act_(() => store().undo())
    await waitFor(() =>
      expect(store().tracks.find((t) => t.file.path === '/music/b.mp3')?.fields.title).not.toBe('Edited'),
    )

    // A second write reached the engine, carrying the earlier value.
    await waitFor(() => expect(api.callsTo('/api/tracks/write').length).toBe(writesAfterEdit + 1))
    const undoWrite = api.callsTo('/api/tracks/write')[writesAfterEdit]
    expect((undoWrite.body as { path: string }).path).toBe('/music/b.mp3')
    expect((undoWrite.body as { fields: Record<string, string> }).fields.title).not.toBe('Edited')
  })

  it('does not rewrite fields the edit never touched', async () => {
    // The diff is the whole reason undo does not clobber the other 24 fields.
    const { api, store } = await mount()

    await act_(() => store().writeFields('/music/b.mp3', { title: 'Edited' }))
    await waitFor(() =>
      expect(store().tracks.find((t) => t.file.path === '/music/b.mp3')?.fields.title).toBe('Edited'),
    )
    const before = api.callsTo('/api/tracks/write').length

    await act_(() => store().undo())
    await waitFor(() => expect(api.callsTo('/api/tracks/write').length).toBe(before + 1))

    const sent = (api.callsTo('/api/tracks/write')[before].body as { fields: Record<string, string> }).fields
    expect(Object.keys(sent)).toEqual(['title'])
  })
})

describe('a write that fails while undoing', () => {
  it('reports it, because the row would otherwise look reverted', async () => {
    // The row reverts whether or not the file write lands, so a failure is the
    // one outcome the user cannot see for themselves.
    const { store } = await mount()

    await act_(() => store().writeFields('/music/b.mp3', { title: 'Edited' }))
    await waitFor(() =>
      expect(store().tracks.find((t) => t.file.path === '/music/b.mp3')?.fields.title).toBe('Edited'),
    )

    failWrites.value = true
    await act_(() => store().undo())
    await act_(() => {})

    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent(/could not be written/i))
    expect(screen.getByTestId('toast')).toHaveTextContent(/Permission denied/)
    // And it is an error, not a passing note.
    expect(store().toast?.kind).toBe('error')
  })

  it('says nothing about failure when the write succeeds', async () => {
    const { store } = await mount()
    await act_(() => store().writeFields('/music/b.mp3', { title: 'Edited' }))
    await waitFor(() =>
      expect(store().tracks.find((t) => t.file.path === '/music/b.mp3')?.fields.title).toBe('Edited'),
    )

    await act_(() => store().undo())
    await act_(() => {})
    // Other toasts come and go; what must not appear is a failure warning.
    expect(screen.getByTestId('toast')).not.toHaveTextContent(/could not be written/i)
  })
})
