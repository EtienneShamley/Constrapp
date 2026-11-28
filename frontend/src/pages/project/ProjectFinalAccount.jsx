import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatDate } from '../../lib/formatters'
import { isFinancialRole } from '../../lib/margin'
import { useAuth } from '../../hooks/useAuth'
import { useProfile } from '../../hooks/useProfile'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { useApprovedBudget } from '../../hooks/useApprovedBudget'
import { useCostCodes } from '../../hooks/useCostCodes'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useSupplierCreditNotes } from '../../hooks/useSupplierCreditNotes'
import { useVariations } from '../../hooks/useVariations'
import { useForecastLines } from '../../hooks/useForecastLines'
import { useProjectCommercial } from '../../hooks/useProjectCommercial'
import { useSupplierPayments } from '../../hooks/useSupplierPayments'
import { useRetentionReleases } from '../../hooks/useRetentionReleases'
import { useClientInvoices } from '../../hooks/useClientInvoices'
import { useClientReceipts } from '../../hooks/useClientReceipts'
import { useClientCreditNotes } from '../../hooks/useClientCreditNotes'
import { useClientRetentionReleases } from '../../hooks/useClientRetentionReleases'
import { useClientRefunds } from '../../hooks/useClientRefunds'
import { useClientReceiptApplications } from '../../hooks/useClientReceiptApplications'
import { useFinalAccounts } from '../../hooks/useFinalAccounts'
import { useApprovalPolicy } from '../../hooks/useApprovalPolicy'
import { resolveBudgetSource, budgetSourceState } from '../../lib/budgetApproval'
import {
  FINAL_ACCOUNT_STATUS, FINAL_ACCOUNT_STATUS_LABELS, FINAL_ACCOUNT_STATUS_BADGE, FINAL_ACCOUNT_DISCLAIMER,
  computeFinalAccount, readinessChecklist, finalAccountHistory, finalAccountDifferences, finalAccountRevisionLabel,
  canPrepareFinalAccount, canApproveFinalAccount, canWithdrawFinalAccount,
} from '../../lib/finalAccount'
import { finalAccountCsv, finalAccountFilename } from '../../lib/finalAccountCsv'
import { saveBlob } from '../../lib/fileBlob'
import { FIGURE_VIEW, revisionView, readinessPresentation } from '../../lib/finalAccountDisplay'
import { FinalAccountFigures, FinalAccountRows } from './finalAccount/FinalAccountSnapshot'
import { PrepareFinalAccountModal, ApproveFinalAccountModal, WithdrawFinalAccountModal } from './finalAccount/FinalAccountDialogs'

// ── Project · Commercial · Final Account — L2-B (ADR-77) ─────────────────────
//
// The last stage of the commercial lifecycle: an internally approved, frozen
// statement of the project's contract, cost and outstanding balances.
//
//   · Every figure comes from lib/finalAccount.js, which only COMPOSES the
//     Commercial Report's selectors. Nothing on this page adds, subtracts or
//     re-derives money.
//   · A DRAFT is a proposal built from the server's records. APPROVAL is the
//     trusted callable `approveFinalAccount`: it recomputes every figure
//     itself and no client can write an approved revision.
//   · An APPROVED revision is never recalculated. The live position is shown
//     BESIDE it and any difference is named; a correction is a new revision.
//     It is compared on the figures IT carries: a figure introduced after it
//     was approved is "not recorded" on it, never a difference.
//
// ⚠️ ROLE GATE. The outer component renders the body — and so opens its
// subscriptions — only for financial roles (isFinancialRole). That is the UX
// mirror; Firestore Security Rules are the enforced boundary.
//
// Display states (ADR-24, ADR-41): loading "—", failed "Unavailable", a
// settled zero is a formatted zero.
//
// Print: only an APPROVED revision is printable. Its article carries the
// `commercial-report` class, so the L2-A print rules in index.css apply
// unchanged; everything else on the page is `data-print-hide`.

const stamp = (t) => {
  const d = t && typeof t.toDate === 'function' ? t.toDate() : null
  return d
    ? d.toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
    : '—'
}

// A UTF-8 BOM lets spreadsheet applications detect the encoding.
function downloadCsv(text, filename) {
  const blob = new Blob([String.fromCharCode(0xFEFF), text], { type: 'text/csv;charset=utf-8' })
  saveBlob({ blob, fileName: filename })
}

const CHECK_MARK = { ok: '✓', blocked: '✕', pending: '…', unknown: '–' }
const CHECK_TEXT = { ok: 'Met', blocked: 'Not met', pending: 'Checking', unknown: 'Not checked' }
const CHECK_CLS = { ok: 'text-brand-accent', blocked: 'text-brand-red', pending: 'text-brand-muted', unknown: 'text-brand-muted' }

function ReadinessChecklist({ computation }) {
  const checks = readinessChecklist(computation).map(c => ({ ...c, ...readinessPresentation(c) }))
  return (
    <ul className="m-0 p-0 list-none flex flex-col">
      {checks.map(c => (
        <li key={c.code} className="flex gap-3 py-2 border-b border-brand-border last:border-b-0">
          <span aria-hidden="true" className={`w-5 shrink-0 text-center font-bold ${CHECK_CLS[c.state]}`}>{CHECK_MARK[c.state]}</span>
          <div className="min-w-0">
            <p className="m-0 text-[12.5px] font-semibold text-brand-text">
              {c.label}
              <span className={`ml-2 text-[11px] font-bold uppercase tracking-[0.4px] ${CHECK_CLS[c.state]}`}>{CHECK_TEXT[c.state]}</span>
              {c.detail && <span className="ml-2 text-[11.5px] font-normal text-brand-muted">{c.detail}</span>}
            </p>
            {c.state === 'blocked' && <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">{c.fix}</p>}
          </div>
        </li>
      ))}
    </ul>
  )
}

function AuditBlock({ account, currentUid }) {
  const who = (uid) => (uid ? (uid === currentUid ? 'You' : 'Another user') : '—')
  const rows = [
    ['Prepared', `${stamp(account.createdAt)} · ${account.preparedByName || who(account.createdBy)}`],
    ['Basis', account.reason || '—'],
  ]
  if (account.reference) rows.push(['Reference', account.reference])
  if (account.sources?.budgetCaption) rows.push(['Budget source', account.sources.budgetCaption])
  if (account.status === FINAL_ACCOUNT_STATUS.APPROVED) {
    rows.push(['Approved', `${stamp(account.approvedAt)} · ${account.approvedByName || who(account.approvedBy)}${account.selfApproved ? ' · self-approval (also prepared this revision)' : ''}`])
    rows.push(['Records read', `${stamp(account.sourcesReadAt)} — the figures are the project records as read at this time`])
  }
  if (account.status === FINAL_ACCOUNT_STATUS.WITHDRAWN) {
    rows.push(['Withdrawn', `${stamp(account.withdrawnAt)} · ${who(account.withdrawnBy)}`])
    rows.push(['Reason', account.withdrawReason || '—'])
  }
  return (
    <dl className="m-0">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3 py-1 border-b border-brand-border last:border-b-0">
          <dt className="m-0 sm:w-[140px] shrink-0 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted">{label}</dt>
          <dd className="m-0 text-[12.5px] text-brand-text break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function FinalAccount({ project, projectId, currencyCode, role }) {
  const { user } = useAuth()
  const currentUid = user?.uid ?? null
  // ADR-96 / ADR-98: what the approve dialog may say about self-approval.
  const { approvalPolicy, approvalPolicyKnown } = useApprovalPolicy()

  // ── Live subscriptions — the Commercial Report's sixteen, plus the revisions. ──
  const { budgetLines, budgetLinesLoading, budgetLinesError }                         = useBudgetLines(projectId)
  const { approvedBudget }                                                            = useApprovedBudget(projectId)
  const budgetSource = useMemo(
    () => resolveBudgetSource({ approvedBudget, budgetLines, budgetLinesLoading, budgetLinesError, currencyCode }),
    [approvedBudget, budgetLines, budgetLinesLoading, budgetLinesError, currencyCode],
  )
  const { loading: approvedBudgetLoading, error: approvedBudgetError } = budgetSourceState(budgetSource)
  const { costCodes, costCodesLoading, costCodesError }                               = useCostCodes()
  const { purchaseOrders, purchaseOrdersLoading, purchaseOrdersError }                = usePurchaseOrders(projectId)
  const { progressClaims, progressClaimsLoading, progressClaimsError }                = useProgressClaims(projectId)
  const { supplierInvoices, supplierInvoicesLoading, supplierInvoicesError }          = useSupplierInvoices(projectId)
  const { supplierCreditNotes, supplierCreditNotesLoading, supplierCreditNotesError } = useSupplierCreditNotes(projectId)
  const { variations, variationsLoading, variationsError }                            = useVariations(projectId)
  const { forecastLines, forecastLinesLoading, forecastLinesError }                   = useForecastLines(projectId)
  const { baseline, baselineLoading, baselineError }                                  = useProjectCommercial(projectId)
  const { supplierPayments, supplierPaymentsLoading, supplierPaymentsError }          = useSupplierPayments(projectId)
  const { retentionReleases, retentionReleasesLoading, retentionReleasesError }       = useRetentionReleases(projectId)
  const { clientInvoices, clientInvoicesLoading, clientInvoicesError }                = useClientInvoices(projectId)
  const { clientReceipts, clientReceiptsLoading, clientReceiptsError }                = useClientReceipts(projectId)
  const { clientCreditNotes, clientCreditNotesLoading, clientCreditNotesError }       = useClientCreditNotes(projectId)
  const {
    clientRetentionReleases, clientRetentionReleasesLoading, clientRetentionReleasesError,
  } = useClientRetentionReleases(projectId)
  const { clientRefunds, clientRefundsLoading, clientRefundsError } = useClientRefunds(projectId)
  const {
    clientReceiptApplications, clientReceiptApplicationsLoading, clientReceiptApplicationsError,
  } = useClientReceiptApplications(projectId)
  const {
    finalAccounts, finalAccountsLoading, finalAccountsError,
    prepareFinalAccount, withdrawFinalAccount, approveFinalAccount,
  } = useFinalAccounts(projectId)

  // The LIVE position — the proposal a draft would capture, and what an
  // approved revision is compared with.
  const live = useMemo(() => computeFinalAccount({
    project,
    currencyCode,
    sources: {
      budgetLines, approvedBudget, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes,
      variations, forecastLines, baseline, supplierPayments, retentionReleases,
      clientInvoices, clientReceipts, clientCreditNotes, clientRetentionReleases, costCodes,
      clientRefunds, clientReceiptApplications,
    },
    sourceStates: {
      budgetLines:         { loading: budgetLinesLoading,         error: budgetLinesError },
      approvedBudget:      { loading: approvedBudgetLoading,      error: approvedBudgetError },
      purchaseOrders:      { loading: purchaseOrdersLoading,      error: purchaseOrdersError },
      progressClaims:      { loading: progressClaimsLoading,      error: progressClaimsError },
      supplierInvoices:    { loading: supplierInvoicesLoading,    error: supplierInvoicesError },
      supplierCreditNotes: { loading: supplierCreditNotesLoading, error: supplierCreditNotesError },
      variations:          { loading: variationsLoading,          error: variationsError },
      forecastLines:       { loading: forecastLinesLoading,       error: forecastLinesError },
      baseline:            { loading: baselineLoading,            error: baselineError },
      supplierPayments:    { loading: supplierPaymentsLoading,    error: supplierPaymentsError },
      retentionReleases:   { loading: retentionReleasesLoading,   error: retentionReleasesError },
      clientInvoices:      { loading: clientInvoicesLoading,      error: clientInvoicesError },
      clientReceipts:      { loading: clientReceiptsLoading,      error: clientReceiptsError },
      clientCreditNotes:   { loading: clientCreditNotesLoading,   error: clientCreditNotesError },
      clientRetentionReleases: { loading: clientRetentionReleasesLoading, error: clientRetentionReleasesError },
      clientRefunds:       { loading: clientRefundsLoading,       error: clientRefundsError },
      clientReceiptApplications: { loading: clientReceiptApplicationsLoading, error: clientReceiptApplicationsError },
      costCodes:           { loading: costCodesLoading,           error: Boolean(costCodesError) },
    },
  }), [
    project, currencyCode,
    budgetLines, approvedBudget, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes,
    variations, forecastLines, baseline, supplierPayments, retentionReleases, clientInvoices, clientReceipts,
    clientCreditNotes, clientRetentionReleases, costCodes, clientRefunds, clientReceiptApplications,
    clientRefundsLoading, clientRefundsError, clientReceiptApplicationsLoading, clientReceiptApplicationsError,
    budgetLinesLoading, budgetLinesError, approvedBudgetLoading, approvedBudgetError,
    purchaseOrdersLoading, purchaseOrdersError, progressClaimsLoading, progressClaimsError,
    supplierInvoicesLoading, supplierInvoicesError, supplierCreditNotesLoading, supplierCreditNotesError,
    variationsLoading, variationsError, forecastLinesLoading, forecastLinesError,
    baselineLoading, baselineError, supplierPaymentsLoading, supplierPaymentsError,
    retentionReleasesLoading, retentionReleasesError, clientInvoicesLoading, clientInvoicesError,
    clientReceiptsLoading, clientReceiptsError, clientCreditNotesLoading, clientCreditNotesError,
    clientRetentionReleasesLoading, clientRetentionReleasesError, costCodesLoading, costCodesError,
  ])

  const history = useMemo(() => finalAccountHistory(finalAccounts), [finalAccounts])
  const [selectedNumber, setSelectedNumber] = useState(null)
  const [dialog, setDialog] = useState(null)        // 'prepare' | 'approve' | 'withdraw'
  const [exportError, setExportError] = useState(null)

  // The revision on screen: the one chosen in the history, else the open
  // draft, else the current approved revision.
  const selected = history.list.find(a => a.number === selectedNumber) ?? history.list.find(a => a.status === FINAL_ACCOUNT_STATUS.DRAFT)
    ?? history.list.find(a => a.current) ?? null
  const isDraft = selected?.status === FINAL_ACCOUNT_STATUS.DRAFT
  const isApproved = selected?.status === FINAL_ACCOUNT_STATUS.APPROVED
  const differences = useMemo(
    () => (selected && selected.status !== FINAL_ACCOUNT_STATUS.WITHDRAWN ? finalAccountDifferences(selected, live) : null),
    [selected, live],
  )
  const liveChanged = Boolean(differences?.comparable && (differences.changed || differences.provenance.includes('budget')))
  // Figures the live records carry that this revision's own schema does not.
  const unrecordedCount = differences?.comparable ? differences.newMetrics.length : 0

  const mayPrepare = canPrepareFinalAccount(role) && !finalAccountsLoading && !finalAccountsError && history.canPrepare
  const mayApprove = canApproveFinalAccount(role) && isDraft && Boolean(selected?.updatedAt)
  const mayWithdraw = canWithdrawFinalAccount(role, selected, currentUid)
  // A draft must carry every current figure (the callable refuses one that
  // does not — lib/finalAccount.js → draftAgreesWith); say so before the call.
  const approveBlocked = !live.ready ? 'The current records do not meet the readiness requirements.'
    : liveChanged ? 'The current records differ from this draft. Withdraw it and prepare a new draft.'
    : isDraft && unrecordedCount > 0 ? 'This draft was prepared before figures that a Final Account now records were introduced. Withdraw it and prepare a new draft.' : null

  function handleExport() {
    setExportError(null)
    try {
      downloadCsv(finalAccountCsv(selected, { projectName: project?.name ?? '', superseded: selected.superseded }), finalAccountFilename(selected, project?.name))
    } catch {
      setExportError('The CSV could not be generated.')
    }
  }

  const statusLine = finalAccountsLoading ? 'Loading revisions…'
    : finalAccountsError ? 'Revision history unavailable — it could not be loaded. No Final Account is shown rather than an empty history.'
    : history.current && history.draft ? `Revision ${history.current.number} is approved. Draft revision ${history.draft.number} is awaiting approval.`
    : history.current ? `Revision ${history.current.number} is the current approved Final Account.`
    : history.draft ? `Draft revision ${history.draft.number} is awaiting approval. No revision is approved yet.`
    : 'No Final Account has been prepared for this project.'

  return (
    <div className="flex flex-col gap-4">
      <div data-print-hide>
      <Card>
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="min-w-0">
            <p className="m-0 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-accent">Final Account</p>
            <p className={`m-0 mt-1 text-[14px] font-semibold ${finalAccountsError ? 'text-brand-amber' : 'text-brand-text'}`} role="status">{statusLine}</p>
            <p className="m-0 mt-1 text-[12px] text-brand-muted">{FINAL_ACCOUNT_DISCLAIMER}</p>
          </div>
          {mayPrepare && (
            <div className="shrink-0">
              <Btn onClick={() => setDialog('prepare')} disabled={!live.ready} aria-describedby={live.ready ? undefined : 'fa-prepare-hint'}>
                Prepare {history.nextNumber > 1 ? `revision ${history.nextNumber}` : 'Final Account'}
              </Btn>
            </div>
          )}
        </div>
        {mayPrepare && !live.ready && (
          <p id="fa-prepare-hint" className="m-0 mt-3 text-[12px] text-brand-muted">
            {live.loading ? 'Loading the project records…' : 'A draft can be prepared once every requirement below is met.'}
          </p>
        )}
      </Card>
      </div>

      {selected && (
        <article
          className={`${isApproved ? 'commercial-report ' : ''}flex flex-col gap-4`}
          aria-labelledby="final-account-title"
        >
          <Card className="report-header">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-accent">Constrap · Final Account</p>
                <h1 id="final-account-title" className="m-0 mt-1 text-xl font-semibold text-brand-text break-words flex flex-wrap items-center gap-2">
                  <span>{project?.name || 'Project'} — {finalAccountRevisionLabel(selected)}</span>
                  <Badge label={FINAL_ACCOUNT_STATUS_LABELS[selected.status]} variant={FINAL_ACCOUNT_STATUS_BADGE[selected.status]} sm />
                  {selected.superseded && <Badge label="Superseded" sm />}
                  {selected.current && <Badge label="Current" sm />}
                </h1>
                <p className="m-0 mt-1 text-[12.5px] text-brand-text-soft">
                  Currency <span className="font-bold text-brand-text">{selected.currency}</span>
                </p>
                {isApproved && <p className="m-0 mt-1 text-[12px] font-semibold text-brand-text">{FINAL_ACCOUNT_DISCLAIMER}</p>}
                {isDraft && (
                  <p className="m-0 mt-1 text-[12.5px] font-semibold text-brand-amber" role="status">
                    DRAFT — not approved. Every figure below is proposed. Nothing here is final until a Company Admin or Project Manager approves it and the server has recalculated it.
                  </p>
                )}
                {selected.status === FINAL_ACCOUNT_STATUS.WITHDRAWN && (
                  <p className="m-0 mt-1 text-[12.5px] font-semibold text-brand-amber" role="status">
                    WITHDRAWN draft — never approved. Its figures were a proposal and are kept as history only.
                  </p>
                )}
                {selected.superseded && (
                  <p className="m-0 mt-1 text-[12.5px] text-brand-amber" role="status">
                    Superseded by approved revision {history.current?.number}. Kept unchanged as history.
                  </p>
                )}
              </div>
              <div className="report-controls flex flex-wrap gap-2 shrink-0">
                {isApproved && <Btn variant="ghost" onClick={handleExport}>Export CSV</Btn>}
                {isApproved && <Btn variant="ghost" onClick={() => window.print()}>Print / Save as PDF</Btn>}
                {mayApprove && (
                  <Btn onClick={() => setDialog('approve')} disabled={Boolean(approveBlocked)} aria-describedby={approveBlocked ? 'fa-approve-hint' : undefined}>
                    Approve
                  </Btn>
                )}
                {mayWithdraw && <Btn variant="ghost" onClick={() => setDialog('withdraw')}>Withdraw draft</Btn>}
              </div>
            </div>
            {mayApprove && approveBlocked && (
              <p id="fa-approve-hint" className="report-controls m-0 mt-3 text-[12.5px] text-brand-amber" role="status">{approveBlocked}</p>
            )}
            {isDraft && !canApproveFinalAccount(role) && (
              <p className="report-controls m-0 mt-3 text-[12px] text-brand-muted">Approval is by a Company Admin or Project Manager.</p>
            )}
            {exportError && <p className="report-controls m-0 mt-3 text-[12px] text-brand-red" role="alert">{exportError}</p>}
            {isApproved && differences && !differences.comparable && (
              <p className="report-controls m-0 mt-3 text-[12.5px] text-brand-muted" role="status">
                {live.loading ? 'Comparing with the current records…' : 'The current records could not be loaded, so this revision cannot be compared with them. The approved figures below are unaffected.'}
              </p>
            )}
            {isApproved && liveChanged && (
              <p className="report-controls m-0 mt-3 text-[12.5px] font-semibold text-brand-amber" role="alert">
                The current project records differ from this approved revision in {differences.figures.length} figure{differences.figures.length === 1 ? '' : 's'}
                {differences.rows.length > 0 ? ` and ${differences.rows.length} cost code${differences.rows.length === 1 ? '' : 's'}` : ''}.
                The approved figures are unchanged; each difference is shown beside its figure. To adopt the current records, prepare a new revision.
              </p>
            )}
            {isApproved && differences?.comparable && !liveChanged && (
              <p className="report-controls m-0 mt-3 text-[12.5px] text-brand-text-soft" role="status">
                The current project records agree with this approved revision{unrecordedCount > 0 ? ' on every figure it records' : ''}.
              </p>
            )}
            {isApproved && unrecordedCount > 0 && (
              <p className="report-controls m-0 mt-3 text-[12.5px] text-brand-muted" role="status">
                {unrecordedCount} figure{unrecordedCount === 1 ? ' was' : 's were'} not recorded when this revision was approved
                ({differences.newMetrics.map(n => n.label).join(', ')}). {unrecordedCount === 1 ? 'It is' : 'They are'} shown
                as “Not recorded” — not as a change — and this revision is not altered. A new revision records every current figure.
              </p>
            )}
            <div className="mt-4"><AuditBlock account={selected} currentUid={currentUid} /></div>
          </Card>

          <Card className="report-card">
            <FinalAccountFigures
              figures={selected.figures}
              currencyCode={selected.currency}
              differences={selected.status === FINAL_ACCOUNT_STATUS.WITHDRAWN ? null : differences}
              idPrefix="fa-stored"
              view={revisionView(selected)}
            />
          </Card>

          <Card className="report-card" padding={false}>
            <section aria-labelledby="fa-cost-codes" className="p-5 report-section">
              <h2 id="fa-cost-codes" className="text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted m-0 mb-3">
                Cost-code breakdown (ex-GST, {selected.currency})
              </h2>
              <FinalAccountRows rows={selected.rows} currencyCode={selected.currency} differences={differences} />
            </section>
          </Card>

          <p className="m-0 text-[11px] text-brand-muted report-footnote">
            Contract, budget, cost and profit figures are ex-GST; invoice balances and cash are gross and are never added to them. GST is modelled as
            the Australian 10% rate only. One project, one currency; nothing is converted. {FINAL_ACCOUNT_DISCLAIMER}
          </p>
        </article>
      )}

      {history.canPrepare && !finalAccountsLoading && !finalAccountsError && (
        <div data-print-hide>
          <Card>
            <h2 className="text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted m-0 mb-1">
              Readiness — current records
            </h2>
            <p className="m-0 mb-3 text-[11.5px] text-brand-muted">
              Every requirement must be met before a draft can be prepared, and again when it is approved.
            </p>
            <ReadinessChecklist computation={live} />
            <h2 className="text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted m-0 mt-5 mb-3">
              Current position — not a Final Account
            </h2>
            <p className="m-0 mb-3 text-[11.5px] text-brand-muted">
              Live figures from the current records. Cost and profit here are forecasts until cost to complete is zero; nothing in this section is final.
            </p>
            <FinalAccountFigures figures={live.partialFigures} currencyCode={currencyCode} pending={live.loading} idPrefix="fa-live" view={FIGURE_VIEW.LIVE} />
          </Card>
        </div>
      )}

      {history.list.length > 0 && (
        <div data-print-hide>
          <Card>
            <h2 className="text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted m-0 mb-3">Revision history</h2>
            <ul className="m-0 p-0 list-none flex flex-col">
              {history.list.map(a => (
                <li key={a.number} className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-brand-border last:border-b-0">
                  <div className="min-w-0 text-[12.5px] text-brand-text">
                    <span className="font-semibold">{finalAccountRevisionLabel(a)}</span>
                    <span className="ml-2"><Badge label={FINAL_ACCOUNT_STATUS_LABELS[a.status]} variant={FINAL_ACCOUNT_STATUS_BADGE[a.status]} sm /></span>
                    {a.superseded && <span className="ml-2"><Badge label="Superseded" sm /></span>}
                    {a.current && <span className="ml-2"><Badge label="Current" sm /></span>}
                    <span className="block text-[11.5px] text-brand-muted">
                      {a.status === FINAL_ACCOUNT_STATUS.APPROVED && `Approved ${formatDate(a.approvedAt)} by ${a.approvedByName || (a.approvedBy === currentUid ? 'you' : 'another user')}`}
                      {a.status === FINAL_ACCOUNT_STATUS.DRAFT && `Prepared ${formatDate(a.createdAt)}`}
                      {a.status === FINAL_ACCOUNT_STATUS.WITHDRAWN && `Withdrawn ${formatDate(a.withdrawnAt)}`}
                      {a.reason ? ` · ${a.reason}` : ''}
                    </span>
                  </div>
                  <Btn sm variant="ghost" className="min-h-[44px]" onClick={() => setSelectedNumber(a.number)} aria-pressed={selected?.number === a.number}>
                    {selected?.number === a.number ? 'Showing' : 'View'}
                  </Btn>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {dialog === 'prepare' && (
        <PrepareFinalAccountModal
          number={history.nextNumber}
          figures={live.partialFigures}
          currencyCode={currencyCode}
          onPrepare={async (input) => { const r = await prepareFinalAccount({ project, currencyCode, input }); setSelectedNumber(r.number) }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'approve' && selected && (
        <ApproveFinalAccountModal
          account={selected}
          currencyCode={selected.currency}
          selfApproval={Boolean(selected.createdBy) && selected.createdBy === currentUid}
          approvalPolicy={approvalPolicy}
          approvalPolicyKnown={approvalPolicyKnown}
          onApprove={(acknowledged) => approveFinalAccount(selected, acknowledged)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'withdraw' && selected && (
        <WithdrawFinalAccountModal
          account={selected}
          onWithdraw={(reason) => withdrawFinalAccount(selected, reason)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

export default function ProjectFinalAccount() {
  const { project, projectId, currencyCode } = useOutletContext()
  const { profile, profileLoading } = useProfile()

  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!isFinancialRole(profile?.role)) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Final Account is restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          The Final Account is visible to Company Admin, Project Manager, and QS roles only.
          Access is enforced by Firestore Security Rules.
        </p>
      </Card>
    )
  }
  return <FinalAccount project={project} projectId={projectId} currencyCode={currencyCode} role={profile.role} />
}
