import { Fragment, useEffect } from 'react'
import Badge from '../../../components/Badge'
import { thCls, tdCls } from './styles'
import { resolveCostCodeName } from '../../../lib/costCodes'
import {
  KIND_LABELS, MEASUREMENT_KIND, MEASUREMENT_STATUS, CALIBRATION_REVIEW, CALIBRATION_REVIEW_LABELS,
  calibrationReviewState, formatMeasurementQuantity, measurementQuantity, originalQuantity, quantityIssue, quantityBreakdown,
  isReadableMeasurement, sortMeasurements, measurementBoqItemId, measurementDeductions, isDeduction,
} from '../../../lib/quant'
import { measurementLinkState, boqItemLabel, LINK_STATE, LINK_STATE_LABELS } from '../../../lib/quantBoq'
import { measuredAt } from '../../../lib/quantSummary'
import { formatDate } from '../../../lib/formatters'

// ── The measurements on this page ────────────────────────────────────────────
//
// PRESENTATION ONLY: every quantity is lib/quant.js → measurementQuantity
// under the page's CURRENT calibration; a measurement flagged "Needs review"
// also shows the quantity it recorded under the scale it was saved with
// (originalQuantity), so a re-calibration never hides what was measured
// before. Unreadable records are listed as such — never drawn, never summed.
//
// The BOQ column (ADR-52) shows the linked item, or a warning when the link
// no longer points at a valid target (item voided, cost code or unit moved).
// A failed BOQ read shows "BOQ unavailable" — never "not linked".
//
// A quantity that cannot be derived (a crossed outline, say — ADR-53) shows
// its actionable reason under the "—" so the user knows which control fixes
// it; the BOQ apply dialog blocks the same record through the same derivation.
// When a measurement is selected on the sheet, its row is scrolled into view.
//
// Deductions (Quant 1D, ADR-54): an area's quantity is its NET; when it has
// holes the cell adds "gross − n deductions" and the row is followed by the
// deductions themselves — each with its own area and Edit outline / Rename /
// Remove — as a SUB-LIST of the parent, never as rows of their own (they are
// never summed, never linked, never selectable as measurements). A hole the
// derivation names as the problem is marked; a hole that cannot be read is
// listed as such with Remove only. Deduct on an area starts a new one.
//
// A desktop table, cards below `md`. Every action is a real button ≥44px.
//
// Mobile actions (375px): a card's actions are a compact two-row group rather
// than a wrapping row of five — the review indicator sits beside its own
// action (Mark reviewed), and Show · Details · Geometry · Void share ONE
// 44px-tall row of equal cells, Void separated as the destructive action. The
// table keeps its inline row.

const REVIEW_BADGE = {
  [CALIBRATION_REVIEW.CURRENT]:        'active',
  [CALIBRATION_REVIEW.NEEDS_REVIEW]:   'pending',
  [CALIBRATION_REVIEW.UNCALIBRATED]:   'danger',
  [CALIBRATION_REVIEW.NOT_APPLICABLE]: 'soon',
}

const rowActionCls = 'inline-flex min-h-[44px] items-center rounded-lg px-2.5 text-[12px] font-semibold text-brand-accent hover:bg-brand-card focus-visible:outline-2 focus-visible:outline-brand-accent disabled:opacity-40'
// Compact (mobile card) cells: equal width, centred, labels never broken mid-word.
const compactActionCls = 'inline-flex min-h-[44px] w-full items-center justify-center rounded-lg px-1.5 text-[12px] font-semibold whitespace-nowrap text-brand-accent hover:bg-brand-card focus-visible:outline-2 focus-visible:outline-brand-accent focus-visible:-outline-offset-2 disabled:opacity-40'

// `canEdit` — the sheet is live (revision and drawing not withdrawn) and the
// role may write: geometry, details and review are offered. `canVoid` — the
// role may write: void is offered even on a withdrawn sheet, because voiding
// a historical measurement with a reason is housekeeping, and it is the ONE
// write rules permit there (ADR-51). `canDeduct` — an AREA on a live sheet.
//
// `compact` — the mobile card layout: `indicator` (the review badge) and Mark
// reviewed on one line, the remaining actions as equal cells on the next.
function Actions({ m, canEdit, canVoid, canDeduct, onSelect, onEditDetails, onEditGeometry, onReview, onVoid, onDeduct, needsReview, compact = false, indicator = null }) {
  const actionCls = compact ? compactActionCls : rowActionCls
  const review = canEdit && needsReview && <button type="button" className={actionCls} onClick={() => onReview(m)}>Mark reviewed</button>
  const deduct = canDeduct && <button type="button" className={actionCls} onClick={() => onDeduct(m)}>Deduct</button>
  if (!compact) {
    return (
      <div className="flex flex-wrap gap-1">
        <button type="button" className={actionCls} onClick={() => onSelect(m)}>Show</button>
        {canEdit && <button type="button" className={actionCls} onClick={() => onEditDetails(m)}>Details</button>}
        {canEdit && <button type="button" className={actionCls} onClick={() => onEditGeometry(m)}>Geometry</button>}
        {deduct}
        {review}
        {canVoid && <button type="button" className={`${actionCls} text-brand-red`} onClick={() => onVoid(m)}>Void</button>}
      </div>
    )
  }
  return (
    <div className="mt-1.5 flex flex-col gap-1" role="group" aria-label={`Actions for ${m.label}`}>
      <div className="flex items-center justify-between gap-2">
        {indicator}
        <div className="flex shrink-0 items-center gap-1">
          {deduct}
          {review}
        </div>
      </div>
      <div className="grid grid-flow-col auto-cols-fr gap-1 border-t border-brand-border pt-1">
        <button type="button" className={actionCls} onClick={() => onSelect(m)}>Show</button>
        {canEdit && <button type="button" className={actionCls} onClick={() => onEditDetails(m)}>Details</button>}
        {canEdit && <button type="button" className={actionCls} onClick={() => onEditGeometry(m)}>Geometry</button>}
        {canVoid && <button type="button" className={`${actionCls} text-brand-red`} onClick={() => onVoid(m)}>Void</button>}
      </div>
    </div>
  )
}

// The BOQ cell: item label, "—", a warning, or "unavailable".
function LinkCell({ link, boqItemsError, boqItemsLoading }) {
  if (boqItemsError) return <span className="text-brand-red">BOQ unavailable</span>
  if (link.state === LINK_STATE.NONE) return <span className="text-brand-muted">—</span>
  if (boqItemsLoading) return <span className="text-brand-muted">Loading…</span>
  if (link.state === LINK_STATE.OK) return <span>{boqItemLabel(link.item)}</span>
  return (
    <span className="text-brand-amber">
      {link.item ? `${boqItemLabel(link.item)} · ` : ''}{LINK_STATE_LABELS[link.state]}
    </span>
  )
}

// The gross − deductions line under a net quantity (null when there are none).
function Breakdown({ breakdown }) {
  if (!breakdown) return null
  return (
    <span className="block text-[11px] text-brand-muted">
      gross {breakdown.gross} − {breakdown.count} deduction{breakdown.count === 1 ? '' : 's'} {breakdown.deducted}
    </span>
  )
}

// The parent's holes, as a sub-list: label, own area, flagged when the
// derivation names it, and the three per-hole actions while the sheet is live.
function Deductions({ m, deductions, flaggedIds, calibration, canEdit, onEditDeduction, onRenameDeduction, onRemoveDeduction, compact = false }) {
  const actionCls = compact ? compactActionCls : rowActionCls
  return (
    <ul className="m-0 list-none p-0" aria-label={`Deductions from ${m.label}`}>
      {deductions.map((d, index) => {
        const readable = isDeduction(d)
        const flagged = readable && flaggedIds.includes(d.id)
        const area = readable ? formatMeasurementQuantity(measurementQuantity({ kind: MEASUREMENT_KIND.AREA, points: d.points }, calibration)) : '—'
        return (
          <li key={readable ? d.id : `unreadable-${index}`} className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-brand-border/60 py-1 pl-4 text-[12px] ${flagged ? 'text-brand-red' : 'text-brand-text'}`}>
            <span className="min-w-0 break-words">
              <span className="text-brand-muted">− </span>
              {readable ? (d.label || '(unnamed deduction)') : '(unreadable deduction)'}
              <span className="ml-2 tabular-nums">{area}</span>
              {flagged && <span className="ml-2 text-[11px] font-semibold">· see note</span>}
            </span>
            {canEdit && (
              <span className={compact ? 'grid grid-flow-col auto-cols-fr gap-1' : 'flex flex-wrap gap-1'}>
                {readable && <button type="button" className={actionCls} onClick={() => onEditDeduction(m, d)}>Edit outline</button>}
                {readable && <button type="button" className={actionCls} onClick={() => onRenameDeduction(m, d)}>Rename</button>}
                <button type="button" className={`${actionCls} text-brand-red`} onClick={() => onRemoveDeduction(m, d, index)}>Remove</button>
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default function MeasurementList({
  measurements, page, costCodes, boqItems, boqItemsLoading, boqItemsError, selectedId, canEdit, canVoid,
  onSelect, onEditDetails, onEditGeometry, onReview, onVoid,
  onDeduct, onEditDeduction, onRenameDeduction, onRemoveDeduction,
}) {
  const sorted = sortMeasurements(measurements)
  const readable   = sorted.filter(isReadableMeasurement)
  const unreadable = sorted.length - readable.length
  const active = readable.filter(m => m.status === MEASUREMENT_STATUS.ACTIVE)
  const voided = readable.filter(m => m.status === MEASUREMENT_STATUS.VOID)
  const calibration = page?.calibration ?? null

  const rows = active.map(m => {
    const review = calibrationReviewState(m, page)
    const q = measurementQuantity(m, calibration)
    return {
      m,
      quantity: formatMeasurementQuantity(q),
      issue: quantityIssue(q),
      breakdown: quantityBreakdown(q),
      deductions: measurementDeductions(m),
      flaggedIds: q.deductionIds ?? [],
      original: review === CALIBRATION_REVIEW.NEEDS_REVIEW ? formatMeasurementQuantity(originalQuantity(m)) : null,
      review,
      costCode: resolveCostCodeName(m.costCodeId, costCodes, m.costCodeName),
      link: measurementLinkState(m, boqItems),
      // The measured date — only when the document carries a real timestamp (1C-B).
      measured: measuredAt(m) ? formatDate(measuredAt(m)) : null,
    }
  })

  // The selected measurement's visible row (table or card) scrolls into view —
  // a DOM scroll only, no state.
  useEffect(() => {
    if (!selectedId || typeof document === 'undefined') return
    for (const prefix of ['quant-row-', 'quant-card-']) {
      const el = document.getElementById(`${prefix}${selectedId}`)
      if (el && el.offsetParent !== null) { el.scrollIntoView?.({ block: 'nearest' }); return }
    }
  }, [selectedId])

  if (sorted.length === 0) {
    return (
      <p className="m-0 px-4 py-8 text-center text-[13px] text-brand-muted">
        No measurements on this page yet. Choose a tool above and tap the sheet.
      </p>
    )
  }

  const canDeductRow = (m) => canEdit && m.kind === MEASUREMENT_KIND.AREA && typeof onDeduct === 'function'
  const deductionHandlers = { onEditDeduction, onRenameDeduction, onRemoveDeduction }

  return (
    <div>
      {unreadable > 0 && (
        <p className="m-0 px-4 py-2 text-[12px] text-brand-amber" role="alert">
          {unreadable} record{unreadable === 1 ? '' : 's'} on this page could not be read and {unreadable === 1 ? 'is' : 'are'} not shown.
        </p>
      )}

      {/* Desktop / tablet table — scrolls inside its own container. */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full border-collapse min-w-[860px]">
          <thead>
            <tr className="bg-brand-card border-b border-brand-border">
              {['Label', 'Type', 'Quantity', 'Cost code', 'BOQ item', 'Scale', ''].map((h, i) => <th key={h || i} className={thCls}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, quantity, issue, breakdown, deductions, flaggedIds, original, review, costCode, link, measured }) => (
              <Fragment key={m.id}>
                <tr id={`quant-row-${m.id}`} className={`border-b border-brand-border ${m.id === selectedId ? 'bg-brand-accent/10' : ''}`}>
                  <td className={`${tdCls} font-semibold`}>
                    {m.label}
                    {measured && <span className="block text-[11px] font-normal text-brand-muted">Measured {measured}</span>}
                  </td>
                  <td className={`${tdCls} text-brand-muted`}>{KIND_LABELS[m.kind]} · {m.points.length} pt</td>
                  <td className={`${tdCls} tabular-nums`}>
                    <span className="whitespace-nowrap">{quantity}</span>
                    <Breakdown breakdown={breakdown} />
                    {original && <span className="block text-[11px] text-brand-amber">was {original}</span>}
                    {issue && <span className="block max-w-[220px] text-[11px] text-brand-red" role="alert">{issue}</span>}
                  </td>
                  <td className={`${tdCls} text-[12.5px]`}>{costCode}</td>
                  <td className={`${tdCls} text-[12.5px]`}>
                    <LinkCell link={link} boqItemsError={boqItemsError} boqItemsLoading={boqItemsLoading} />
                  </td>
                  <td className={tdCls}><Badge label={CALIBRATION_REVIEW_LABELS[review]} variant={REVIEW_BADGE[review]} sm /></td>
                  <td className={`${tdCls} text-right`}>
                    <Actions
                      m={m} canEdit={canEdit} canVoid={canVoid} canDeduct={canDeductRow(m)} needsReview={review === CALIBRATION_REVIEW.NEEDS_REVIEW}
                      onSelect={onSelect} onEditDetails={onEditDetails} onEditGeometry={onEditGeometry} onReview={onReview} onVoid={onVoid} onDeduct={onDeduct}
                    />
                  </td>
                </tr>
                {deductions.length > 0 && (
                  <tr className={`border-b border-brand-border ${m.id === selectedId ? 'bg-brand-accent/5' : ''}`}>
                    <td colSpan={7} className="px-3 pb-2 pt-0">
                      <Deductions m={m} deductions={deductions} flaggedIds={flaggedIds} calibration={calibration} canEdit={canEdit} {...deductionHandlers} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards. */}
      <div className="md:hidden flex flex-col">
        {rows.map(({ m, quantity, issue, breakdown, deductions, flaggedIds, original, review, costCode, link, measured }) => (
          <div key={m.id} id={`quant-card-${m.id}`} className={`px-4 py-3 border-b border-brand-border ${m.id === selectedId ? 'bg-brand-accent/10' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="m-0 text-[14px] font-bold text-brand-text break-words">{m.label}</p>
                <p className="m-0 mt-0.5 text-[12px] text-brand-muted">{KIND_LABELS[m.kind]} · {costCode}{measured ? ` · ${measured}` : ''}</p>
                <p className="m-0 mt-0.5 text-[12px]">
                  <span className="text-brand-muted">BOQ: </span>
                  <LinkCell link={link} boqItemsError={boqItemsError} boqItemsLoading={boqItemsLoading} />
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="m-0 text-[15px] font-bold tabular-nums text-brand-text">{quantity}</p>
                <Breakdown breakdown={breakdown} />
                {original && <p className="m-0 text-[11px] text-brand-amber">was {original}</p>}
              </div>
            </div>
            {issue && <p className="m-0 mt-1 text-[11.5px] text-brand-red" role="alert">{issue}</p>}
            {deductions.length > 0 && (
              <div className="mt-1.5">
                <Deductions compact m={m} deductions={deductions} flaggedIds={flaggedIds} calibration={calibration} canEdit={canEdit} {...deductionHandlers} />
              </div>
            )}
            <Actions
              compact
              indicator={<Badge label={CALIBRATION_REVIEW_LABELS[review]} variant={REVIEW_BADGE[review]} sm />}
              m={m} canEdit={canEdit} canVoid={canVoid} canDeduct={canDeductRow(m)} needsReview={review === CALIBRATION_REVIEW.NEEDS_REVIEW}
              onSelect={onSelect} onEditDetails={onEditDetails} onEditGeometry={onEditGeometry} onReview={onReview} onVoid={onVoid} onDeduct={onDeduct}
            />
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
                {measurementDeductions(m).length > 0 && <span> · {measurementDeductions(m).length} deduction{measurementDeductions(m).length === 1 ? '' : 's'} voided with it</span>}
                {measurementBoqItemId(m) && <span> · was linked to a BOQ item (history only — never summed)</span>}
                {m.voidReason && <span className="block text-[11.5px]">Reason: {m.voidReason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
