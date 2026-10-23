import Badge from '../../../components/Badge'
import { inputCls, labelCls } from './styles'
import { formatRevisionStatus, isWithdrawnDrawing, sortRevisions } from '../../../lib/drawings'
import { clampPageInput } from '../../../lib/quant'

// ── Which sheet: drawing → revision → page ───────────────────────────────────
//
// Reads the existing Documents register (no new data). Withdrawn drawings are
// not offered; withdrawn revisions are listed (their measurements stay
// inspectable) but the workspace refuses to measure on them. The current
// revision is preselected; choosing an older one is deliberate and warned.
//
// The page number COMMITS on Enter or blur, never per keystroke (ADR-53):
// typing "12" used to visit page 1 on the way — and the sheet change that
// implied discarded whatever was being drawn. The input is uncontrolled and
// keyed by the current page, so an outside change (‹ ›, a restored
// selection) resets it without an effect. The clamp is lib/quant.js →
// clampPageInput, unit-tested.

export default function SourcePicker({
  drawings, drawingsLoading, drawingsError, drawingId, onDrawingChange,
  revisions, revisionsLoading, revisionsError, revisionId, onRevisionChange,
  page, numPages, onPageChange,
}) {
  const options = (drawings ?? []).filter(d => !isWithdrawnDrawing(d))
  const sorted = sortRevisions(revisions)
  const selectedRevision = sorted.find(r => r.id === revisionId) ?? null

  // Commit the typed page: a valid, different number navigates; anything else
  // puts the current page back in the box.
  const commitPage = (input) => {
    const n = clampPageInput(input.value, numPages)
    if (n !== null && n !== page) onPageChange(n)
    else input.value = String(page)
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div>
        <label className={labelCls} htmlFor="quant-drawing">Drawing</label>
        <select
          id="quant-drawing"
          className={inputCls}
          value={drawingId ?? ''}
          onChange={e => onDrawingChange(e.target.value || null)}
          disabled={drawingsLoading || drawingsError}
        >
          <option value="">{drawingsLoading ? 'Loading drawings…' : drawingsError ? 'Drawings unavailable' : 'Choose a drawing…'}</option>
          {options.map(d => (
            <option key={d.id} value={d.id}>
              {d.drawingNumber} — {d.title}{d.currentRevisionCode ? ` (Rev ${d.currentRevisionCode})` : ' (no revision)'}
            </option>
          ))}
        </select>
        {drawingsError && <p className="m-0 mt-1 text-[11.5px] text-brand-red">The drawing register could not be loaded.</p>}
      </div>

      <div>
        <label className={labelCls} htmlFor="quant-revision">Revision</label>
        <select
          id="quant-revision"
          className={inputCls}
          value={revisionId ?? ''}
          onChange={e => onRevisionChange(e.target.value || null)}
          disabled={!drawingId || revisionsLoading || revisionsError || sorted.length === 0}
        >
          <option value="">
            {!drawingId ? '—' : revisionsLoading ? 'Loading revisions…' : revisionsError ? 'Revisions unavailable' : sorted.length === 0 ? 'No revisions issued' : 'Choose a revision…'}
          </option>
          {sorted.map(r => (
            <option key={r.id} value={r.id}>
              Rev {r.revisionCode} · {formatRevisionStatus(r.status)} · {r.revisionDate}
            </option>
          ))}
        </select>
        {selectedRevision && (
          <div className="mt-1.5 flex items-center gap-2">
            <Badge
              label={formatRevisionStatus(selectedRevision.status)}
              variant={selectedRevision.status === 'current' ? 'active' : selectedRevision.status === 'withdrawn' ? 'danger' : 'soon'}
              sm
            />
            <span className="text-[11.5px] text-brand-muted">{selectedRevision.fileName}</span>
          </div>
        )}
        {revisionsError && <p className="m-0 mt-1 text-[11.5px] text-brand-red">Revisions could not be loaded.</p>}
      </div>

      <div>
        <label className={labelCls} htmlFor="quant-page">Page</label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-brand-border text-brand-text disabled:opacity-40"
            onClick={() => onPageChange(page - 1)}
            disabled={!numPages || page <= 1}
            aria-label="Previous page"
          >
            ‹
          </button>
          <input
            key={page}
            id="quant-page"
            type="number"
            inputMode="numeric"
            min="1"
            max={numPages || 1}
            className={`${inputCls} text-center`}
            defaultValue={page}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitPage(e.currentTarget) }
              if (e.key === 'Escape') { e.currentTarget.value = String(page); e.currentTarget.blur() }
            }}
            onBlur={e => commitPage(e.currentTarget)}
            disabled={!numPages || numPages <= 1}
            aria-describedby="quant-page-help"
          />
          <button
            type="button"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-brand-border text-brand-text disabled:opacity-40"
            onClick={() => onPageChange(page + 1)}
            disabled={!numPages || page >= numPages}
            aria-label="Next page"
          >
            ›
          </button>
        </div>
        <p id="quant-page-help" className="m-0 mt-1 text-[11.5px] text-brand-muted">
          {numPages ? `of ${numPages} · type a page and press Enter` : 'Page count appears once the sheet loads.'}
        </p>
      </div>
    </div>
  )
}
