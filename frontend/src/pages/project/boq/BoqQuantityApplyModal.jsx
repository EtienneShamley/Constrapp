import { useEffect, useMemo, useRef, useState } from 'react'
import Btn from '../../../components/Btn'
import Badge from '../../../components/Badge'
import { formatCurrency, formatDate } from '../../../lib/formatters'
import { tabbableWithin, tabTarget } from '../../../lib/dialogFocus'
import { BOQ_STATUS, BOQ_STATUS_LABELS, BOQ_BADGE_VARIANTS, formatQuantity } from '../../../lib/boq'
import { KIND_LABELS, CALIBRATION_REVIEW_LABELS, formatMeasurementQuantity } from '../../../lib/quant'
import {
  aggregateLinkedQuantity, applyReadiness, applyPreview, evidenceKey, evidenceFingerprint,
  APPLY_BLOCKER_LABELS, APPLY_DISABLED, APPLY_DISABLED_LABELS,
  quantAppliedState, QUANT_APPLIED_STATE, QUANT_APPLIED_STATE_LABELS, isReadableQuantApplied,
  boqItemLabel, UNIT_DIMENSION_LABELS,
} from '../../../lib/quantBoq'

// ── Review linked Quant measurements and apply their total to a BOQ item ─────
//
// Quant 1B (ADR-52). Everything shown is derived on every render from the
// LIVE subscriptions the BOQ page passes in (measurements, takeoff pages,
// drawings, the item itself) through lib/quantBoq.js — so the proposal is
// always the latest evidence, never a copy taken when the dialog opened. The
// user confirms against an EVIDENCE KEY; if any input changes while the dialog
// is open, the confirmation is withdrawn and the changed result must be
// reviewed again before Apply re-enables.
//
// The money shown is the BOQ item's own derived amount (lib/boq.js →
// boqLineAmount) at the UNCHANGED rate — no other figure is computed here. An
// unpriced item shows no monetary amount at all. Amounts are shown to the
// currency's minor unit (`precise`, cents for AUD) exactly as the BOQ editor
// and void dialogs show theirs — a quantity change of 0.125 m² at $85 moves
// the amount by cents, and a whole-unit display would hide that.
//
// Keyboard: Escape closes (not while saving — Cancel is disabled then too);
// Tab / Shift+Tab stay inside the panel (lib/dialogFocus.js); the control that
// opened the dialog gets focus back when it closes.
//
// A loading or failed source disables Apply and says so: it is never "no
// measurements" and never "no issue". The write itself is the guarded
// transaction in lib/boqActions.js, called through the BOQ hook.

const labelCls = 'text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted'
const cellCls  = 'px-3 py-2 text-[12.5px] text-brand-text align-top'
const thCls    = 'text-left px-3 py-2 text-brand-muted text-[10.5px] font-bold uppercase tracking-[0.4px] whitespace-nowrap'

const APPLIED_BADGE = {
  [QUANT_APPLIED_STATE.MATCHES]:              'active',
  [QUANT_APPLIED_STATE.ITEM_EDITED_SINCE]:    'pending',
  [QUANT_APPLIED_STATE.MEASUREMENTS_CHANGED]: 'pending',
  [QUANT_APPLIED_STATE.UNVERIFIABLE]:         'soon',
  [QUANT_APPLIED_STATE.UNKNOWN]:              'soon',
}

function sourceLabel(row) {
  const { m, drawing, current } = row
  const number = drawing?.drawingNumber ?? 'Unknown drawing'
  if (!drawing) return `${number} · p.${m.page}`
  return current
    ? `${number} · Rev ${drawing.currentRevisionCode || '—'} · p.${m.page}`
    : `${number} · not the current revision · p.${m.page}`
}

export default function BoqQuantityApplyModal({
  item, measurements, takeoffPages, drawings, sources, currencyCode, currentUid, onApply, onClose,
  onOpenInQuant, // (row) — Quant 1C-B: hand this measurement's sheet to the Quant tab (read-only navigation)
}) {
  const aggregate = useMemo(
    () => aggregateLinkedQuantity({ item, measurements, takeoffPages, drawings }),
    [item, measurements, takeoffPages, drawings],
  )
  const readiness = applyReadiness({ item, aggregate, sources })
  const preview = applyPreview(item, aggregate.total)
  const appliedState = quantAppliedState(item, aggregate, sources)
  const key = evidenceKey(item, aggregate)

  // The confirmation is bound to the evidence it was given against.
  const [confirmedKey, setConfirmedKey] = useState(null)
  const confirmed = confirmedKey !== null && confirmedKey === key
  const evidenceChanged = confirmedKey !== null && confirmedKey !== key
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const isVoid = item.status !== BOQ_STATUS.ACTIVE
  const applied = isReadableQuantApplied(item.quantApplied) ? item.quantApplied : null
  const canApply = readiness.canApply && confirmed && !saving

  // Focus: the other Constrapp dialogs autoFocus their first field; this one
  // has no field, so the panel takes focus on open and the opener gets it back
  // on close — keyboard users never stay behind the overlay.
  const panelRef = useRef(null)
  useEffect(() => {
    const opener = document.activeElement
    panelRef.current?.focus()
    return () => { if (opener && typeof opener.focus === 'function') opener.focus() }
  }, [])

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (saving) return
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const target = tabTarget({
      shiftKey: e.shiftKey,
      active: document.activeElement,
      tabbable: tabbableWithin(panel),
      fallback: panel,
    })
    if (target) { e.preventDefault(); target.focus() }
  }

  async function submit(e) {
    e.preventDefault()
    // Recomputed from the latest snapshots on this render — never from a
    // value captured when the dialog opened.
    const latest = applyReadiness({ item, aggregate, sources })
    if (!latest.canApply) { setError(APPLY_DISABLED_LABELS[latest.reason]); return }
    if (!confirmed) { setError('Review the proposed change and tick the confirmation first.'); return }
    const evidence = evidenceFingerprint(aggregate)
    if (!evidence) { setError('The reviewed evidence could not be fingerprinted. Review the measurements again.'); return }
    setSaving(true); setError(null)
    try {
      await onApply(item, { quantity: aggregate.total, measurementCount: aggregate.eligible.length, evidence })
      onClose()
    } catch (err) {
      setError(err?.message || 'The quantity could not be applied. Nothing was saved.')
      setSaving(false)
      setConfirmedKey(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="boq-apply-title" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div ref={panelRef} tabIndex={-1} className="relative z-10 w-full max-w-[760px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-brand-accent">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-brand-border">
          <div className="min-w-0">
            <h2 id="boq-apply-title" className="text-[15px] font-bold text-brand-text m-0 truncate">Apply Quant measurements · {boqItemLabel(item)}</h2>
            <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">
              {item.costCodeName} · {item.unit} · current quantity {formatQuantity(item.quantity)} ·{' '}
              {preview.priced ? `rate ${formatCurrency(item.rate, currencyCode, { precise: true })}` : 'unpriced'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge label={BOQ_STATUS_LABELS[item.status] ?? item.status} variant={BOQ_BADGE_VARIANTS[item.status]} sm />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
            >
              ×
            </button>
          </div>
        </div>

        <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-4">
          {/* Source state — loading and unavailable are said out loud. */}
          {readiness.reason === APPLY_DISABLED.LOADING && (
            <p role="status" className="m-0 text-[12.5px] text-brand-muted">{APPLY_DISABLED_LABELS[APPLY_DISABLED.LOADING]}</p>
          )}
          {readiness.reason === APPLY_DISABLED.UNAVAILABLE && (
            <p role="alert" className="m-0 rounded-lg border-2 border-brand-red bg-brand-red/10 px-3 py-2 text-[12.5px] font-semibold text-brand-red">
              {APPLY_DISABLED_LABELS[APPLY_DISABLED.UNAVAILABLE]}
            </p>
          )}
          {isVoid && (
            <p role="alert" className="m-0 text-[12.5px] font-semibold text-brand-red">{APPLY_DISABLED_LABELS[APPLY_DISABLED.ITEM_VOID]}</p>
          )}
          {!aggregate.unitKind && !isVoid && (
            <p role="alert" className="m-0 text-[12.5px] text-brand-amber">
              {APPLY_DISABLED_LABELS[APPLY_DISABLED.UNIT_UNSUPPORTED]} Unit “{item.unit}” is not a length (m), area (m²) or count (no.) spelling Quant recognises.
            </p>
          )}

          {/* Linked measurements */}
          <section aria-labelledby="boq-apply-linked">
            <h3 id="boq-apply-linked" className="m-0 text-[13px] font-bold text-brand-text">
              Linked measurements · {aggregate.rows.length} active{aggregate.voided.length > 0 ? ` · ${aggregate.voided.length} voided (history only, never summed)` : ''}
            </h3>
            {aggregate.unitKind && (
              <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">This item accepts {UNIT_DIMENSION_LABELS[aggregate.unitKind]} measurements.</p>
            )}
            {aggregate.rows.length === 0 ? (
              <p className="m-0 mt-2 text-[12.5px] text-brand-muted">
                {readiness.reason === APPLY_DISABLED.LOADING || readiness.reason === APPLY_DISABLED.UNAVAILABLE
                  ? '—'
                  : 'No active measurements are linked to this item. Link them on the Quant tab.'}
              </p>
            ) : (
              <div className="mt-2 overflow-x-auto rounded-lg border border-brand-border">
                <table className="w-full border-collapse min-w-[560px]">
                  <thead>
                    <tr className="bg-brand-card border-b border-brand-border">
                      {['Label', 'Type', 'Source', 'Quantity', 'Status'].map(h => <th key={h} className={thCls}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {aggregate.rows.map(row => (
                      <tr key={row.m.id} className="border-b border-brand-border last:border-b-0">
                        <td className={`${cellCls} font-semibold`}>{row.m.label ?? row.m.id}</td>
                        <td className={`${cellCls} text-brand-muted`}>{KIND_LABELS[row.m.kind] ?? '—'}</td>
                        <td className={cellCls}>
                          <span className="block">{sourceLabel(row)}</span>
                          {onOpenInQuant && row.drawing && (
                            <button
                              type="button"
                              onClick={() => onOpenInQuant(row)}
                              disabled={saving}
                              aria-label={`Open ${row.m.label ?? row.m.id} in Quant`}
                              className="mt-0.5 inline-flex min-h-[32px] items-center rounded-lg px-1.5 text-[11.5px] font-semibold text-brand-accent hover:bg-brand-card focus-visible:outline-2 focus-visible:outline-brand-accent disabled:opacity-40"
                            >
                              Open in Quant →
                            </button>
                          )}
                        </td>
                        <td className={`${cellCls} tabular-nums whitespace-nowrap`}>{formatMeasurementQuantity(row.quantity)}</td>
                        <td className={cellCls}>
                          {row.blocker
                            ? <Badge label={APPLY_BLOCKER_LABELS[row.blocker].title} variant="danger" sm />
                            : <Badge label={row.review ? CALIBRATION_REVIEW_LABELS[row.review] : 'Eligible'} variant="active" sm />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Blockers — each with its remedy */}
          {aggregate.blockers.length > 0 && (
            <section aria-labelledby="boq-apply-blockers" className="rounded-lg border border-brand-red/40 bg-brand-red/5 px-3 py-2.5">
              <h3 id="boq-apply-blockers" className="m-0 text-[12.5px] font-bold text-brand-red">
                {aggregate.blockers.length} measurement{aggregate.blockers.length === 1 ? '' : 's'} block{aggregate.blockers.length === 1 ? 's' : ''} applying
              </h3>
              <p className="m-0 mt-0.5 text-[11.5px] text-brand-text">
                Nothing is omitted silently: every linked active measurement must be eligible before the total can be applied.
              </p>
              <ul className="m-0 mt-2 list-none p-0 flex flex-col gap-1.5">
                {aggregate.blockers.map(row => (
                  <li key={row.m.id} className="text-[12px] text-brand-text">
                    <span className="font-semibold">{row.m.label ?? row.m.id}</span> — {APPLY_BLOCKER_LABELS[row.blocker].title}.{' '}
                    <span className="text-brand-muted">{APPLY_BLOCKER_LABELS[row.blocker].remedy}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Proposed change */}
          <section aria-labelledby="boq-apply-proposal" className="rounded-lg bg-brand-bg border border-brand-border px-3 py-3">
            <h3 id="boq-apply-proposal" className="m-0 text-[13px] font-bold text-brand-text">Proposed change</h3>
            <dl className="m-0 mt-2 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <dt className={labelCls}>Existing quantity</dt>
                <dd className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">{formatQuantity(preview.currentQuantity)} {item.unit}</dd>
              </div>
              <div>
                <dt className={labelCls}>Measured total</dt>
                <dd className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">
                  {aggregate.total === null ? '—' : `${formatQuantity(aggregate.total)} ${aggregate.unit}`}
                </dd>
              </div>
              <div>
                <dt className={labelCls}>Proposed quantity</dt>
                <dd className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">
                  {preview.proposedQuantity === null ? '—' : `${formatQuantity(preview.proposedQuantity)} ${item.unit}`}
                </dd>
              </div>
              <div>
                <dt className={labelCls}>Difference</dt>
                <dd className={`m-0 mt-0.5 text-[13px] font-semibold tabular-nums ${preview.difference !== null && preview.difference < 0 ? 'text-brand-red' : 'text-brand-text'}`}>
                  {preview.difference === null ? '—' : `${preview.difference > 0 ? '+' : ''}${formatQuantity(preview.difference)} ${item.unit}`}
                </dd>
              </div>
            </dl>
            {preview.priced ? (
              <dl className="m-0 mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3 border-t border-brand-border pt-3">
                <div>
                  <dt className={labelCls}>Rate (unchanged)</dt>
                  <dd className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">{formatCurrency(item.rate, currencyCode, { precise: true })}</dd>
                </div>
                <div>
                  <dt className={labelCls}>Existing amount</dt>
                  <dd className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">{preview.currentAmount === null ? '—' : money(preview.currentAmount)}</dd>
                </div>
                <div>
                  <dt className={labelCls}>Proposed amount</dt>
                  <dd className="m-0 mt-0.5 text-[13px] font-bold tabular-nums text-brand-text">{preview.proposedAmount === null ? '—' : money(preview.proposedAmount)}</dd>
                </div>
              </dl>
            ) : (
              <p className="m-0 mt-3 border-t border-brand-border pt-3 text-[12px] text-brand-amber font-semibold">
                Unpriced — no monetary amount is calculated. Only the quantity changes; the item stays unpriced.
              </p>
            )}
            <p className="m-0 mt-2 text-[11px] text-brand-muted">
              Amount = quantity × rate, ex-GST, derived exactly as the BOQ editor derives it. Applying changes this BOQ item only —
              no budget, forecast, order, claim, invoice, cash-flow or margin figure moves.
            </p>
          </section>

          {/* Latest application — a record, not a certificate */}
          <section aria-labelledby="boq-apply-latest">
            <h3 id="boq-apply-latest" className="m-0 text-[13px] font-bold text-brand-text">Latest Quant application</h3>
            {applied ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-brand-text">
                <span>
                  {formatQuantity(applied.quantity)} {item.unit} from {applied.measurementCount} measurement{applied.measurementCount === 1 ? '' : 's'}
                  {applied.at ? ` · ${formatDate(applied.at)}` : ''} · by {applied.by === currentUid ? 'you' : 'another user'}
                </span>
                <Badge label={QUANT_APPLIED_STATE_LABELS[appliedState]} variant={APPLIED_BADGE[appliedState] ?? 'soon'} sm />
              </div>
            ) : (
              <p className="m-0 mt-1.5 text-[12.5px] text-brand-muted">{QUANT_APPLIED_STATE_LABELS[QUANT_APPLIED_STATE.NONE]}.</p>
            )}
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              This records the most recent confirmed application only, with a fingerprint of the measurements it summed. It is not
              an immutable history, a certification or server-verified evidence — the status beside it is recomputed from
              today&apos;s measurements and compared with that fingerprint, so the same total from different measurements reads as outdated.
            </p>
          </section>

          {evidenceChanged && (
            <p role="alert" className="m-0 rounded-lg border border-brand-amber/50 bg-brand-amber/10 px-3 py-2 text-[12.5px] font-semibold text-brand-amber">
              The measurements or the BOQ item changed while this dialog was open. Review the updated result above and confirm again.
            </p>
          )}

          {!readiness.canApply && readiness.reason !== APPLY_DISABLED.LOADING && readiness.reason !== APPLY_DISABLED.UNAVAILABLE && (
            <p role="status" className="m-0 text-[12px] text-brand-muted">{APPLY_DISABLED_LABELS[readiness.reason]}</p>
          )}

          <label className="flex items-start gap-3 min-h-[44px] cursor-pointer text-[12.5px] text-brand-text">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 shrink-0 accent-brand-accent"
              checked={confirmed}
              disabled={!readiness.canApply || saving}
              onChange={(e) => setConfirmedKey(e.target.checked ? key : null)}
            />
            <span>
              I have reviewed the linked measurements and the proposed change, and I want to set this BOQ item&apos;s quantity to{' '}
              <span className="font-semibold tabular-nums">{aggregate.total === null ? '—' : `${formatQuantity(aggregate.total)} ${item.unit}`}</span>.
            </span>
          </label>

          {error && <p className="m-0 text-[12px] text-brand-red" role="alert">{error}</p>}

          <div className="flex justify-end gap-2 pt-3 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} disabled={saving}>Cancel</Btn>
            <Btn type="submit" disabled={!canApply}>
              {saving ? 'Applying…' : aggregate.total === null ? 'Apply' : `Apply ${formatQuantity(aggregate.total)} ${item.unit}`}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
