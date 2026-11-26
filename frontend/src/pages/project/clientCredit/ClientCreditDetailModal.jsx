import Badge from '../../../components/Badge'
import Btn from '../../../components/Btn'
import { formatCurrency, formatDate } from '../../../lib/formatters'
import { CCN_BADGE_VARIANTS } from '../../../lib/clientCreditNotes'
import { buildClientCreditNotePrint, POSTED_BY_UNRECORDED } from './clientCreditNotePrintModel'
import ReceivableDialog from './ReceivableDialog'

// ── Read-only Client Credit Note ─────────────────────────────────────────────
//
// The credit note as it is stored, following the client invoice detail
// modal's pattern. It is built from the SAME model as the printed document
// (clientCreditNotePrintModel.js), so the screen and the print cannot
// disagree, and like it shows stored fields only — nothing is re-added here.
//
// No write is started from this dialog: Edit, Post and Void stay on the
// register row. "Print" hands the credit note to the page, which mounts the
// print-only document (ClientCreditNotePrint.jsx).

const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'

const stampDate = (ts) => (ts && typeof ts.toDate === 'function' ? formatDate(ts) : '—')

function DetailRow({ label, children }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <div className="m-0 text-[13px] text-brand-text break-words">{children || '—'}</div>
    </div>
  )
}

export default function ClientCreditDetailModal({ creditNote, invoice, currencyCode, people, onClose, onPrint }) {
  const doc = buildClientCreditNotePrint({ creditNote, invoice, people })
  const money = (n) => (n === null ? '—' : formatCurrency(n, doc.currencyCode || currencyCode, { precise: true }))

  return (
    <ReceivableDialog wide title={`${doc.number} — ${doc.statusLabel}`} onClose={onClose}>
      <div className="px-5 py-4 flex flex-col gap-3.5">
        {/* Draft / void: said in words, not by the badge colour alone. */}
        {doc.statusNotice && (
          <p className="m-0 rounded-lg border border-brand-border px-3 py-2 text-[12.5px] font-bold text-brand-text">
            {doc.statusNotice}
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
          <DetailRow label="Status">
            <Badge label={doc.statusLabel} variant={CCN_BADGE_VARIANTS[doc.status]} sm />
          </DetailRow>
          <DetailRow label="Credit Date">{doc.creditDate}</DetailRow>
          <DetailRow label="Client">{doc.clientName}</DetailRow>
          <DetailRow label="Invoice Corrected">{doc.invoice.number}</DetailRow>
          <DetailRow label="Invoice Date">{doc.invoice.date}</DetailRow>
          <DetailRow label="External Credit Reference">{doc.externalReference}</DetailRow>
        </div>
        <DetailRow label="Reason">{doc.reason}</DetailRow>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-brand-card border-b border-brand-border">
                <th scope="col" className={thCls}>Description</th>
                <th scope="col" className={thCls}>Tax</th>
                <th scope="col" className={`${thCls} text-right`}>Ex-GST</th>
                <th scope="col" className={`${thCls} text-right`}>GST</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map(line => (
                <tr key={line.key} className="border-b border-brand-border">
                  <td className="px-3.5 py-2.5 text-[13px] text-brand-text">
                    {line.description}
                    {line.variationNumber && <span className="block text-[11px] text-brand-muted">{line.variationNumber}</span>}
                  </td>
                  <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{line.taxLabel}</td>
                  <td className="px-3.5 py-2.5 text-[13px] text-brand-text text-right tabular-nums whitespace-nowrap">{money(line.amount)}</td>
                  <td className="px-3.5 py-2.5 text-[13px] text-brand-muted text-right tabular-nums whitespace-nowrap">{money(line.gstAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col items-end gap-1 text-[13px] text-brand-text border-t border-brand-border pt-3">
          {doc.totals.map(row => (
            <p key={row.key} className={`m-0 ${row.strong ? 'font-bold' : ''}`}>
              {row.label} <span className="ml-2 tabular-nums">{money(row.amount)}</span>
            </p>
          ))}
          {doc.retentionSplit?.map(row => (
            <p key={row.key} className="m-0 text-brand-muted">
              {row.label} <span className="ml-2 tabular-nums text-brand-text">{money(row.amount)}</span>
            </p>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 border-t border-brand-border pt-3">
          <DetailRow label="Posted">
            {doc.posted
              ? <>{stampDate(doc.posted.at)}<span className="block text-[12px] text-brand-muted">By {doc.posted.byName || POSTED_BY_UNRECORDED}</span></>
              : 'Not posted'}
          </DetailRow>
          {doc.voided && <DetailRow label="Voided">{stampDate(doc.voided.at)}</DetailRow>}
          {doc.voided && <DetailRow label="Void Reason">{doc.voided.reason}</DetailRow>}
        </div>

        <p className="m-0 text-[11px] text-brand-muted border-t border-brand-border pt-3">{doc.disclaimer}</p>

        <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
          <Btn variant="ghost" type="button" sm onClick={onClose}>Close</Btn>
          <Btn type="button" sm onClick={onPrint}>Print / Save as PDF</Btn>
        </div>
      </div>
    </ReceivableDialog>
  )
}
