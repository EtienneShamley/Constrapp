import { useState } from 'react'
import Btn from '../../../components/Btn'
import WriteFeedback from '../../../components/WriteFeedback'
import { useWriteAction } from '../../../hooks/useWriteAction'
import { formatCurrency } from '../../../lib/formatters'
import { clientReleasePostBlockedReason } from '../../../lib/clientRetention'
import { CLIENT_ENTRY_STALE_TEXT } from '../../../lib/clientCreditNotes'
import ReceivableDialog from '../clientCredit/ReceivableDialog'

// ── Post a DRAFT Client Retention Release ────────────────────────────────────
//
// Posting is the step that makes the retention receivable; it moves the
// invoice's ledger in the same transaction (Firestore Rules refuse either half
// without the other). A draft prepared against an EARLIER ledger state is
// refused, and "Refresh figures" re-saves it with the same amount and details
// against the current ledger before the user posts.
//
// THE SERVER DECIDES. The check below (`clientReleasePostBlockedReason`) is a
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

export default function ClientReleasePostModal({
  release, invoice, ledgerDoc, ledgerUnavailable = false,
  currencyCode, onClose, onConfirm, onRefresh,
}) {
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })
  const write = useWriteAction('Client retention release posting')
  const [action, setAction] = useState('post')

  const blocked = ledgerUnavailable
    ? 'The invoice ledger could not be loaded, so it is not known whether this draft is still current. Reload the page before posting.'
    : clientReleasePostBlockedReason(release, invoice, ledgerDoc)
  // The draft AS IT STANDS NOW: re-saving it (Refresh figures) changes this.
  const draftKey = `${release.id}/${release.ledgerSeq ?? ''}/${release.updatedAt?.toMillis?.() ?? ''}`
  const [refusedKey, setRefusedKey] = useState(null)
  if (write.message === CLIENT_ENTRY_STALE_TEXT && refusedKey !== draftKey) setRefusedKey(draftKey)
  const refusedStale = refusedKey === draftKey
  const stale = blocked === CLIENT_ENTRY_STALE_TEXT || refusedStale

  function submit(e) {
    e.preventDefault()
    if (blocked || refusedStale) return
    setAction('post')
    write.run(() => onConfirm(release), { onConfirmed: onClose })
  }

  // One explicit re-save of the draft; the dialog stays open on the refreshed
  // figures.
  function refresh() {
    setAction('refresh')
    write.run(() => onRefresh(release))
  }

  return (
    <ReceivableDialog title={`Post ${release.releaseNumber}`} onClose={onClose}>
      <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3.5">
        <p className="m-0 text-[12.5px] text-brand-muted">
          Posting makes this retention receivable on{' '}
          <span className="font-semibold text-brand-text">{release.invoiceNumber}</span>: it leaves retention held
          and joins the invoice balance, to be settled by an ordinary Client Receipt. A release is not an invoice,
          a credit note or a receipt — nothing new is billed and no cash moves. A posted release can only be voided,
          never edited.
        </p>
        <div className="grid grid-cols-3 gap-3 rounded-lg border border-brand-border p-3">
          <Figure label="Released (ex-GST)" value={money(release.amount)} />
          <Figure label="GST" value={money(release.gstAmount)} />
          <Figure label="Becomes receivable" value={money(release.releaseTotal)} />
        </div>
        <p className="m-0 text-[12px] text-brand-muted">
          Dated {release.releaseDate || '—'} · {release.reason}
        </p>

        {blocked && <p className="m-0 text-[12px] text-brand-red">{blocked}</p>}
        {stale && (
          <div className="flex flex-wrap items-center gap-2">
            <Btn sm variant="ghost" type="button" onClick={refresh} disabled={write.locked}>Refresh figures</Btn>
            <p className="m-0 text-[11px] text-brand-muted">
              Re-saves this draft with the same amount against the invoice as it stands now. Check the refreshed
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
              : write.waiting ? 'Waiting for confirmation…' : 'Post release'}
          </Btn>
        </div>
      </form>
    </ReceivableDialog>
  )
}
