import { useStore } from '../store-context'

export function ApplyReviewModal() {
  const { applyReview, cancelApply, confirmApply, applying } = useStore()
  if (!applyReview) return null

  const changed = applyReview.results.filter((r) => r.changes.length > 0)
  const unchanged = applyReview.results.length - changed.length
  const errors = applyReview.results.filter((r) => r.error)

  return (
    <div className="overlay-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !applying) cancelApply() }}>
      <div className="review-modal">
        <div className="modal-header">
          <h3>Review changes</h3>
          <p>
            The ruleset will change {applyReview.changed_files} of {applyReview.total_files} file
            {applyReview.total_files === 1 ? '' : 's'}. Nothing has been written yet.
          </p>
        </div>
        <div className="review-list">
          {changed.map((r) => (
            <div className="review-file" key={r.path}>
              <div className="rf-head">
                {r.filename}
                <span className="rf-count">{r.changes.length} change{r.changes.length === 1 ? '' : 's'}</span>
              </div>
              {r.changes.map((c, i) => (
                <div className="rf-change" key={i}>
                  <span className="rf-field">{c.label}</span>
                  <span className="rf-before">{c.before || '(empty)'}</span>
                  <span className="rf-arrow">→</span>
                  <span className="rf-after">{c.after || '(empty)'}</span>
                </div>
              ))}
            </div>
          ))}
          {errors.map((r) => (
            <div className="review-file" key={r.path}>
              <div className="rf-head">{r.filename}</div>
              <div className="rf-error">{r.error}</div>
            </div>
          ))}
          {changed.length === 0 && errors.length === 0 && (
            <div className="review-none">No files would change — adjust the rules and try again.</div>
          )}
          {unchanged > 0 && (
            <p className="field-help" style={{ textAlign: 'center' }}>
              {unchanged} file{unchanged === 1 ? '' : 's'} left unchanged (rules did not match).
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button className="text-btn" onClick={cancelApply} disabled={applying}>
            Cancel
          </button>
          <button className="save-btn" onClick={confirmApply} disabled={applying || applyReview.changed_files === 0}>
            {applying ? 'Applying…' : 'Apply changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
