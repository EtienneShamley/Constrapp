import Badge from '../../../components/Badge'
import { thCls, tdCls } from './styles'
import { resolveCostCodeName } from '../../../lib/costCodes'
import {
  KIND_LABELS, MEASUREMENT_STATUS, CALIBRATION_REVIEW, CALIBRATION_REVIEW_LABELS,
  calibrationReviewState, formatMeasurementQuantity, measurementQuantity, originalQuantity,
  isReadableMeasurement, sortMeasurements,
} from '../../../lib/quant'

// ── The measurements on this page ────────────────────────────────────────────
//
// PRESENTATION ONLY: every quantity is lib/quant.js → measurementQuantity
// under the page's CURRENT calibration; a measurement flagged "Needs review"
// also shows the quantity it recorded under the scale it was saved with
// (originalQuantity), so a re-calibration never hides what was measured
// before. Unreadable records are listed as such — never drawn, never summed.
//
// A desktop table, cards below `md`. Every action is a real button ≥44px.

const REVIEW_BADGE = {
  [CALIBRATION_REVIEW.CURRENT]:        'active',
  [CALIBRATION_REVIEW.NEEDS_REVIEW]:   'pending',
  [CALIBRATION_REVIEW.UNCALIBRATED]:   'danger',
  [CALIBRATION_REVIEW.NOT_APPLICABLE]: 'soon',
}

const actionCls = 'inline-flex min-h-[44px] items-center rounded-lg px-2.5 text-[12px] font-semibold text-brand-accent hover:bg-brand-card focus-visible:outline-2 focus-visible:outline-brand-accent disabled:opacity-40'

// `canEdit` — the sheet is live (revision and drawing not withdrawn) and the
// role may write: geometry, details and review are offered. `canVoid` — the
// role may write: void is offered even on a withdrawn sheet, because voiding
// a historical measurement with a reason is housekeeping, and it is the ONE
// write rules permit there (ADR-51).
function Actions({ m, canEdit, canVoid, onSelect, onEditDetails, onEditGeometry, onReview, onVoid, needsReview }) {
  return (
    <div className="flex flex-wrap gap-1">
      <button type="button" className={actionCls} onClick={() => onSelect(m)}>Show</button>
      {canEdit && <button type="button" className={actionCls} onClick={() => onEditDetails(m)}>Details</button>}
      {canEdit && <button type="button" className={actionCls} onClick={() => onEditGeometry(m)}>Geometry</button>}
      {canEdit && needsReview && <button type="button" className={actionCls} onClick={() => onReview(m)}>Mark reviewed</button>}
      {canVoid && <button type="button" className={`${actionCls} text-brand-red`} onClick={() => onVoid(m)}>Void</button>}
    </div>
  )
}

export default function MeasurementList({
  measurements, page, costCodes, selectedId, canEdit, canVoid,
  onSelect, onEditDetails, onEditGeometry, onReview, onVoid,
}) {
  const sorted = sortMeasurements(measurements)
  const readable   = sorted.filter(isReadableMeasurement)
  const unreadable = sorted.length - readable.length
  const active = readable.filter(m => m.status === MEASUREMENT_STATUS.ACTIVE)
  const voided = readable.filter(m => m.status === MEASUREMENT_STATUS.VOID)
  const calibration = page?.calibration ?? null

  const rows = active.map(m => {
    const review = calibrationReviewState(m, page)
    return {
      m,
      quantity: formatMeasurementQuantity(measurementQuantity(m, calibration)),
      original: review === CALIBRATION_REVIEW.NEEDS_REVIEW ? formatMeasurementQuantity(originalQuantity(m)) : null,
      review,
      costCode: resolveCostCodeName(m.costCodeId, costCodes, m.costCodeName),
    }
  })

  if (sorted.length === 0) {
    return (
      <p className="m-0 px-4 py-8 text-center text-[13px] text-brand-muted">
        No measurements on this page yet. Choose a tool above and tap the sheet.
      </p>
    )
  }

  return (
    <div>
      {unreadable > 0 && (
        <p className="m-0 px-4 py-2 text-[12px] text-brand-amber" role="alert">
          {unreadable} record{unreadable === 1 ? '' : 's'} on this page could not be read and {unreadable === 1 ? 'is' : 'are'} not shown.
        </p>
      )}

      {/* Desktop / tablet table — scrolls inside its own container. */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full border-collapse min-w-[760px]">
          <thead>
            <tr className="bg-brand-card border-b border-brand-border">
              {['Label', 'Type', 'Quantity', 'Cost code', 'Scale', ''].map((h, i) => <th key={h || i} className={thCls}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, quantity, original, review, costCode }) => (
              <tr key={m.id} className={`border-b border-brand-border ${m.id === selectedId ? 'bg-brand-accent/10' : ''}`}>
                <td className={`${tdCls} font-semibold`}>{m.label}</td>
                <td className={`${tdCls} text-brand-muted`}>{KIND_LABELS[m.kind]} · {m.points.length} pt</td>
                <td className={`${tdCls} tabular-nums whitespace-nowrap`}>
                  {quantity}
                  {original && <span className="block text-[11px] text-brand-amber">was {original}</span>}
                </td>
                <td className={`${tdCls} text-[12.5px]`}>{costCode}</td>
                <td className={tdCls}><Badge label={CALIBRATION_REVIEW_LABELS[review]} variant={REVIEW_BADGE[review]} sm /></td>
                <td className={`${tdCls} text-right`}>
                  <Actions
                    m={m} canEdit={canEdit} canVoid={canVoid} needsReview={review === CALIBRATION_REVIEW.NEEDS_REVIEW}
                    onSelect={onSelect} onEditDetails={onEditDetails} onEditGeometry={onEditGeometry} onReview={onReview} onVoid={onVoid}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards. */}
      <div className="md:hidden flex flex-col">
        {rows.map(({ m, quantity, original, review, costCode }) => (
          <div key={m.id} className={`px-4 py-3 border-b border-brand-border ${m.id === selectedId ? 'bg-brand-accent/10' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="m-0 text-[14px] font-bold text-brand-text break-words">{m.label}</p>
                <p className="m-0 mt-0.5 text-[12px] text-brand-muted">{KIND_LABELS[m.kind]} · {costCode}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="m-0 text-[15px] font-bold tabular-nums text-brand-text">{quantity}</p>
                {original && <p className="m-0 text-[11px] text-brand-amber">was {original}</p>}
              </div>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <Badge label={CALIBRATION_REVIEW_LABELS[review]} variant={REVIEW_BADGE[review]} sm />
              <Actions
                m={m} canEdit={canEdit} canVoid={canVoid} needsReview={review === CALIBRATION_REVIEW.NEEDS_REVIEW}
                onSelect={onSelect} onEditDetails={onEditDetails} onEditGeometry={onEditGeometry} onReview={onReview} onVoid={onVoid}
              />
            </div>
          </div>
        ))}
      </div>

      {active.length === 0 && (
        <p className="m-0 px-4 py-6 text-center text-[13px] text-brand-muted">No active measurements on this page.</p>
      )}

      {voided.length > 0 && (
        <details className="px-4 py-3 group">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 text-[12px] font-bold uppercase tracking-[0.4px] text-brand-muted">
            <span className="transition-transform group-open:rotate-90">▸</span>
            Voided · {voided.length}
          </summary>
          <ul className="m-0 mt-2 list-none p-0">
            {voided.map(m => (
              <li key={m.id} className="py-1.5 text-[12.5px] text-brand-muted border-t border-brand-border">
                <span className="line-through">{m.label}</span> · {KIND_LABELS[m.kind]} · {m.costCodeName}
                {m.voidReason && <span className="block text-[11.5px]">Reason: {m.voidReason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
