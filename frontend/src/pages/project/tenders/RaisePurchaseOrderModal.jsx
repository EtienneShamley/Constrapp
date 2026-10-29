import { useEffect, useRef, useState } from 'react'
import Btn from '../../../components/Btn'
import Badge from '../../../components/Badge'
import { formatCurrency } from '../../../lib/formatters'
import { PO_STATUS_LABELS, PO_BADGE_VARIANTS } from '../../../lib/purchaseOrders'
import { RAISE_STATE, SUPPLIER_STATE } from '../../../lib/awardToPo'
import { tabbableWithin, tabTarget } from '../../../lib/dialogFocus'

// ── Raise purchase order from an award — the REVIEW dialog (M3-A, ADR-61) ───
//
// Presentation only. It renders the proposal lib/awardToPo.js built from the
// awarded package, its winning bid, the live cost-code library and contacts,
// and the PO register — every line, the derived header, the bid's exclusions
// and notes (shown, never copied into the PO), every blocker and warning —
// and asks for ONE explicit confirmation. Confirming creates a DRAFT through
// the hook's guarded transaction; nothing here sends a PO.

const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1'
const thCls    = 'text-left px-3 py-2 text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

function Field({ label, children }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <div className="text-[13px] text-brand-text break-words">{children}</div>
    </div>
  )
}

export default function RaisePurchaseOrderModal({ pkg, bid, proposal, currencyCode, onClose, onConfirm }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)
  const panelRef = useRef(null)

  const isReRaise = proposal.linked.state === RAISE_STATE.CANCELLED
  const canConfirm = proposal.ok && !saving

  // Dialog semantics: initial focus on the panel, Escape closes (not while
  // saving), Tab / Shift+Tab stay inside (lib/dialogFocus.js — the Quant 1B
  // convention), focus returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement
    panelRef.current?.focus()
    return () => { if (opener && typeof opener.focus === 'function') opener.focus() }
  }, [])

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && !saving) { e.preventDefault(); onClose(); return }
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

  async function handleConfirm() {
    if (!canConfirm) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm()
      // The parent navigates away on success; nothing else to do here.
    } catch (err) {
      setError(err?.message || 'The purchase order was not created. Check your connection and try again.')
      setSaving(false)
    }
  }

  const supplierStatus = proposal.supplier.state === SUPPLIER_STATE.OK
    ? (proposal.supplier.typeOk ? 'Active supplier contact' : 'Active contact — no longer typed supplier / subcontractor')
    : proposal.supplier.state === SUPPLIER_STATE.ARCHIVED ? 'Archived in Contacts' : 'Not found in Contacts'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/60" onClick={saving ? undefined : onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="raise-po-title"
        className="relative z-10 w-full max-w-[820px] max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl outline-none"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 id="raise-po-title" className="text-[15px] font-bold text-brand-text m-0">
            {isReRaise ? 'Raise purchase order again' : 'Raise purchase order'} — {pkg.tenderNumber}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center disabled:opacity-40"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          <p className="m-0 text-[12.5px] text-brand-muted">
            This creates a <span className="font-semibold text-brand-text">draft</span> purchase order from the awarded
            bid. Nothing is committed and nothing is sent to the supplier: the draft opens on the Purchase Orders tab,
            where you review it, edit it if needed, and send it as usual. Sending is the point at which it enters Committed.
          </p>

          {isReRaise && proposal.linked.current && (
            <p className="m-0 text-[12px] text-brand-amber">
              {proposal.linked.current.poNumber} was raised from this award earlier and is cancelled. It keeps its
              source record; this award will now link to the new draft instead.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-lg border border-brand-border bg-brand-bg px-3.5 py-3">
            <Field label="Source">
              <p className="m-0 font-semibold">{pkg.tenderNumber} — {pkg.name}</p>
              <p className="m-0 text-[11px] text-brand-muted">
                Bid received {bid.bidDate || '—'}{proposal.bidderRef ? ` · ref ${proposal.bidderRef}` : ''}
              </p>
            </Field>
            <Field label="Supplier">
              <p className="m-0 font-semibold">{proposal.supplierName || '—'}</p>
              <p className="m-0 text-[11px] text-brand-muted">{supplierStatus}</p>
            </Field>
            <Field label="Proposed description">
              <p className="m-0">{proposal.description}</p>
              <p className="m-0 text-[11px] text-brand-muted">Editable in the draft</p>
            </Field>
          </div>

          <div>
            <p className={labelCls}>Lines ({proposal.lineItems.length}) — one per bid line, ex-GST</p>
            <div className="overflow-x-auto rounded-lg border border-brand-border">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-brand-card border-b border-brand-border">
                    {['Cost code', 'Description', 'Qty', 'Rate', 'Line total'].map((h, i) => (
                      <th key={i} className={`${thCls} ${i >= 2 ? 'text-right' : ''}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {proposal.lineItems.map((li, idx) => (
                    <tr key={idx} className="border-b border-brand-border last:border-b-0">
                      <td className="px-3 py-2 text-[12.5px] text-brand-text whitespace-nowrap">
                        {li.costCodeName || <span className="text-brand-red">Unknown cost code</span>}
                      </td>
                      <td className="px-3 py-2 text-[12.5px] text-brand-muted">{li.description || '—'}</td>
                      <td className="px-3 py-2 text-[12.5px] text-brand-text text-right">{li.qty}</td>
                      <td className="px-3 py-2 text-[12.5px] text-brand-text text-right whitespace-nowrap">{money(li.unitPrice)}</td>
                      <td className="px-3 py-2 text-[12.5px] font-semibold text-brand-text text-right whitespace-nowrap">{money(li.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              A bid line is a lump sum, so each becomes quantity 1 at the bid amount. Quantities, units and rates can be
              refined in the draft.
            </p>
          </div>

          <div className="flex flex-col items-end gap-0.5 text-[13px] text-brand-text">
            <p className="m-0">
              Subtotal <span className="font-semibold ml-2">{money(proposal.totals.subtotal)}</span>
              {proposal.awardedTotal != null && (
                <span className="ml-2 text-[11px] text-brand-muted">
                  {proposal.totals.subtotal === proposal.awardedTotal ? '= awarded bid value' : `awarded bid value ${money(proposal.awardedTotal)}`}
                </span>
              )}
            </p>
            <p className="m-0 text-brand-muted">GST 10% <span className="ml-2">{money(proposal.totals.gst)}</span></p>
            <p className="m-0 font-bold">Total <span className="ml-2">{money(proposal.totals.total)}</span></p>
            <p className="m-0 text-[11px] text-brand-muted">{currencyCode} · GST is added at commitment; the bid carried none.</p>
          </div>

          {(proposal.exclusions || proposal.bidNotes) && (
            <div className="rounded-lg border border-brand-amber/40 bg-brand-amber/5 px-3.5 py-3 flex flex-col gap-2">
              {proposal.exclusions && (
                <Field label="Bid exclusions — not copied into the purchase order">
                  <p className="m-0 whitespace-pre-wrap">{proposal.exclusions}</p>
                </Field>
              )}
              {proposal.bidNotes && (
                <Field label="Bid notes — not copied into the purchase order">
                  <p className="m-0 whitespace-pre-wrap">{proposal.bidNotes}</p>
                </Field>
              )}
              <p className="m-0 text-[11px] text-brand-muted">
                Read these before sending: anything the supplier excluded is not in the draft unless you add it.
              </p>
            </div>
          )}

          {proposal.sameSupplier.length > 0 && (
            <div className="rounded-lg border border-brand-border px-3.5 py-3">
              <p className="m-0 text-[12px] font-bold text-brand-amber">Possible duplicate — please check</p>
              <ul className="m-0 mt-1 pl-4 text-[12px] text-brand-text">
                {proposal.sameSupplier.map(po => (
                  <li key={po.id}>
                    {po.poNumber} · {po.description || '—'} · {money(po.subtotal || 0)} ex-GST{' '}
                    <Badge label={PO_STATUS_LABELS[po.status] ?? po.status} variant={PO_BADGE_VARIANTS[po.status]} sm />
                  </li>
                ))}
              </ul>
              <p className="m-0 mt-1 text-[11px] text-brand-muted">
                These purchase orders go to the same supplier on this project. Constrapp cannot tell whether they cover
                the same scope — this is a prompt to check, not a finding.
              </p>
            </div>
          )}

          {proposal.warnings.length > 0 && (
            <ul className="m-0 pl-4 text-[12px] text-brand-amber">
              {proposal.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          {proposal.blockers.length > 0 && (
            <ul className="m-0 pl-4 text-[12px] text-brand-red">
              {proposal.blockers.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          )}
          {error && <p className="m-0 text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-3 border-t border-brand-border">
            <Btn variant="ghost" type="button" sm onClick={onClose} disabled={saving}>Cancel</Btn>
            <Btn type="button" sm onClick={handleConfirm} disabled={!canConfirm}>
              {saving ? 'Creating draft…' : 'Create draft purchase order'}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
