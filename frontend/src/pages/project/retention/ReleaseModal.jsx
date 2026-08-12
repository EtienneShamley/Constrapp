import { useState, useMemo } from 'react'
import Btn from '../../../components/Btn'
import { formatCurrency } from '../../../lib/formatters'
import { todayIso } from '../../../lib/payments'
import {
  releaseTotals, releasedExGstForInvoice, remainingRetentionExGst, validateReleaseDraft,
  RETENTION_RELEASE_CONCURRENCY_NOTICE,
} from '../../../lib/retention'

// ── Release retention on one supplier invoice ────────────────────────────────
//
// A Retention Release is an INTERNAL COMMERCIAL AUTHORISATION that makes
// already-withheld retention payable. It is not a supplier invoice, a tax
// invoice, a credit note, or a payment, and it moves no cash by itself — the
// released amount becomes part of the invoice's payable and is then settled by
// an ordinary Supplier Payment.
//
// ⚠️ THE CUMULATIVE CAP IS HARD-BLOCKED HERE. Releasing more than the retention
// still available is refused outright — there is no acknowledgement override,
// because the normal UI must never knowingly create an over-release. This is a
// correctness guard, NOT the security boundary: Firestore rules cannot sum
// sibling releases, so two people releasing the same retention simultaneously
// can still both succeed (docs/SECURITY.md → Deferred Control 24).

const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'

function Row({ label, value, strong, muted }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className={`text-[12px] ${muted ? 'text-brand-muted' : 'text-brand-muted'}`}>{label}</span>
      <span className={`text-[12.5px] tabular-nums ${strong ? 'font-bold text-brand-text' : 'text-brand-text'}`}>{value}</span>
    </div>
  )
}

export default function ReleaseModal({
  invoice, release = null, releases, currencyCode, onSave, onClose,
}) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const editing = !!release

  // What has already been released, EXCLUDING the draft being edited so it never
  // counts itself. This is also the `previouslyReleasedAmount` snapshot the hook
  // will store — it is derived, never authored by the user.
  const alreadyReleased = useMemo(
    () => releasedExGstForInvoice(releases, invoice.id, { excludeReleaseId: release?.id ?? null }),
    [releases, invoice.id, release],
  )
  const available = useMemo(
    () => remainingRetentionExGst(invoice, alreadyReleased),
    [invoice, alreadyReleased],
  )

  const [amount, setAmount]           = useState(release ? String(release.amount) : '')
  const [releaseDate, setReleaseDate] = useState(release?.releaseDate || todayIso())
  const [reason, setReason]           = useState(release?.reason || '')
  const [notes, setNotes]             = useState(release?.notes || '')
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState(null)

  // Live derived GST/total using the exact cumulative-delta model that both the
  // hook and Firestore rules apply — so what is previewed is what is stored.
  const preview = useMemo(
    () => releaseTotals(alreadyReleased, Number(amount) || 0),
    [alreadyReleased, amount],
  )

  const validationError = validateReleaseDraft({
    supplierInvoiceId: invoice.id,
    amount, releaseDate, reason,
    invoices: [invoice],
    releases,
    excludeReleaseId: release?.id ?? null,
  })
  const blocked = !!validationError

  async function submit(e) {
    e.preventDefault()
    if (validationError) { setError(validationError); return }
    setSaving(true); setError(null)
    try {
      await onSave({ invoice, releaseDate, amount: Number(amount), reason, notes })
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[560px] my-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">
            {editing ? 'Edit retention release' : 'Release retention'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={submit} className="p-5">
          {/* Context — what is held on this invoice right now. */}
          <div className="bg-brand-bg border border-brand-border rounded-lg p-3.5">
            <p className="m-0 text-[12.5px] font-semibold text-brand-text">
              {invoice.invoiceNumber}
              {invoice.supplierInvoiceNumber ? ` · ${invoice.supplierInvoiceNumber}` : ''}
            </p>
            <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">{invoice.supplierName || '—'}</p>
            <div className="mt-2.5 pt-2.5 border-t border-brand-border">
              <Row label="Retention withheld (ex-GST)" value={money(invoice.retention)} />
              <Row label="Retention GST" value={money(invoice.retentionGst)} />
              <Row label="Retention withheld (total)" value={money(invoice.retentionTotal)} />
              <Row label="Already released (ex-GST)" value={money(alreadyReleased)} />
              <Row label="Available to release (ex-GST)" value={money(available)} strong />
            </div>
          </div>

          {/* Amount */}
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1.5">
              <label className={`${labelCls} mb-0`}>Release amount (ex-GST) *</label>
              <button
                type="button"
                onClick={() => setAmount(String(available))}
                disabled={available <= 0}
                className="text-[11px] font-bold text-brand-accent hover:opacity-80 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Release all remaining
              </button>
            </div>
            <input
              type="number" min="0" step="0.01"
              className={inputCls}
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {/* Derived GST and total — never editable: GST is the cumulative
                rounding delta, which is what makes partial releases sum exactly
                to the invoice's stored retention GST. */}
            <div className="mt-2 px-3 py-2 bg-brand-bg border border-brand-border rounded-lg">
              <Row label="GST on this release (derived)" value={money(preview.gstAmount)} />
              <Row label="Becomes payable on this invoice" value={money(preview.releaseTotal)} strong />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            <div>
              <label className={labelCls}>Release date *</label>
              <input
                type="date"
                className={inputCls}
                value={releaseDate}
                onChange={(e) => setReleaseDate(e.target.value)}
              />
              <p className="m-0 mt-1 text-[10.5px] text-brand-muted">
                The date this release was agreed — not a defects-liability or payment due date.
              </p>
            </div>
            <div>
              <label className={labelCls}>Reason *</label>
              <input
                className={inputCls}
                placeholder="e.g. Practical completion — first moiety"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-3">
            <label className={labelCls}>Notes</label>
            <input
              className={inputCls}
              placeholder="Optional"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <p className="m-0 mt-4 text-[11px] text-brand-muted">
            A retention release is an internal commercial authorisation — not a supplier invoice, tax invoice,
            credit note, or payment. Posting it makes {money(preview.releaseTotal)} payable on {invoice.invoiceNumber};
            the money moves only when a Supplier Payment is posted against it.
          </p>
          <p className="m-0 mt-1.5 text-[10.5px] text-brand-muted">{RETENTION_RELEASE_CONCURRENCY_NOTICE}</p>

          {(error || (validationError && amount !== '')) && (
            <p className="m-0 mt-3 text-[12px] text-brand-red">{error || validationError}</p>
          )}

          <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose}>Cancel</Btn>
            <Btn type="submit" disabled={saving || blocked}>
              {saving ? 'Saving…' : editing ? 'Save draft' : 'Save draft release'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
