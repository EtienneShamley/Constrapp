import { formatCurrency, formatDate } from '../../../lib/formatters'
import { formatIsoDate } from '../../../lib/projectTimeline'
import { buildClientCreditNotePrint, POSTED_BY_UNRECORDED } from './clientCreditNotePrintModel'

// ── Printed Client Credit Note ───────────────────────────────────────────────
//
// ONE credit note as a document, for the browser's own Print / Save as PDF.
// Like the GANTT™ Programme Report (ADR-79) it exists only for printing: the
// Client Invoices page mounts it while a print is in progress (usePrintMoment)
// and it is never shown on screen (`.credit-note-print` in index.css).
//
// It reuses the L2-A report print standard: the `.commercial-report` scope
// swaps the dark tokens for the ink palette and hides the app chrome, and
// `.report-table` repeats the header row and keeps a row from splitting. The
// only difference is the page: A4 PORTRAIT (index.css).
//
// PRESENTATION ONLY over clientCreditNotePrintModel.js: every amount is a
// stored field, formatted here and nowhere re-added. No hook, no read, no
// write — printing posts, voids or changes nothing.

const stamp = (date) => date.toLocaleString('en-AU', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
})

// A Firestore Timestamp → the app's date format. A stamp the server has not
// answered yet (or one that is absent) is "—", never a guessed date.
const stampDate = (ts) => (ts && typeof ts.toDate === 'function' ? formatDate(ts) : '—')

const labelCls = 'm-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted'
const valueCls = 'm-0 mt-0.5 text-[12.5px] text-brand-text break-words'
const thCls = 'px-2 py-2 text-left text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted'
const tdCls = 'px-2 py-2 align-top text-[12px] text-brand-text'
const moneyCls = `${tdCls} text-right whitespace-nowrap tabular-nums`

function Field({ label, children }) {
  return (
    <div className="report-figure min-w-0">
      <dt className={labelCls}>{label}</dt>
      <dd className={valueCls}>{children}</dd>
    </div>
  )
}

export default function ClientCreditNotePrint({ creditNote, invoice, projectName, currencyCode, people, generatedAt }) {
  const doc = buildClientCreditNotePrint({ creditNote, invoice, projectName, people })
  if (!doc) return null
  const money = (n) => (n === null ? '—' : formatCurrency(n, doc.currencyCode || currencyCode, { precise: true }))

  return (
    <article className="commercial-report credit-note-print flex-col gap-4" aria-labelledby="credit-note-print-title">
      <header className="report-header rounded-xl border border-brand-border p-4">
        <p className="m-0 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-accent">
          Constrap · {doc.projectName || 'Project'}
        </p>
        <h1 id="credit-note-print-title" className="m-0 mt-1 break-words text-xl font-semibold text-brand-text">
          {doc.title} {doc.number}
        </h1>
        <p className="m-0 mt-1 text-[12.5px] text-brand-text-soft">
          Status <span className="font-bold text-brand-text">{doc.statusLabel}</span>
          <span aria-hidden="true"> · </span>
          Credit date <span className="font-bold text-brand-text">{formatIsoDate(doc.creditDate)}</span>
        </p>
        {/* Draft / void: stated in words, in a ruled box — never colour alone. */}
        {doc.statusNotice && (
          <p className="m-0 mt-2 rounded-lg border-2 border-brand-text px-3 py-2 text-[13px] font-black text-brand-text">
            {doc.statusNotice}
          </p>
        )}
      </header>

      <section className="report-card rounded-xl border border-brand-border p-4" aria-label="Credit note details">
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3">
          <Field label="Client">{doc.clientName || '—'}</Field>
          <Field label="Invoice corrected">
            {doc.invoice.number || '—'}
            <span className="block text-brand-muted">
              Invoice date {doc.invoice.date ? formatIsoDate(doc.invoice.date) : 'not available'}
            </span>
          </Field>
          <div className="col-span-2">
            <Field label="Reason">{doc.reason || '—'}</Field>
          </div>
          {doc.externalReference && (
            <Field label="External credit reference">{doc.externalReference}</Field>
          )}
        </dl>
      </section>

      <section className="report-card rounded-xl border border-brand-border p-4" aria-labelledby="credit-note-print-lines">
        <h2 id="credit-note-print-lines" className="m-0 mb-2 text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted">
          Credited lines
        </h2>
        {doc.lines.length === 0 ? (
          <p className="m-0 text-[12.5px] text-brand-muted">This credit note carries no lines.</p>
        ) : (
          <div className="report-table-wrap">
            <table className="report-table w-full border-collapse">
              <caption className="sr-only">
                Lines credited by {doc.title} {doc.number}. Amounts exclude GST; GST is shown separately.
              </caption>
              <thead>
                <tr className="border-b border-brand-border">
                  <th scope="col" className={thCls}>Description</th>
                  <th scope="col" className={thCls}>Tax code</th>
                  <th scope="col" className={`${thCls} text-right`}>Amount (ex-GST)</th>
                  <th scope="col" className={`${thCls} text-right`}>GST</th>
                </tr>
              </thead>
              <tbody>
                {doc.lines.map(line => (
                  <tr key={line.key} className="border-b border-brand-border">
                    <td className={`${tdCls} break-words`}>
                      {line.description}
                      {line.variationNumber && <span className="block text-brand-muted">{line.variationNumber}</span>}
                    </td>
                    <td className={`${tdCls} whitespace-nowrap`}>{line.taxLabel}</td>
                    <td className={moneyCls}>{money(line.amount)}</td>
                    <td className={moneyCls}>{money(line.gstAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <dl className="report-figure m-0 mt-3 ml-auto w-[62%] text-[12.5px] text-brand-text">
          {doc.totals.map(row => (
            <div key={row.key} className={`flex justify-between gap-4 py-1 ${row.strong ? 'border-t border-brand-border font-bold' : ''}`}>
              <dt>{row.label}</dt>
              <dd className="m-0 whitespace-nowrap tabular-nums">{money(row.amount)}</dd>
            </div>
          ))}
          {doc.retentionSplit && (
            <>
              <div className="mt-1 border-t border-brand-border pt-1 text-[11px] text-brand-muted">
                Of the credit total, as recorded when this credit note was saved:
              </div>
              {doc.retentionSplit.map(row => (
                <div key={row.key} className="flex justify-between gap-4 py-1">
                  <dt>{row.label}</dt>
                  <dd className="m-0 whitespace-nowrap tabular-nums">{money(row.amount)}</dd>
                </div>
              ))}
            </>
          )}
        </dl>
      </section>

      <section className="report-card rounded-xl border border-brand-border p-4" aria-label="Record">
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3">
          {doc.posted ? (
            <Field label="Posted">
              {stampDate(doc.posted.at)}
              <span className="block text-brand-muted">By {doc.posted.byName || POSTED_BY_UNRECORDED}</span>
            </Field>
          ) : (
            <Field label="Posted">Not posted</Field>
          )}
          {doc.voided && (
            <Field label="Voided">
              {stampDate(doc.voided.at)}
              <span className="block">Reason: {doc.voided.reason || 'not recorded'}</span>
            </Field>
          )}
        </dl>
        <p className="report-footnote m-0 mt-3 text-[11.5px] text-brand-text-soft">{doc.disclaimer}</p>
        <p className="m-0 mt-1 text-[11px] text-brand-muted">
          Amounts are in {doc.currencyCode || currencyCode}. Printed{' '}
          <time dateTime={generatedAt.toISOString()}>{stamp(generatedAt)}</time> from the record as it stood at that
          time — printing changes nothing.
        </p>
      </section>
    </article>
  )
}
