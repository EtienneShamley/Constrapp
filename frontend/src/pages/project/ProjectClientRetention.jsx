import { useMemo, useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import Card from '../../components/Card'
import Badge from '../../components/Badge'
import Btn from '../../components/Btn'
import Stat from '../../components/Stat'
import { useProfile } from '../../hooks/useProfile'
import { useCompany } from '../../hooks/useCompany'
import { useClientInvoices } from '../../hooks/useClientInvoices'
import { useClientReceipts } from '../../hooks/useClientReceipts'
import { useClientCreditNotes } from '../../hooks/useClientCreditNotes'
import { useClientRetentionReleases } from '../../hooks/useClientRetentionReleases'
import { useClientRefunds } from '../../hooks/useClientRefunds'
import { useClientReceiptApplications } from '../../hooks/useClientReceiptApplications'
import { useClientInvoiceLedgers } from '../../hooks/useClientInvoiceLedgers'
import { formatCurrency } from '../../lib/formatters'
import { isFinancialRole } from '../../lib/margin'
import { clientInvoiceReconciliationRows } from '../../lib/clientReceipts'
import { CLIENT_CREDIT_READ_UNAVAILABLE_NOTICE } from '../../lib/clientCreditNotes'
import { receivableContext, clientRetentionRows, ledgerExceptions } from '../../lib/clientReceivables'
import {
  CRR_STATUS, CRR_STATUS_LABELS, CRR_BADGE_VARIANTS,
  clientReleaseExceptions,
  CLIENT_RETENTION_HELD_NOTICE, CLIENT_RETENTION_RELEASED_NOTICE,
  CLIENT_RETENTION_READ_UNAVAILABLE_NOTICE,
} from '../../lib/clientRetention'
import { clientFinanceActivated, CLIENT_FINANCE_NOT_ACTIVATED_TEXT } from '../../lib/clientFinanceActivation'
import ClientReleaseModal from './clientRetention/ClientReleaseModal'
import ClientReleasePostModal from './clientRetention/ClientReleasePostModal'
import ClientReleaseVoidModal from './clientRetention/ClientReleaseVoidModal'

// ── Client Retention register (ADR-88) ───────────────────────────────────────
//
// Retention the CLIENT withheld on issued client invoices, and the releases
// that make it receivable. The receivable-side mirror of the Supplier
// Retention register.
//
// Everything on this page is DERIVED at read time from issued client invoices,
// posted client credit notes and posted client retention releases, through the
// ONE receivable contract (lib/clientReceivables.js). Nothing is written onto
// an invoice. The only thing this page authors is a Client Retention Release —
// an authorisation, not an invoice, a credit note or a receipt.
//
// ⚠️ A FAILED READ IS UNKNOWN, NEVER ZERO. Retention held depends on the
// invoices, on posted releases AND on posted credit notes (a credit reduces
// the retention still held). If any of the three cannot be read, every figure
// renders "Unavailable" and releasing is disabled. The ledgers are needed to
// build or post a draft, so a failed ledger read disables those actions too.

const thCls   = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px] whitespace-nowrap'
const thRight = `${thCls} text-right`
const tdCls   = 'px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap'
const tdMoney = 'px-3.5 py-2.5 text-[13px] tabular-nums text-right whitespace-nowrap'

const cents = (n) => Math.round((Number(n) || 0) * 100)

// ── Activation gate ──────────────────────────────────────────────────────────
// Client retention is released per company (lib/clientFinanceActivation.js).
// The sub-tab is hidden for a company that is not activated; this is what the
// route shows if it is opened directly. The register below — and every read it
// makes — mounts only for an activated company.
//
// UX only: Firestore Rules and the backend refuse the writes regardless.
// A company that is loading or could not be read is NOT activated. The profile
// is waited for as well, because the company provider is idle (no company, not
// loading) until the profile has resolved.
export default function ProjectClientRetention() {
  const { profileLoading } = useProfile()
  const { company, companyLoading } = useCompany()

  if (profileLoading || companyLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!clientFinanceActivated(company)) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Client retention is not available yet</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">{CLIENT_FINANCE_NOT_ACTIVATED_TEXT}</p>
      </Card>
    )
  }
  return <ClientRetentionRegister />
}

function ClientRetentionRegister() {
  const navigate = useNavigate()
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode, { precise: true })

  const { profile, profileLoading } = useProfile()
  const canView = isFinancialRole(profile?.role)
  // Non-financial roles never trigger the commercially-sensitive reads (rules
  // would deny them anyway — this is the UX mirror; rules are the boundary).
  const mid = canView ? projectId : null

  const { clientInvoices, clientInvoicesLoading, clientInvoicesError } = useClientInvoices(mid)
  const { clientReceipts, clientReceiptsLoading: receiptsLoading, clientReceiptsError: receiptsError } = useClientReceipts(mid)
  // Phase 2 step 5: what an invoice HOLDS also counts applications and refunds.
  const { clientRefunds, clientRefundsLoading, clientRefundsError } = useClientRefunds(mid)
  const {
    clientReceiptApplications, clientReceiptApplicationsLoading, clientReceiptApplicationsError,
  } = useClientReceiptApplications(mid)
  const clientReceiptsLoading = receiptsLoading || clientRefundsLoading || clientReceiptApplicationsLoading
  const clientReceiptsError = receiptsError || clientRefundsError || clientReceiptApplicationsError
  const { clientCreditNotes, clientCreditNotesLoading, clientCreditNotesError } = useClientCreditNotes(mid)
  const {
    clientRetentionReleases, clientRetentionReleasesLoading, clientRetentionReleasesError,
    createClientRetentionRelease, updateClientRetentionRelease,
    postClientRetentionRelease, voidClientRetentionRelease,
  } = useClientRetentionReleases(mid)
  const { clientInvoiceLedgers, clientInvoiceLedgersLoading, clientInvoiceLedgersError } = useClientInvoiceLedgers(mid)

  // Dialog targets are held as ids and resolved against the live lists, so a
  // dialog always shows the record as it stands now.
  const [releaseFor, setReleaseFor] = useState(null) // { invoiceId, releaseId? }
  const [postingId, setPostingId]   = useState(null)
  const [voidingId, setVoidingId]   = useState(null)

  // ⚠️ THE HONESTY GATE.
  const figuresUnavailable = clientInvoicesError || clientCreditNotesError || clientRetentionReleasesError
  const figuresLoading = clientInvoicesLoading || clientCreditNotesLoading || clientRetentionReleasesLoading
  const figuresKnown = !figuresUnavailable && !figuresLoading
  // Building or posting a draft needs the invoice's CURRENT ledger.
  const draftingUnavailable = !figuresKnown || clientInvoiceLedgersError || clientInvoiceLedgersLoading
  // Voiding a POSTED release is checked against what has been received — by
  // the server, when the void is written. The page still declines to offer it
  // while its own view of the receipts is unknown.
  const receivedUnknown = clientReceiptsError || clientReceiptsLoading

  const ctx = useMemo(
    () => receivableContext(clientInvoices, clientCreditNotes, clientRetentionReleases),
    [clientInvoices, clientCreditNotes, clientRetentionReleases],
  )
  const rows = useMemo(
    () => (figuresKnown ? clientRetentionRows(clientInvoices, ctx.positions) : []),
    [figuresKnown, clientInvoices, ctx.positions],
  )
  const rowById = useMemo(() => new Map(rows.map(r => [r.id, r])), [rows])
  const invoiceById = useMemo(() => new Map(clientInvoices.map(inv => [inv.id, inv])), [clientInvoices])
  const ledgerById = useMemo(() => new Map(clientInvoiceLedgers.map(l => [l.id, l])), [clientInvoiceLedgers])
  const reconciliationById = useMemo(
    () => new Map(clientInvoiceReconciliationRows(clientInvoices, clientReceipts, ctx.positions, { refunds: clientRefunds, applications: clientReceiptApplications }).map(r => [r.id, r])),
    [clientInvoices, clientReceipts, ctx.positions, clientRefunds, clientReceiptApplications],
  )

  const releaseProblems = useMemo(
    () => (figuresKnown ? clientReleaseExceptions(clientRetentionReleases, clientInvoices) : []),
    [figuresKnown, clientRetentionReleases, clientInvoices],
  )
  const ledgerProblems = useMemo(
    () => (figuresKnown && !clientInvoiceLedgersError && !clientInvoiceLedgersLoading
      ? ledgerExceptions(clientInvoices, clientInvoiceLedgers, clientCreditNotes, clientRetentionReleases)
      : []),
    [figuresKnown, clientInvoiceLedgersError, clientInvoiceLedgersLoading,
      clientInvoices, clientInvoiceLedgers, clientCreditNotes, clientRetentionReleases],
  )

  const sortedReleases = useMemo(
    () => [...clientRetentionReleases].sort(
      (a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '')
             || (b.releaseNumber || '').localeCompare(a.releaseNumber || ''),
    ),
    [clientRetentionReleases],
  )

  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!canView) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Client retention is restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          Client retention and its releases are visible to Company Admin, Project Manager, and QS roles only.
          Access is enforced by Firestore Security Rules.
        </p>
      </Card>
    )
  }

  // Loading and unavailable are different facts, and neither may print a
  // number: a settled, genuinely nil balance still renders a real zero.
  const figure = (value) => (figuresUnavailable ? 'Unavailable' : figuresLoading ? '—' : money(value))

  const releaseInvoice = releaseFor ? invoiceById.get(releaseFor.invoiceId) ?? null : null
  const releaseDraft = releaseFor?.releaseId
    ? clientRetentionReleases.find(r => r.id === releaseFor.releaseId) ?? null
    : null
  const posting = postingId ? clientRetentionReleases.find(r => r.id === postingId) ?? null : null
  const voiding = voidingId ? clientRetentionReleases.find(r => r.id === voidingId) ?? null : null

  const sameInput = (release) => ({
    amount: release.amount,
    releaseDate: release.releaseDate,
    reason: release.reason,
    notes: release.notes || '',
  })

  // A void that would strand allocated receipts is refused BY THE SERVER. The
  // received and receivable figures are still passed for a POSTED release, but
  // the hook no longer relies on them — the server reads the records itself.
  function confirmVoid(release, reason) {
    if (release.status !== CRR_STATUS.POSTED) return voidClientRetentionRelease(release, reason)
    const recon = reconciliationById.get(release.clientInvoiceId)
    return voidClientRetentionRelease(release, reason, {
      receivedCents: cents(recon?.received),
      receivableBasisCents: recon ? cents(recon.receivableBasis) : null,
    })
  }

  return (
    <div className="space-y-4">
      {/* ── Summary ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <Stat label="Retention Withheld" value={figure(ctx.totals.retentionTotal)} sub="On issued client invoices · inc. GST" />
        </Card>
        <Card>
          <Stat label="Released" value={figure(ctx.totals.releasedTotal)} sub="Posted releases — now receivable" />
        </Card>
        <Card>
          <Stat label="Reduced by Credit Notes" value={figure(ctx.totals.creditedRetention)} sub="Retention credited back, never receivable" />
        </Card>
        <Card>
          <Stat label="Still Held" value={figure(ctx.totals.retentionHeld)} sub="Billed, not receivable yet" accent />
        </Card>
      </div>

      {/* ── Unavailability, honestly ────────────────────────────────────────── */}
      {(figuresUnavailable || clientInvoiceLedgersError || clientReceiptsError) && (
        <Card>
          <p className="m-0 text-[12.5px] font-bold text-brand-red">
            {figuresUnavailable ? 'Client retention figures are unavailable' : 'Some retention actions are unavailable'}
          </p>
          <ul className="m-0 mt-2 pl-4 text-[12px] text-brand-muted list-disc space-y-1">
            {clientInvoicesError && <li>Client Invoices could not be loaded — retention withheld is unknown.</li>}
            {clientRetentionReleasesError && <li>{CLIENT_RETENTION_READ_UNAVAILABLE_NOTICE}</li>}
            {clientCreditNotesError && <li>{CLIENT_CREDIT_READ_UNAVAILABLE_NOTICE}</li>}
            {clientInvoiceLedgersError && (
              <li>
                The invoice ledgers could not be loaded. A release is prepared and posted against its invoice&apos;s
                current ledger, so releasing, editing and posting are disabled.
              </li>
            )}
            {clientReceiptsError && (
              <li>
                Client Receipts could not be loaded. Voiding a posted release depends on what has been received —
                the server checks it when the void is written — and this page cannot show you that position, so
                the action is disabled here.
              </li>
            )}
          </ul>
          <p className="m-0 mt-2 text-[11.5px] text-brand-muted">
            Nothing here is shown as zero because it could not be read. Reload the page, and check your connection
            and permissions if this persists.
          </p>
        </Card>
      )}

      {/* ── Exceptions ──────────────────────────────────────────────────────── */}
      {releaseProblems.length > 0 && (
        <Card>
          <p className="m-0 text-[12.5px] font-bold text-brand-amber">
            {releaseProblems.length} retention release{releaseProblems.length === 1 ? '' : 's'} need{releaseProblems.length === 1 ? 's' : ''} attention
          </p>
          <div className="mt-2 space-y-1.5">
            {releaseProblems.map(ex => (
              <p key={ex.releaseId} className="m-0 text-[12px] text-brand-muted">
                <span className="font-semibold text-brand-text">{ex.releaseNumber}</span>
                {' → '}{ex.invoiceNumber}{' · '}{money(ex.releaseTotal)}{' — '}{ex.reason}
              </p>
            ))}
          </div>
          <p className="m-0 mt-2 text-[11.5px] text-brand-muted">
            A release listed here counts toward no figure. Nothing is reversed automatically — investigate, and void
            the release if it should not stand.
          </p>
        </Card>
      )}

      {ledgerProblems.length > 0 && (
        <Card>
          <p className="m-0 text-[12.5px] font-bold text-brand-red">
            {ledgerProblems.length} invoice ledger{ledgerProblems.length === 1 ? '' : 's'} disagree{ledgerProblems.length === 1 ? 's' : ''} with the posted records
          </p>
          <div className="mt-2 space-y-1.5">
            {ledgerProblems.map(ex => (
              <p key={ex.invoiceId} className="m-0 text-[12px] text-brand-muted">{ex.reason}</p>
            ))}
          </div>
          <p className="m-0 mt-2 text-[11.5px] text-brand-muted">
            This cannot arise through Constrap — it means a record was changed outside the app. The figures on this
            page still follow the posted credit notes and releases themselves; new postings against these invoices
            may be refused until it is investigated.
          </p>
        </Card>
      )}

      {/* ── Register by invoice ─────────────────────────────────────────────── */}
      <Card padding={false}>
        <div className="px-5 py-4 border-b border-brand-border">
          <h2 className="text-[14px] font-bold text-brand-text m-0">Retention by client invoice</h2>
          <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">
            One row per issued client invoice that withheld retention. Amounts include GST. Withheld retention was
            billed and counts as issued — it is not a reduction in billed or earned value.
          </p>
        </div>

        {figuresLoading ? (
          <p className="px-5 py-6 m-0 text-[13px] text-brand-muted">Loading…</p>
        ) : figuresUnavailable ? (
          <p className="px-5 py-6 m-0 text-[13px] text-brand-muted">Unavailable — see above.</p>
        ) : rows.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              No client retention is recorded on this project. Retention appears here once a client invoice that
              withholds retention is issued.
            </p>
            <Btn variant="ghost" onClick={() => navigate(`/projects/${projectId}/commercial/client-invoices`)}>
              Go to Client Invoices
            </Btn>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse min-w-[860px]">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  <th className={thCls}>Invoice</th>
                  <th className={thCls}>Client</th>
                  <th className={thCls}>Invoice Date</th>
                  <th className={thRight}>Withheld</th>
                  <th className={thRight}>Released</th>
                  <th className={thRight}>Reduced by Credit Notes</th>
                  <th className={thRight}>Still Held</th>
                  <th className={thCls}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-b border-brand-border last:border-b-0 hover:bg-brand-card transition-colors">
                    <td className={`${tdCls} font-semibold`}>{row.invoiceNumber}</td>
                    <td className={tdCls}>{row.clientName || '—'}</td>
                    <td className={`${tdCls} text-brand-muted`}>{row.invoiceDate || '—'}</td>
                    <td className={`${tdMoney} text-brand-text`}>{money(row.retentionTotal)}</td>
                    <td className={`${tdMoney} text-brand-muted`}>{money(row.releasedTotal)}</td>
                    <td className={`${tdMoney} text-brand-muted`}>{money(row.creditedRetention)}</td>
                    <td className={`${tdMoney} font-semibold text-brand-text`}>{money(row.retentionHeld)}</td>
                    <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                      <Btn
                        sm variant="ghost"
                        disabled={draftingUnavailable || row.fullyResolved}
                        title={draftingUnavailable
                          ? 'Unavailable — the records a release is prepared from could not be loaded'
                          : row.fullyResolved
                            ? 'No retention is still held on this invoice'
                            : 'Prepare a draft release of retention held on this invoice'}
                        onClick={() => setReleaseFor({ invoiceId: row.id })}
                      >
                        Release
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Release register ────────────────────────────────────────────────── */}
      <Card padding={false}>
        <div className="px-5 py-4 border-b border-brand-border">
          <h2 className="text-[14px] font-bold text-brand-text m-0">Client retention releases</h2>
          <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">
            An authorisation that makes withheld retention receivable. Not an invoice, a credit note or a receipt —
            it bills nothing new and moves no cash. A draft releases nothing until it is posted.
          </p>
        </div>

        {clientRetentionReleasesLoading ? (
          <p className="px-5 py-6 m-0 text-[13px] text-brand-muted">Loading…</p>
        ) : clientRetentionReleasesError ? (
          <p className="px-5 py-6 m-0 text-[13px] text-brand-muted">Unavailable — client retention releases could not be loaded.</p>
        ) : sortedReleases.length === 0 ? (
          <p className="px-5 py-6 m-0 text-[13px] text-brand-muted">No client retention has been released yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse min-w-[980px]">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  <th className={thCls}>CRR #</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Release Date</th>
                  <th className={thCls}>Invoice</th>
                  <th className={thCls}>Client</th>
                  <th className={thRight}>Amount (ex-GST)</th>
                  <th className={thRight}>GST</th>
                  <th className={thRight}>Total</th>
                  <th className={thCls}>Reason</th>
                  <th className={thCls}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {sortedReleases.map(r => {
                  const isDraft = r.status === CRR_STATUS.DRAFT
                  const isPosted = r.status === CRR_STATUS.POSTED
                  const voidBlocked = isPosted && (receivedUnknown || !figuresKnown)
                  return (
                    <tr key={r.id} className="border-b border-brand-border last:border-b-0 hover:bg-brand-card transition-colors">
                      <td className={`${tdCls} font-semibold`}>{r.releaseNumber}</td>
                      <td className={tdCls}>
                        <Badge label={CRR_STATUS_LABELS[r.status] ?? r.status} variant={CRR_BADGE_VARIANTS[r.status]} sm />
                      </td>
                      <td className={`${tdCls} text-brand-muted`}>{r.releaseDate || '—'}</td>
                      <td className={tdCls}>{r.invoiceNumber || '—'}</td>
                      <td className={tdCls}>{r.clientName || '—'}</td>
                      <td className={`${tdMoney} text-brand-text`}>{money(r.amount)}</td>
                      <td className={`${tdMoney} text-brand-muted`}>{money(r.gstAmount)}</td>
                      <td className={`${tdMoney} font-semibold text-brand-text`}>{money(r.releaseTotal)}</td>
                      <td className={`${tdCls} max-w-[220px] truncate`} title={r.status === CRR_STATUS.VOID ? `Voided: ${r.voidReason || ''}` : r.reason}>
                        {r.reason || '—'}
                      </td>
                      <td className="px-3.5 py-2.5 whitespace-nowrap">
                        {(isDraft || isPosted) && (
                          <div className="flex items-center gap-1.5 justify-end">
                            {isDraft && (
                              <>
                                <Btn
                                  sm variant="ghost"
                                  disabled={draftingUnavailable || !invoiceById.has(r.clientInvoiceId)}
                                  title={draftingUnavailable ? 'Unavailable — the records a release is prepared from could not be loaded' : undefined}
                                  onClick={() => setReleaseFor({ invoiceId: r.clientInvoiceId, releaseId: r.id })}
                                >
                                  Edit
                                </Btn>
                                <Btn
                                  sm variant="success"
                                  disabled={!figuresKnown}
                                  title="Make this retention receivable"
                                  onClick={() => setPostingId(r.id)}
                                >
                                  Post
                                </Btn>
                              </>
                            )}
                            <Btn
                              sm variant="ghost"
                              disabled={voidBlocked}
                              title={voidBlocked
                                ? 'Unavailable — voiding a posted release depends on receipts and the invoice balance, which could not be loaded on this page'
                                : undefined}
                              onClick={() => setVoidingId(r.id)}
                            >
                              Void
                            </Btn>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="px-5 py-4 border-t border-brand-border space-y-1.5">
          <p className="m-0 text-[11.5px] text-brand-muted">{CLIENT_RETENTION_HELD_NOTICE}</p>
          <p className="m-0 text-[11.5px] text-brand-muted">{CLIENT_RETENTION_RELEASED_NOTICE}</p>
          <p className="m-0 text-[11.5px] text-brand-muted">
            A release is posted by the Constrap server, which caps the total released against an invoice through
            the invoice&apos;s ledger.
            Voiding a posted release once receipts are allocated against it is refused by the server when the void
            is written, not by this page.
          </p>
        </div>
      </Card>

      {releaseFor && releaseInvoice && (
        <ClientReleaseModal
          key={`${releaseFor.invoiceId}/${releaseFor.releaseId ?? 'new'}`}
          invoice={releaseInvoice}
          release={releaseDraft}
          ledgerDoc={ledgerById.get(releaseInvoice.id) ?? null}
          row={rowById.get(releaseInvoice.id) ?? null}
          currencyCode={currencyCode}
          onClose={() => setReleaseFor(null)}
          onSave={releaseDraft
            ? (input) => updateClientRetentionRelease(releaseDraft, input)
            : createClientRetentionRelease}
        />
      )}

      {posting && (
        <ClientReleasePostModal
          release={posting}
          invoice={invoiceById.get(posting.clientInvoiceId) ?? null}
          ledgerDoc={ledgerById.get(posting.clientInvoiceId) ?? null}
          ledgerUnavailable={clientInvoiceLedgersError || clientInvoiceLedgersLoading}
          currencyCode={currencyCode}
          onClose={() => setPostingId(null)}
          onConfirm={postClientRetentionRelease}
          onRefresh={(release) => updateClientRetentionRelease(release, sameInput(release))}
        />
      )}

      {voiding && (
        <ClientReleaseVoidModal
          release={voiding}
          currencyCode={currencyCode}
          onClose={() => setVoidingId(null)}
          onConfirm={confirmVoid}
        />
      )}
    </div>
  )
}
