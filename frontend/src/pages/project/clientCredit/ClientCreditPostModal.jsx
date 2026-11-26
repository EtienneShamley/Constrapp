import { useState } from 'react'
import Btn from '../../../components/Btn'
import WriteFeedback from '../../../components/WriteFeedback'
import { useWriteAction } from '../../../hooks/useWriteAction'
import { formatCurrency } from '../../../lib/formatters'
import { toCents, fromCents } from '../../../lib/money'
import { hasRetention } from '../../../lib/clientInvoices'
import {
  clientCreditPostBlockedReason, CLIENT_ENTRY_STALE_TEXT,
} from '../../../lib/clientCreditNotes'
import ReceivableDialog from './ReceivableDialog'

// ── Post a DRAFT Client Credit Note ──────────────────────────────────────────
//
// Posting is separate from the draft: it is the step that reduces net Issued
// and the receivable, and it moves the invoice's ledger in the same
// transaction (Firestore Rules refuse either half without the other).
//
// A draft prepared against an EARLIER ledger state is refused rather than
// silently recalculated. "Refresh figures" re-saves the draft with the same
// lines and details against the current ledger; the user then reads the
// refreshed figures and posts.
//
// THE SERVER DECIDES. The check below (`clientCreditPostBlockedReason`) is a
// convenience over the records this page has loaded; the write itself can
// still be refused, and its message — already written for the user — is shown
// by WriteFeedback. When that message is the stale-draft text, the dialog
// offers "Refresh figures" exactly as it does for its own pre-check, and keeps
// offering it (with Post disabled) until the draft has actually been re-saved.
//
// `ledgerUnavailable` — the ledger read failed, so whether this draft is still
// current is UNKNOWN: posting is disabled rather than assumed safe.

const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'

function Figure({ label, value }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <p className="m-0 text-[14px] font-bold text-brand-text tabular-nums">{value}</p>
    </div>
  )
}

export default function ClientCreditPostModal({
  creditNote, invoice, ledgerDoc, ledgerUnavailable = false, remaining = null,
  currencyCode, onClose, onConfirm, onRefresh,
}) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const write = useWriteAction('Client credit note posting')
  const [action, setAction] = useState('post')

  const blocked = ledgerUnavailable
    ? 'The invoice ledger could not be loaded, so it is not known whether this draft is still current. Reload the page before posting.'
    : clientCreditPostBlockedReason(creditNote, invoice, ledgerDoc)
  // The draft AS IT STANDS NOW: re-saving it (Refresh figures) changes this.
  const draftKey = `${creditNote.id}/${creditNote.ledgerSeq ?? ''}/${creditNote.updatedAt?.toMillis?.() ?? ''}`
  const [refusedKey, setRefusedKey] = useState(null)
  if (write.message === CLIENT_ENTRY_STALE_TEXT && refusedKey !== draftKey) setRefusedKey(draftKey)
  const refusedStale = refusedKey === draftKey
  const stale = blocked === CLIENT_ENTRY_STALE_TEXT || refusedStale

  const remainingAfterCents = remaining !== null
    ? toCents(remaining) - toCents(creditNote.receivableTotal)
    : null

  function submit(e) {
    e.preventDefault()
    if (blocked || refusedStale) return
    setAction('post')
    write.run(() => onConfirm(creditNote), { onConfirmed: onClose })
  }

  // Not a retry of anything: one explicit re-save of the draft, after which the
  // dialog stays open on the refreshed figures.
  function refresh() {
    setAction('refresh')
    write.run(() => onRefresh(creditNote))
  }

  return (
    <ReceivableDialog title={`Post ${creditNote.creditNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          Posting applies this credit to <span className="font-semibold text-brand-text">{creditNote.invoiceNumber}</span>:
          net Issued falls and Available to Invoice rises by the ex-GST amount, and the amount receivable falls.
          The contract sum does not change and no cash moves. A posted credit note can only be voided, never edited.
        </p>
        <div className="grid grid-cols-3 gap-3 rounded-lg border border-brand-border p-3">
          <Figure label="Subtotal (ex-GST)" value={money(creditNote.subtotal)} />
          <Figure label="GST" value={money(creditNote.gstTotal)} />
          <Figure label="Credit total" value={money(creditNote.grossTotal)} />
        </div>
        {hasRetention(invoice) && (
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-brand-border p-3">
            <Figure label="Reduces retention held" value={money(creditNote.retentionTotal)} />
            <Figure label="Reduces receivable now" value={money(creditNote.receivableTotal)} />
          </div>
        )}
        <p className="m-0 text-[12px] text-brand-muted">
          Dated {creditNote.creditDate || '—'} · {creditNote.reason}
        </p>

        {!blocked && remainingAfterCents !== null && remainingAfterCents < 0 && (
          <p className="m-0 text-[12px] text-brand-amber">
            ⚠ Posting leaves <span className="font-semibold">{money(fromCents(-remainingAfterCents))} owed to the
            client</span> on {creditNote.invoiceNumber}: more has been received than the invoice will then be owed.
            Constrap records no refund — the remedy is to void the receipt and re-record it with the surplus
            unallocated.
          </p>
        )}

        {blocked && <p className="m-0 text-[12px] text-brand-red">{blocked}</p>}
        {stale && (
          <div className="flex flex-wrap items-center gap-2">
            <Btn sm variant="ghost" type="button" onClick={refresh} disabled={write.locked}>Refresh figures</Btn>
            <p className="m-0 text-[11px] text-brand-muted">
              Re-saves this draft with the same lines against the invoice as it stands now. Check the refreshed
              figures above, then post.
            </p>
          </div>
        )}
        <WriteFeedback write={write} />
        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} sm disabled={write.busy}>{write.waiting ? 'Close' : 'Cancel'}</Btn>
          <Btn type="submit" sm disabled={write.locked || !!blocked || refusedStale}>
            {write.busy
              ? (action === 'refresh' ? 'Refreshing…' : 'Posting…')
              : write.waiting ? 'Waiting for confirmation…' : 'Post credit note'}
          </Btn>
        </div>
      </form>
    </ReceivableDialog>
  )
}
