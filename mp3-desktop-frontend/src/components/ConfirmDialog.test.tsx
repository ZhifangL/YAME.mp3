// The in-app confirmation dialog.
//
// This replaces `window.confirm`, which is unreliable inside a Tauri webview
// and looks like a browser artefact on Windows. These tests pin the behaviour
// the call sites depend on: a real boolean, dismissal wired to every escape
// route, and exactly one resolution per dialog.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

describe('ConfirmDialog', () => {
  it('renders nothing until a confirmation is requested', () => {
    render(<ConfirmDialog state={null} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the request as a modal dialog with both choices', () => {
    render(
      <ConfirmDialog
        state={{
          title: 'Delete ruleset?',
          message: 'This cannot be undone.',
          confirmLabel: 'Delete',
          danger: true,
          resolve: vi.fn(),
        }}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText('Delete ruleset?')).toBeInTheDocument()
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('resolves true when the confirm button is pressed', async () => {
    const resolve = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <ConfirmDialog
        state={{ title: 'Delete ruleset?', confirmLabel: 'Delete', resolve }}
        onClose={onClose}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(resolve).toHaveBeenCalledWith(true)
    expect(onClose).toHaveBeenCalled()
  })

  it('resolves false when cancelled', async () => {
    const resolve = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ConfirmDialog state={{ title: 'Sure?', resolve }} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(resolve).toHaveBeenCalledWith(false)
    expect(onClose).toHaveBeenCalled()
  })

  it('has no close button: a message box offers the two real choices only', () => {
    render(<ConfirmDialog state={{ title: 'Sure?', resolve: vi.fn() }} onClose={() => {}} />)
    // Cancel and the confirming action are the only buttons; a ✕ next to them
    // would be a third route to the same answer.
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('resolves false when Escape is pressed', async () => {
    const resolve = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ConfirmDialog state={{ title: 'Sure?', resolve }} onClose={onClose} />)
    await user.keyboard('{Escape}')
    expect(resolve).toHaveBeenCalledWith(false)
    expect(onClose).toHaveBeenCalled()
  })

  it('resolves false when the backdrop is clicked, but not the panel', async () => {
    const resolve = vi.fn()
    const user = userEvent.setup()
    const { container } = render(
      <ConfirmDialog state={{ title: 'Sure?', message: 'Think twice.', resolve }} onClose={() => {}} />,
    )
    // A click inside the panel must not dismiss.
    await user.click(screen.getByText('Think twice.'))
    expect(resolve).not.toHaveBeenCalled()

    await user.click(container.querySelector('.overlay-backdrop') as HTMLElement)
    expect(resolve).toHaveBeenCalledWith(false)
  })

  it('focuses the confirm button so Enter commits straight away', async () => {
    render(
      <ConfirmDialog
        state={{ title: 'Sure?', confirmLabel: 'Delete', resolve: vi.fn() }}
        onClose={() => {}}
      />,
    )
    // Focus is applied on the next frame so the dialog never scrolls the page
    // underneath it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus())
  })

  it('commits on Enter, because the confirm button has focus', async () => {
    const resolve = vi.fn()
    const user = userEvent.setup()
    render(
      <ConfirmDialog
        state={{ title: 'Sure?', confirmLabel: 'Delete', resolve }}
        onClose={() => {}}
      />,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus())
    await user.keyboard('{Enter}')
    expect(resolve).toHaveBeenCalledWith(true)
  })

  it('only ever resolves once, even if a second escape route is taken', async () => {
    const resolve = vi.fn()
    const user = userEvent.setup()
    render(<ConfirmDialog state={{ title: 'Sure?', resolve }} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.keyboard('{Escape}')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup()
    render(<ConfirmDialog state={{ title: 'Sure?', resolve: vi.fn() }} onClose={() => {}} />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'OK' })

    await waitFor(() => expect(confirm).toHaveFocus())
    // Tab off the last control wraps to the first rather than leaving the modal.
    await user.tab()
    expect(cancel).toHaveFocus()
    await user.tab()
    expect(confirm).toHaveFocus()
    // And backwards off the first wraps to the last.
    await user.tab({ shift: true })
    expect(cancel).toHaveFocus()
  })

  it('hands focus back to whatever opened it', async () => {
    const user = userEvent.setup()
    function Opener() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>delete</button>
          <ConfirmDialog
            state={open ? { title: 'Sure?', resolve: () => setOpen(false) } : null}
            onClose={() => setOpen(false)}
          />
        </>
      )
    }
    render(<Opener />)
    const opener = screen.getByRole('button', { name: 'delete' })
    await user.click(opener)
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    // Without this a keyboard user is dropped back on <body>, at the top of
    // the page, having lost their place.
    await waitFor(() => expect(opener).toHaveFocus())
  })
})
