import { useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatCurrency, percent } from '../../lib/formatters'
import { isFinancialRole } from '../../lib/margin'
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
import { resolveBudgetSource, budgetSourceState } from '../../lib/budgetApproval'
import { FIGURE_STATE, MARGIN_NOT_ESTABLISHED } from '../../lib/projectSnapshot'
import {
  buildCommercialReport, isReportExportable, FIGURE_KIND, REPORT_SOURCE_LABELS,
} from '../../lib/commercialReport'
import { commercialReportCsv, commercialReportFilename } from '../../lib/commercialReportCsv'
import { saveBlob } from '../../lib/fileBlob'

// ── Project · Reports — L2-A Commercial Report (READ-ONLY) ───────────────────
//
// One project, one currency, live figures. Every number comes from
// lib/commercialReport.js, which only COMPOSES existing selectors (the
// Dashboard snapshot, the forecast rows, the variation, claim and cash
// selectors). Nothing on this page adds, subtracts or re-derives money, and no
// write callback is consumed — the report creates, changes and stores nothing.
//
// ⚠️ ROLE GATE. The outer component renders the report body — and so OPENS its
// sixteen subscriptions — only for financial roles (isFinancialRole). That is
// the UX mirror; Firestore Security Rules are the enforced boundary and would
// deny these reads to a subcontractor or client anyway.
//
// Display states (ADR-24, ADR-41): loading "—", failed "Unavailable", a
// settled zero is a formatted zero, a missing contract value is "Not set".
//
// Print: the browser's Save as PDF. The print rules in index.css apply only
// while this report is on the page (body:has(.commercial-report)) and hide the
// app chrome; the timestamp is refreshed at print / export time.

const money = (currencyCode) => (n) => formatCurrency(n, currencyCode, { precise: true })

function figureText(figure, kind, fmt) {
  if (!figure || figure.state === FIGURE_STATE.LOADING) return '—'
  if (figure.state === MARGIN_NOT_ESTABLISHED) return 'Not set'
  if (figure.state !== FIGURE_STATE.READY) return 'Unavailable'
  if (figure.value === null || figure.value === undefined) {
    return kind === FIGURE_KIND.PERCENT ? 'Not calculable' : 'Unavailable'
  }
  return kind === FIGURE_KIND.PERCENT ? percent(figure.value) : fmt(figure.value)
}

const failedText = (sources) => (sources ?? []).map(s => REPORT_SOURCE_LABELS[s] ?? s).join(', ')

const formatStamp = (date) => date.toLocaleString('en-AU', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
})

function FigureList({ title, items, fmt, id }) {
  return (
    <section aria-labelledby={id} className="report-section">
      <h2 id={id} className="text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted m-0 mb-3">{title}</h2>
      <dl className="m-0 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        {items.map(item => {
          const f = item.figure
          const unavailable = f?.state === FIGURE_STATE.UNAVAILABLE
          const negative = f?.state === FIGURE_STATE.READY && typeof f.value === 'number' && f.value < 0
          return (
            <div key={item.key} className="report-figure min-w-0 border-b border-brand-border pb-2">
              <dt className="text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted flex items-center gap-2">
                {item.label}
                {item.pending && <Badge label="Pending" variant="pending" sm />}
              </dt>
              <dd className={`m-0 mt-0.5 text-[17px] font-bold tabular-nums ${unavailable ? 'text-brand-amber' : negative ? 'text-brand-red' : 'text-brand-text'}`}>
                {figureText(f, item.kind, fmt)}
              </dd>
              <dd className="m-0 mt-0.5 text-[11px] text-brand-muted">
                {unavailable && f.failedSources?.length ? `Could not load: ${failedText(f.failedSources)}` : item.note}
              </dd>
            </div>
          )
        })}
      </dl>
    </section>
  )
}

const thCls = 'px-3 py-2.5 text-right text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px] whitespace-nowrap'
const tdCls = 'px-3 py-2.5 text-right text-[12.5px] text-brand-text tabular-nums whitespace-nowrap'

const COLUMNS = [
  { key: 'approvedBudget',    label: 'Approved budget', nullable: true },
  { key: 'committed',         label: 'Committed (open)' },
  { key: 'claimed',           label: 'Claimed (uncertified)' },
  { key: 'actual',            label: 'Actual cost' },
  { key: 'forecastFinalCost', label: 'Forecast final cost' },
  { key: 'costToComplete',    label: 'Cost to complete' },
  { key: 'varianceToBudget',  label: 'Variance', nullable: true, signed: true },
]

function CostCodeTable({ table, fmt, currencyCode }) {
  if (table.state === FIGURE_STATE.LOADING) {
    return <p className="text-[13px] text-brand-muted m-0">Loading cost codes…</p>
  }
  if (table.state !== FIGURE_STATE.READY) {
    return (
      <p className="text-[13px] text-brand-amber m-0" role="status">
        Cost-code breakdown unavailable. Could not load: {failedText(table.failedSources)}
      </p>
    )
  }
  if (table.rows.length === 0) {
    return (
      <p className="text-[13px] text-brand-muted m-0">
        No cost code has a budget, commitment, claim, cost or forecast on this project yet.
      </p>
    )
  }
  const cell = (row, col) => {
    const v = row[col.key]
    if (col.nullable && (v === null || v === undefined)) return <span className="text-brand-muted">No budget line</span>
    return fmt(v)
  }
  return (
    <div className="overflow-x-auto report-table-wrap">
      <table className="w-full border-collapse report-table">
        <caption className="sr-only">
          Cost-code breakdown in {currencyCode}, ex-GST. Variance is approved budget minus forecast final cost; negative means over budget.
        </caption>
        <thead>
          <tr className="border-b border-brand-border">
            <th scope="col" className={`${thCls} text-left`}>Cost code</th>
            {COLUMNS.map(c => <th key={c.key} scope="col" className={thCls}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {table.rows.map(row => (
            <tr key={row.costCodeId} className="border-b border-brand-border/60">
              <th scope="row" className={`${tdCls} text-left font-semibold whitespace-normal min-w-[180px]`}>
                {row.costCodeName}
                {row.unforecasted && <span className="block text-[10.5px] font-normal text-brand-muted">Not forecast</span>}
              </th>
              {COLUMNS.map(c => (
                <td
                  key={c.key}
                  className={`${tdCls} ${c.signed && row.hasBudgetLine && row.overBudget ? 'text-brand-red font-semibold' : ''}`}
                >
                  {cell(row, c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-brand-border">
            <th scope="row" className={`${tdCls} text-left font-bold`}>Total</th>
            {COLUMNS.map(c => (
              <td
                key={c.key}
                className={`${tdCls} font-bold ${c.signed && table.totals[c.key] < 0 ? 'text-brand-red' : ''}`}
              >
                {fmt(table.totals[c.key])}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// The CSV is saved through lib/fileBlob.js → saveBlob, the app's ONE object-URL
// path (storageDownloads.test.js guard). A UTF-8 BOM lets spreadsheet
// applications detect the encoding.
function downloadCsv(text, filename) {
  const blob = new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' })
  saveBlob({ blob, fileName: filename })
}

function CommercialReport({ project, projectId, currencyCode }) {
  const fmt = useMemo(() => money(currencyCode), [currencyCode])

  // ── Live subscriptions (16) — the Dashboard snapshot's eleven, plus client
  // invoices, receipts, credit notes and retention releases (cash and what is
  // receivable) and the company cost codes (names only). ──
  const { budgetLines, budgetLinesLoading, budgetLinesError }                         = useBudgetLines(projectId)
  const { approvedBudget }                                                            = useApprovedBudget(projectId, { original: true })
  const budgetSource = useMemo(
    () => resolveBudgetSource({ approvedBudget, budgetLines, budgetLinesLoading, budgetLinesError, currencyCode }),
    [approvedBudget, budgetLines, budgetLinesLoading, budgetLinesError, currencyCode],
  )
  const { loading: approvedBudgetLoading, error: approvedBudgetError } = budgetSourceState(budgetSource)
  const { costCodes }                                                                 = useCostCodes()
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

  const report = useMemo(() => buildCommercialReport({
    project,
    currencyCode,
    sources: {
      budgetLines, approvedBudget, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes,
      variations, forecastLines, baseline, supplierPayments, retentionReleases,
      clientInvoices, clientReceipts, clientCreditNotes, clientRetentionReleases, costCodes,
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
    },
  }), [
    project, currencyCode,
    budgetLines, approvedBudget, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes,
    variations, forecastLines, baseline, supplierPayments, retentionReleases, clientInvoices, clientReceipts,
    clientCreditNotes, clientRetentionReleases, costCodes,
    budgetLinesLoading, budgetLinesError, approvedBudgetLoading, approvedBudgetError,
    purchaseOrdersLoading, purchaseOrdersError, progressClaimsLoading, progressClaimsError,
    supplierInvoicesLoading, supplierInvoicesError, supplierCreditNotesLoading, supplierCreditNotesError,
    variationsLoading, variationsError, forecastLinesLoading, forecastLinesError,
    baselineLoading, baselineError, supplierPaymentsLoading, supplierPaymentsError,
    retentionReleasesLoading, retentionReleasesError, clientInvoicesLoading, clientInvoicesError,
    clientReceiptsLoading, clientReceiptsError, clientCreditNotesLoading, clientCreditNotesError,
    clientRetentionReleasesLoading, clientRetentionReleasesError,
  ])

  // When this view was opened, then refreshed at each print / export — the
  // printed or exported copy carries the moment it was produced.
  const [generatedAt, setGeneratedAt] = useState(() => new Date())
  const [exportError, setExportError] = useState(null)
  const exportable = isReportExportable(report)

  function handleExport() {
    setExportError(null)
    try {
      const now = new Date()
      const csv = commercialReportCsv(report, { generatedAt: now })
      downloadCsv(csv, commercialReportFilename(report, now))
      setGeneratedAt(now)
    } catch {
      setExportError('The CSV could not be generated. Wait for every figure to load and try again.')
    }
  }

  function handlePrint() {
    flushSync(() => setGeneratedAt(new Date()))
    window.print()
  }

  return (
    <article className="commercial-report flex flex-col gap-4" aria-labelledby="commercial-report-title">
      <Card className="report-header">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="min-w-0">
            <p className="m-0 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-accent">Constrap · Commercial Report</p>
            <h1 id="commercial-report-title" className="m-0 mt-1 text-xl font-semibold text-brand-text break-words">
              {report.projectName || 'Project'}
            </h1>
            <p className="m-0 mt-1 text-[12.5px] text-brand-text-soft">
              Currency <span className="font-bold text-brand-text">{currencyCode}</span>
              <span aria-hidden="true"> · </span>
              Budget source <span className="font-bold text-brand-text">{report.budgetSourceCaption}</span>
            </p>
            <p className="m-0 mt-1 text-[12px] text-brand-muted">
              Generated <time dateTime={generatedAt.toISOString()}>{formatStamp(generatedAt)}</time>
              {' '}— live figures from current records at that time. Not an accounting cut-off, period close or saved snapshot.
            </p>
          </div>
          <div className="report-controls flex flex-wrap gap-2 shrink-0">
            <Btn
              variant="ghost"
              onClick={handleExport}
              disabled={!exportable}
              aria-describedby={exportable ? undefined : 'report-export-hint'}
            >
              Export CSV
            </Btn>
            <Btn variant="ghost" onClick={handlePrint} disabled={!exportable}>Print / Save as PDF</Btn>
          </div>
        </div>
        {!exportable && (
          <p id="report-export-hint" className="report-controls m-0 mt-3 text-[12px] text-brand-muted" role="status">
            Loading figures… Export and print are available once every figure has loaded.
          </p>
        )}
        {exportError && <p className="report-controls m-0 mt-3 text-[12px] text-brand-red" role="alert">{exportError}</p>}
        {!report.loading && report.failedSources.length > 0 && (
          <p className="m-0 mt-3 text-[12.5px] text-brand-amber" role="status">
            Some figures are unavailable because these records could not be loaded: {failedText(report.failedSources)}.
            Unavailable figures are shown as “Unavailable” and are never counted as zero.
          </p>
        )}
        {report.contractNotEstablished && (
          <p className="m-0 mt-3 text-[12.5px] text-brand-text-soft">
            The contract value is not set on the Commercial tab, so contract, revenue and margin figures show “Not set”.
          </p>
        )}
      </Card>

      <Card className="report-card">
        <FigureList id="report-summary" title="Financial summary" items={report.summary} fmt={fmt} />
      </Card>

      <Card className="report-card" padding={false}>
        <section aria-labelledby="report-cost-codes" className="p-5 report-section">
          <h2 id="report-cost-codes" className="text-[13px] font-bold uppercase tracking-[0.4px] text-brand-muted m-0 mb-1">
            Cost-code breakdown
          </h2>
          <p className="m-0 mb-3 text-[11.5px] text-brand-muted">
            Ex-GST, {currencyCode}. Committed is remaining open commitment, not cost incurred. Claimed is submitted or
            under-review claims, not yet certified and not in Actual cost. Variance is approved budget − forecast final
            cost (negative = over budget); the total also includes cost codes with no budget line.
          </p>
          <CostCodeTable table={report.costCodes} fmt={fmt} currencyCode={currencyCode} />
        </section>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="report-card">
          <FigureList id="report-variations" title="Variations" items={report.variations} fmt={fmt} />
        </Card>
        <Card className="report-card">
          <FigureList id="report-cash" title="Cash position" items={report.cash} fmt={fmt} />
        </Card>
      </div>

      <p className="m-0 text-[11px] text-brand-muted report-footnote">
        Cost, budget and variation figures are ex-GST; cash and invoice balances are gross. GST is modelled as the
        Australian 10% rate only. Figures are derived live from this project’s records in one currency; no figure is
        converted, stored or combined with another project.
      </p>
    </article>
  )
}

export default function ProjectReports() {
  const { project, projectId, currencyCode } = useOutletContext()
  const { profile, profileLoading } = useProfile()

  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!isFinancialRole(profile?.role)) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Reports are restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          The Commercial Report is visible to Company Admin, Project Manager, and QS roles only.
          Access is enforced by Firestore Security Rules.
        </p>
      </Card>
    )
  }
  return <CommercialReport project={project} projectId={projectId} currencyCode={currencyCode} />
}
