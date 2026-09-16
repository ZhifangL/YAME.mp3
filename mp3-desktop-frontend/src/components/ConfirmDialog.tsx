// In-app confirmation dialog.
//
// Used instead of `window.confirm`, which a Tauri webview may refuse to draw
// (the call then returns false and a destructive action quietly does nothing),
// and which looks like a browser artefact on Windows. This dialog is styled
// from the same tokens as the rest of the app, so it reads as part of YAME on
// every platform.
import { useCallback, useEffect, useRef } from 'react'
import type { ConfirmRequest } from '../store-context'

export function ConfirmDialog({
  state,
  onClose,
}: {
  state: ConfirmRequest | null
  onClose: () => void
}) {
  const confirmButton = useRef<HTMLButtonElement>(null)
  // Which request has already been answered. `state` does not clear until React
  // re-renders, so without this a fast second press (or Escape right after a
  // click) could resolve the same promise twice.
  const answeredFor = useRef<ConfirmRequest | null>(null)

  const answer = useCallback(
    (value: boolean) => {
      if (!state || answeredFor.current === state) return
      answeredFor.current = state
      state.resolve(value)
      onClose()
    },
    [state, onClose],
  )

  // Focus the confirming action, as a native message box does, so Enter means
  // "go ahead" and Escape cancels. Deferring to the next frame keeps the dialog
  // from scrolling the page underneath it.
  useEffect(() => {
    if (!state) return
    const frame = requestAnimationFrame(() => confirmButton.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [state])

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        answer(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [state, answer])

  if (!state) return null

  return (
    <div
      className="overlay-backdrop confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) answer(false)
      }}
    >
      <div className="confirm-modal" role="dialog" aria-modal="true" aria-label={state.title}>
        <div className="confirm-body">
          <h3 className="confirm-title">{state.title}</h3>
          {state.message && <p className="confirm-message">{state.message}</p>}
        </div>
        <div className="confirm-actions">
          <button className="text-btn" onClick={() => answer(false)}>
            {state.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmButton}
            className={state.danger ? 'save-btn danger-btn' : 'save-btn'}
            onClick={() => answer(true)}
          >
            {state.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
