import { useMemo, useState } from 'react'
import { useOutletContext, Link } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatCurrency, percent } from '../../lib/formatters'
import { useProfile } from '../../hooks/useProfile'
import { useClientReceipts } from '../../hooks/useClientReceipts'
import { useSupplierPayments } from '../../hooks/useSupplierPayments'
import { useClientInvoices } from '../../hooks/useClientInvoices'
import { useCashFlowLines } from '../../hooks/useCashFlowLines'
import { useProjectCommercial } from '../../hooks/useProjectCommercial'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { useCostCodes } from '../../hooks/useCostCodes'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useSupplierCreditNotes } from '../../hooks/useSupplierCreditNotes'
import { useVariations } from '../../hooks/useVariations'
import { useForecastLines } from '../../hooks/useForecastLines'
import {
  isFinancialRole, isBaselineEstablished, projectForecastTotals, computeMargin,
} from '../../lib/margin'
import { buildForecastRows } from '../../lib/forecast'
import { actualClaimsByCostCode } from '../../lib/progressClaims'
import { invoicedClaimIds } from '../../lib/supplierInvoices'
import { contractControl } from '../../lib/clientInvoices'
import {
  cashInRows, receiptSummary, clientInvoiceReconciliationRows,
} from '../../lib/clientReceipts'
import {
  cashOutRows, paymentSummary, supplierInvoiceReconciliationRows,
} from '../../lib/supplierPayments'
import { roundMoney } from '../../lib/purchaseOrders'
import {
  totalActualCashIn, totalActualCashOut, actualNetCash,
  monthLabel, currentMonthKey,
  CFL_SOURCE_TYPE_LABELS,
  activeCashFlowLines, voidCashFlowLines, staleCashFlowLines,
  manualForecastByMonth, classifyInvoiceBalances, sumRetentionWithheld,
  buildMonthlyCombinedRows, projectedClosingPosition,
  untimedForecastRevenue, untimedRemainingCommitted, untimedUncommittedCtc,
  revenueCoverage, costCoverage, COMPLETENESS_STATE, completenessState,
  peakFunding, peakFundingSuppression,
} from '../../lib/cashFlow'
import CashFlowChart from './cashFlow/CashFlowChart'
import CombinedMonthlyTable from './cashFlow/CombinedMonthlyTable'
import LineEditorModal from './cashFlow/LineEditorModal'
import LineVoidModal from './cashFlow/LineVoidModal'

// ── Cash Flow — actual + forecast ────────────────────────────────────────────
//
// Three read-time layers, none stored (ADR-3/ADR-4):
//   1 · ACTUAL — posted receipts (receiptDate) and payments (paymentDate)
//   2 · NEAR-TERM FORECAST — open invoice balances by due date (AR gross,
//       AP payableTotal net of retention)
//   3 · LONGER-TERM FORECAST — manually timed cashFlowLines (gross cash,
//       ex-GST source coverage tracked separately)
//
// The boundary rule: months before the current month are ACTUAL ONLY — no
// forecast amount ever lands in a past month, so nothing can be counted twice.
// The cumulative position starts at ZERO and is project cash movement, not a
// bank balance. This page writes ONLY cashFlowLines (via useCashFlowLines);
// it never mutates any other financial document.
//
// A failed subscription is never presented as a genuine zero: the cash core
// failing blocks the page; a forecast source failing marks its figures
// unavailable and names the failed source.

const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1'
const thCls    = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'
const tdMoney  = 'px-3.5 py-2.5 text-[12.5px] tabular-nums text-right'

const pct = (n) => (n === null || n === undefined ? '—' : percent(n))

function Metric({ label, value, help, danger }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <p className={`text-lg font-bold ${danger ? 'text-brand-red' : 'text-brand-text'}`}>{value}</p>
      {help && <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">{help}</p>}
    </div>
  )
}

export default function ProjectCashFlow() {
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)

  const { profile, profileLoading } = useProfile()
  const canView = isFinancialRole(profile?.role)
  // Non-financial roles never trigger the commercially-sensitive reads (rules
  // would deny them anyway — this is the UX mirror; rules are the boundary).
  const mid = canView ? projectId : null

  // ── Live subscriptions (12) ────────────────────────────────────────────────
  const { clientReceipts, clientReceiptsLoading, clientReceiptsError } = useClientReceipts(mid)
  const { supplierPayments, supplierPaymentsLoading, supplierPaymentsError } = useSupplierPayments(mid)
  const { clientInvoices, clientInvoicesLoading, clientInvoicesError } = useClientInvoices(mid)
  const {
    cashFlowLines, cashFlowLinesLoading, cashFlowLinesError,
    createCashFlowLine, updateCashFlowLine, voidCashFlowLine,
  } = useCashFlowLines(mid)
  const { baseline, baselineError } = useProjectCommercial(mid)
  const { budgetLines, budgetLinesError }           = useBudgetLines(mid)
  const { costCodes }                               = useCostCodes()
  const { purchaseOrders, purchaseOrdersError }     = usePurchaseOrders(mid)
  const { progressClaims, progressClaimsError }     = useProgressClaims(mid)
  const { supplierInvoices, supplierInvoicesError } = useSupplierInvoices(mid)
  const { supplierCreditNotes, supplierCreditNotesError } = useSupplierCreditNotes(mid)
  const { variations, variationsError }             = useVariations(mid)
  const { forecastLines, forecastLinesError }       = useForecastLines(mid)

  const nowMonth = currentMonthKey()

  // ── Layer 1: actual cash ───────────────────────────────────────────────────
  const inRows  = useMemo(() => cashInRows(clientReceipts, { projectId }), [clientReceipts, projectId])
  const outRows = useMemo(() => cashOutRows(supplierPayments, { projectId }), [supplierPayments, projectId])
  const cashIn  = useMemo(() => totalActualCashIn(inRows), [inRows])
  const cashOut = useMemo(() => totalActualCashOut(outRows), [outRows])
  const netCash = actualNetCash(cashIn, cashOut)
  const receiptTotals = useMemo(() => receiptSummary(clientReceipts), [clientReceipts])
  const paymentTotals = useMemo(() => paymentSummary(supplierPayments), [supplierPayments])

  // ── Layer 2: open invoice balances by due month ────────────────────────────
  const arRows = useMemo(
    () => clientInvoiceReconciliationRows(clientInvoices, clientReceipts),
    [clientInvoices, clientReceipts],
  )
  const apRows = useMemo(
    () => supplierInvoiceReconciliationRows(supplierInvoices, supplierPayments, supplierCreditNotes),
    [supplierInvoices, supplierPayments, supplierCreditNotes],
  )
  const arClass = useMemo(() => classifyInvoiceBalances(arRows, nowMonth), [arRows, nowMonth])
  const apClass = useMemo(() => classifyInvoiceBalances(apRows, nowMonth), [apRows, nowMonth])
  const retentionWithheld = useMemo(() => sumRetentionWithheld(apRows), [apRows])

  // ── Layer 3: manual timing lines ───────────────────────────────────────────
  const manualIn  = useMemo(() => manualForecastByMonth(cashFlowLines, 'in', nowMonth), [cashFlowLines, nowMonth])
  const manualOut = useMemo(() => manualForecastByMonth(cashFlowLines, 'out', nowMonth), [cashFlowLines, nowMonth])
  const staleLines  = useMemo(() => staleCashFlowLines(cashFlowLines, nowMonth), [cashFlowLines, nowMonth])
  const activeLines = useMemo(() => activeCashFlowLines(cashFlowLines), [cashFlowLines])
  const voidedLines = useMemo(() => voidCashFlowLines(cashFlowLines), [cashFlowLines])

  // ── Combined monthly rows ──────────────────────────────────────────────────
  const combinedRows = useMemo(() => buildMonthlyCombinedRows({
    inRows, outRows,
    arForecastByMonth: arClass.byMonth, apForecastByMonth: apClass.byMonth,
    manualInByMonth: manualIn, manualOutByMonth: manualOut,
    nowMonth,
  }), [inRows, outRows, arClass, apClass, manualIn, manualOut, nowMonth])
  const closing = projectedClosingPosition(combinedRows)
  const forecastIn  = useMemo(() => roundMoney(combinedRows.reduce((s, r) => s + r.forecastCashIn, 0)), [combinedRows])
  const forecastOut = useMemo(() => roundMoney(combinedRows.reduce((s, r) => s + r.forecastCashOut, 0)), [combinedRows])

  // ── Commercial composition (shared derivations — never duplicated) ─────────
  const forecastTotals = useMemo(
    () => projectForecastTotals({ costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines }),
    [costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines],
  )
  const m = useMemo(
    () => computeMargin({ baseline, variations, forecastFinalCost: forecastTotals.forecastFinalCost }),
    [baseline, variations, forecastTotals.forecastFinalCost],
  )
  const established = isBaselineEstablished(baseline)
  const availableToInvoice = useMemo(
    () => contractControl(clientInvoices, m.currentContractSum).availableToInvoice,
    [clientInvoices, m.currentContractSum],
  )

  // Per-cost-code balances for the editor pickers and the claim breakdown.
  const forecastRows = useMemo(
    () => buildForecastRows({ costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines }),
    [costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines],
  )
  const uninvoicedClaimByCostCode = useMemo(
    () => actualClaimsByCostCode(progressClaims, invoicedClaimIds(supplierInvoices)),
    [progressClaims, supplierInvoices],
  )
  const uninvoicedClaimCost = useMemo(
    () => roundMoney(Object.values(uninvoicedClaimByCostCode).reduce((s, v) => s + v, 0)),
    [uninvoicedClaimByCostCode],
  )
  const editorBalances = useMemo(() => {
    const remainingCommittedByCostCode = {}
    const uncommittedCtcByCostCode = {}
    const costCodeNames = {}
    for (const r of forecastRows) {
      costCodeNames[r.costCodeId] = r.costCodeName
      if (r.remainingCommitted > 0) remainingCommittedByCostCode[r.costCodeId] = r.remainingCommitted
      if ((r.storedUncommittedCostToComplete ?? 0) > 0) uncommittedCtcByCostCode[r.costCodeId] = r.storedUncommittedCostToComplete
    }
    return {
      availableToInvoice: established ? availableToInvoice : 0,
      remainingCommittedByCostCode,
      uncommittedCtcByCostCode,
      uninvoicedClaimByCostCode,
      costCodeNames,
    }
  }, [forecastRows, established, availableToInvoice, uninvoicedClaimByCostCode])

  // ── Coverage, completeness, untimed, peak funding ──────────────────────────
  // ⚠️ A variations read failure understates the Current Contract Sum, so the
  // revenue basis is treated as unavailable — not as a smaller number.
  const revCov = useMemo(() => {
    if (variationsError || baselineError) return { pct: null, state: 'source_error' }
    return revenueCoverage({ baselineEstablished: established, availableToInvoice, lines: cashFlowLines })
  }, [variationsError, baselineError, established, availableToInvoice, cashFlowLines])

  const costBasisSourceError = budgetLinesError || purchaseOrdersError || progressClaimsError
    || supplierInvoicesError || supplierCreditNotesError || forecastLinesError
  const cstCov = useMemo(() => {
    if (costBasisSourceError) return { pct: null, state: 'source_error', incompleteBasis: false }
    return costCoverage({
      remainingCommittedTotal: forecastTotals.remainingCommitted,
      uncommittedCtcTotal: forecastTotals.uncommittedCostToComplete,
      unforecastedCount: forecastTotals.unforecastedCount,
      lines: cashFlowLines,
    })
  }, [costBasisSourceError, forecastTotals, cashFlowLines])

  const untimedRevenue = useMemo(
    () => (revCov.state === 'ok' ? untimedForecastRevenue({ availableToInvoice, lines: cashFlowLines }) : 0),
    [revCov.state, availableToInvoice, cashFlowLines],
  )
  const untimedCommitted = useMemo(
    () => untimedRemainingCommitted({ remainingCommittedTotal: forecastTotals.remainingCommitted, lines: cashFlowLines }),
    [forecastTotals.remainingCommitted, cashFlowLines],
  )
  const untimedCtc = useMemo(
    () => untimedUncommittedCtc({ uncommittedCtcTotal: forecastTotals.uncommittedCostToComplete, lines: cashFlowLines }),
    [forecastTotals.uncommittedCostToComplete, cashFlowLines],
  )

  const compState = completenessState({
    revenue: revCov, cost: cstCov,
    untimedAR: arClass.noDueDate, pastDueAR: arClass.pastDue,
    untimedAP: apClass.noDueDate, pastDueAP: apClass.pastDue,
  })

  const pf = useMemo(() => peakFunding(combinedRows), [combinedRows])
  const suppression = peakFundingSuppression({
    untimedRevenue, untimedCommitted, untimedCtc,
    untimedAR: arClass.noDueDate, pastDueAR: arClass.pastDue,
    untimedAP: apClass.noDueDate, pastDueAP: apClass.pastDue,
    revenueBasisUnavailable: revCov.pct === null,
    costBasisUnavailable: cstCov.pct === null,
    costBasisIncomplete: !!cstCov.incompleteBasis,
  })

  // ── Modals ─────────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState(null)   // line | 'new' | null
  const [voiding, setVoiding] = useState(null)   // line | null
  const [showVoided, setShowVoided] = useState(false)

  // ── Gates ──────────────────────────────────────────────────────────────────
  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!canView) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Cash Flow is restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          Cash movement is visible to Company Admin, Project Manager, and QS roles only.
          Access is enforced by Firestore Security Rules.
        </p>
      </Card>
    )
  }
  // No zero totals while any forecast-critical subscription is unresolved.
  if (clientReceiptsLoading || supplierPaymentsLoading || clientInvoicesLoading || cashFlowLinesLoading) {
    return <div className="text-[13px] text-brand-muted">Loading cash and forecast records…</div>
  }
  // The cash CORE failing blocks the page — nothing can be shown honestly.
  if (clientReceiptsError || supplierPaymentsError) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Cash records could not be loaded</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          {clientReceiptsError && 'Client Receipts failed to load, so Cash In cannot be shown. '}
          {supplierPaymentsError && 'Supplier Payments failed to load, so Cash Out cannot be shown. '}
          No figure on this page is displayed as zero in place of missing data — check your connection
          and access, then reload.
        </p>
      </Card>
    )
  }

  // A failed forecast source makes its layer UNAVAILABLE — never zero. AR and
  // AP layers and the manual register are each blocked by their own source.
  const forecastSourceErrors = [
    clientInvoicesError && 'Client Invoices — Forecast Cash In and open AR are unavailable',
    supplierInvoicesError && 'Supplier Invoices — Forecast Cash Out and open AP are unavailable',
    supplierCreditNotesError && 'Supplier Credit Notes — open AP balances may be overstated, so Forecast Cash Out is unavailable',
    cashFlowLinesError && 'Cash Flow timing lines — the manual forecast is unavailable',
  ].filter(Boolean)
  const costBasisErrors = [
    budgetLinesError && 'Budget Lines — cost composition and completeness are unavailable',
    purchaseOrdersError && 'Purchase Orders — Remaining Committed and cost completeness are unavailable',
    progressClaimsError && 'Progress Claims — the uninvoiced-claim breakdown and cost completeness are unavailable',
    forecastLinesError && 'Forecast Lines — Cost to Complete and cost completeness are unavailable',
  ].filter(Boolean)
  const forecastUnavailable = forecastSourceErrors.length > 0

  const hasData = combinedRows.length > 0

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-3.5">
        <div>
          <h2 className="text-[16px] font-bold text-brand-text m-0">Cash Flow</h2>
          <p className="text-[12.5px] text-brand-muted m-0 mt-0.5">
            Recorded cash movement, plus projected movement from open invoices and manual timing.
          </p>
        </div>
        <p className="text-[12px] m-0">
          <Link to="../receipts" className="text-brand-accent hover:underline">Client Receipts</Link>
          <span className="text-brand-muted"> · </span>
          <Link to="../supplier-payments" className="text-brand-accent hover:underline">Supplier Payments</Link>
          <span className="text-brand-muted"> · </span>
          <Link to="../client-invoices" className="text-brand-accent hover:underline">Client Invoices</Link>
        </p>
      </div>

      {/* ── Source-failure banners (never shown as zeros) ─────────────────── */}
      {(forecastSourceErrors.length > 0 || costBasisErrors.length > 0 || variationsError) && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-red m-0 mb-1.5">Some sources failed to load</p>
          <ul className="m-0 pl-4 space-y-1">
            {[...forecastSourceErrors, ...costBasisErrors].map(msg => (
              <li key={msg} className="text-[11.5px] text-brand-text">{msg}</li>
            ))}
            {variationsError && (
              <li className="text-[11.5px] text-brand-text">
                Variations — variation exposure and the Current Contract Sum are unavailable, so revenue
                coverage cannot be measured. Cash layers are unaffected.
              </li>
            )}
          </ul>
          <p className="m-0 mt-2 text-[11px] text-brand-muted">
            Affected figures are shown as unavailable — never as zero. Check your connection and access, then reload.
          </p>
        </Card>
      )}

      {hasData ? (
        <>
          {/* ── Summary: actual and forecast ─────────────────────────────── */}
          <Card className="mb-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              <Metric label="Actual Cash In" value={money(cashIn)} help={`${receiptTotals.postedCount} posted client receipt${receiptTotals.postedCount === 1 ? '' : 's'} · gross, full amounts`} />
              <Metric label="Actual Cash Out" value={money(cashOut)} help={`${paymentTotals.postedCount} posted supplier payment${paymentTotals.postedCount === 1 ? '' : 's'} · gross, full amounts`} />
              <Metric label="Actual Net Cash" value={money(netCash)} help="Cash In − Cash Out" danger={netCash < 0} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 mt-4 pt-4 border-t border-brand-border">
              <Metric label="Forecast Cash In" value={forecastUnavailable ? '—' : money(forecastIn)} help="Open client invoice balances by due date + manual timing · gross" />
              <Metric label="Forecast Cash Out" value={forecastUnavailable ? '—' : money(forecastOut)} help="Open supplier invoice payables by due date + manual timing · gross, net of retention" />
              <Metric
                label="Forecast Net"
                value={forecastUnavailable ? '—' : money(roundMoney(forecastIn - forecastOut))}
                danger={!forecastUnavailable && forecastIn - forecastOut < 0}
              />
            </div>
            <p className="m-0 mt-3 text-[11px] text-brand-muted">
              Actual: posted transactions only, grouped by the date money moved. Forecast: current and future
              months only — past months are actual-only, and past-due or undated invoice balances wait in the
              untimed panel below rather than being guessed into a month.
            </p>
          </Card>

          {/* ── Projected position & peak funding ────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5 mb-3.5">
            <Card>
              <Metric
                label="Projected closing position"
                value={forecastUnavailable || closing === null ? '—' : money(closing)}
                danger={!forecastUnavailable && closing !== null && closing < 0}
                help={combinedRows.length ? `At ${monthLabel(combinedRows[combinedRows.length - 1].monthKey)} · from a zero opening position` : ''}
              />
              <p className="m-0 mt-2 text-[11px] text-brand-muted">
                Cumulative net cash movement on this project. Not a bank balance. Constrapp does not model a
                bank account, an opening cash position or project financing.
              </p>
            </Card>

            <Card>
              {forecastUnavailable || suppression.suppressed ? (
                <>
                  <p className={labelCls}>Peak funding requirement</p>
                  <p className="text-[13px] font-bold text-brand-amber m-0">
                    Cannot be calculated reliably yet
                  </p>
                  <ul className="m-0 mt-1.5 pl-4 space-y-0.5">
                    {(forecastUnavailable ? ['a forecast source failed to load'] : suppression.reasons).map(r => (
                      <li key={r} className="text-[11px] text-brand-muted">{r}</li>
                    ))}
                  </ul>
                  {!forecastUnavailable && pf.negative && (
                    <p className="m-0 mt-2 text-[11.5px] text-brand-text">
                      Lower bound only: at least <span className="font-semibold">{money(pf.requirement)}</span>{' '}
                      in {monthLabel(pf.monthKey)} — the true requirement is at least this much.
                    </p>
                  )}
                </>
              ) : pf.negative ? (
                <Metric
                  label="Peak funding requirement"
                  value={money(pf.requirement)}
                  danger
                  help={`Lowest projected position, in ${monthLabel(pf.monthKey)}`}
                />
              ) : (
                <Metric
                  label="Peak funding requirement"
                  value="No funding shortfall projected"
                  help={pf.lowestPosition !== null ? `Lowest projected position ${money(pf.lowestPosition)} in ${monthLabel(pf.lowestMonthKey)}` : ''}
                />
              )}
              <p className="m-0 mt-2 text-[11px] text-brand-muted">
                Excludes retention release and GST/BAS cash movement — neither is modelled. Measured from a
                zero opening position.
              </p>
            </Card>
          </div>

          {/* ── Chart (extracted — presentation only) ─────────────────────── */}
          {/* Overview: the shape of the cash movement. Every figure is the one
              already derived above — the chart re-derives nothing (ADR-26). */}
          <CashFlowChart
            combinedRows={combinedRows}
            nowMonth={nowMonth}
            pf={pf}
            suppression={suppression}
            forecastUnavailable={forecastUnavailable}
            currencyCode={currencyCode}
          />

          {/* ── Monthly table (extracted — presentation only) ─────────────── */}
          <CombinedMonthlyTable
            combinedRows={combinedRows}
            forecastUnavailable={forecastUnavailable}
            nowMonth={nowMonth}
            currencyCode={currencyCode}
            inRows={inRows}
            outRows={outRows}
            arRows={arRows}
            apRows={apRows}
            activeLines={activeLines}
          />

          {/* ── Completeness ─────────────────────────────────────────────── */}
          <Card className="mb-3.5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <p className="text-[13px] font-bold text-brand-text m-0">Forecast completeness</p>
              {compState === COMPLETENESS_STATE.COMPLETE && <Badge label="Complete" variant="active" sm />}
              {compState === COMPLETENESS_STATE.PARTIAL && <Badge label="Partially timed" variant="pending" sm />}
              {compState === COMPLETENESS_STATE.INCOMPLETE && <Badge label="Incomplete forecast" variant="danger" sm />}
              {compState === COMPLETENESS_STATE.UNAVAILABLE && <Badge label="Unavailable" variant="soon" sm />}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <Metric label="Revenue timed" value={pct(revCov.pct)} help="Ex-GST coverage of Remaining Uninvoiced Contract Value" />
                {revCov.state === 'no_baseline' && (
                  <p className="m-0 mt-1 text-[11px] text-brand-amber">
                    No commercial baseline — set one on the <Link to=".." className="underline">Margin</Link> view.
                    Never shown as 0% or 100%.
                  </p>
                )}
                {revCov.state === 'over_invoiced' && (
                  <p className="m-0 mt-1 text-[11px] text-brand-amber">
                    Contract is fully or over-invoiced — no uninvoiced revenue remains to time.
                  </p>
                )}
                {revCov.state === 'source_error' && (
                  <p className="m-0 mt-1 text-[11px] text-brand-amber">Unavailable — a source failed to load.</p>
                )}
              </div>
              <div>
                <Metric label="Cost timed" value={pct(cstCov.pct)} help="Ex-GST coverage of Cost to Complete (Remaining Committed + Uncommitted CTC)" />
                {cstCov.incompleteBasis && (
                  <p className="m-0 mt-1 text-[11px] text-brand-amber">
                    Cost to Complete is incomplete — {forecastTotals.unforecastedCount} cost code{forecastTotals.unforecastedCount === 1 ? ' is' : 's are'} not
                    forecast, so coverage is measured against an understated basis.
                  </p>
                )}
                {cstCov.state === 'no_cost_basis' && (
                  <p className="m-0 mt-1 text-[11px] text-brand-muted">No Cost to Complete remains to time.</p>
                )}
                {cstCov.state === 'source_error' && (
                  <p className="m-0 mt-1 text-[11px] text-brand-amber">Unavailable — a source failed to load.</p>
                )}
              </div>
            </div>
            {compState === COMPLETENESS_STATE.INCOMPLETE && (
              <p className="m-0 mt-3 text-[11px] text-brand-amber">
                Only open invoice balances are timed. This is a near-term receivables and payables view, not a
                project cash-flow forecast.
              </p>
            )}
          </Card>

          {/* ── Untimed items — three separate bases, never one total ─────── */}
          <Card className="mb-3.5">
            <p className="text-[13px] font-bold text-brand-text m-0 mb-3">Not yet timed</p>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div>
                <p className={labelCls}>Gross cash, not yet timed</p>
                <div className="space-y-1">
                  <p className="m-0 text-[11.5px] text-brand-text flex justify-between gap-2">
                    <span>AR — no due date</span><span className="tabular-nums">{clientInvoicesError ? '—' : money(arClass.noDueDate)}</span>
                  </p>
                  <p className="m-0 text-[11.5px] text-brand-text flex justify-between gap-2">
                    <span>Past due — expected recovery not retimed</span><span className="tabular-nums">{clientInvoicesError ? '—' : money(arClass.pastDue)}</span>
                  </p>
                  <p className="m-0 text-[11.5px] text-brand-text flex justify-between gap-2">
                    <span>AP — no due date</span><span className="tabular-nums">{supplierInvoicesError ? '—' : money(apClass.noDueDate)}</span>
                  </p>
                  <p className="m-0 text-[11.5px] text-brand-text flex justify-between gap-2">
                    <span>Past due — expected payment not retimed</span><span className="tabular-nums">{supplierInvoicesError ? '—' : money(apClass.pastDue)}</span>
                  </p>
                  <p className="m-0 text-[11.5px] text-brand-text flex justify-between gap-2">
                    <span>Retention withheld (release not modelled)</span><span className="tabular-nums">{supplierInvoicesError ? '—' : money(retentionWithheld)}</span>
                  </p>
                </div>
                {(arClass.overReconciled < 0 || apClass.overReconciled < 0) && (
                  <p className="m-0 mt-2 text-[11px] text-brand-amber">
                    Over-reconciled balances ({money(roundMoney(arClass.overReconciled + apClass.overReconciled))}) are
                    excluded from every month and never offset expected amounts.
                  </p>
                )}
              </div>
              <div>
                <p className={labelCls}>Ex-GST source value, not yet timed</p>
                <div className="space-y-1">
                  <p className="m-0 text-[11.5px] text-brand-text flex justify-between gap-2">
                    <span>Remaining uninvoiced contract value</span>
                    <span className="tabular-nums">{revCov.state === 'ok' ? money(untimedRevenue) : '—'}</span>
                  </p>
                  <p className="m-0 text-[11.5px] text-brand-text flex justify-between gap-2">
                    <span>Remaining committed</span>
                    <span className="tabular-nums">{costBasisSourceError ? '—' : money(untimedCommitted)}</span>
                  </p>
                  <p className="m-0 pl-3 text-[11px] text-brand-muted flex justify-between gap-2">
                    <span>of which approved claim awaiting invoice — included within Remaining Committed</span>
                    <span className="tabular-nums">{costBasisSourceError ? '—' : money(uninvoicedClaimCost)}</span>
                  </p>
                  <p className="m-0 text-[11.5px] text-brand-text flex justify-between gap-2">
                    <span>Uncommitted cost to complete</span>
                    <span className="tabular-nums">{costBasisSourceError ? '—' : money(untimedCtc)}</span>
                  </p>
                </div>
              </div>
              <div>
                <p className={labelCls}>Exposure — context only</p>
                <div className="space-y-1">
                  <p className="m-0 text-[11.5px] text-brand-text flex justify-between gap-2">
                    <span>Approved supplier variations</span>
                    <span className="tabular-nums">{variationsError ? '—' : money(m.approvedSupplierVariations)}</span>
                  </p>
                  <p className="m-0 text-[11.5px] text-brand-text flex justify-between gap-2">
                    <span>Pending supplier variations</span>
                    <span className="tabular-nums">{variationsError ? '—' : money(m.pendingSupplierVariationExposure)}</span>
                  </p>
                  <p className="m-0 text-[11.5px] text-brand-text flex justify-between gap-2">
                    <span>Pending client variations</span>
                    <span className="tabular-nums">{variationsError ? '—' : money(m.pendingClientVariationExposure)}</span>
                  </p>
                </div>
                <p className="m-0 mt-2 text-[11px] text-brand-muted">
                  Never added to any cash or coverage figure. Supplier variation cost reaches Cash Flow only
                  through Uncommitted Cost to Complete on the Forecast tab.
                </p>
              </div>
            </div>
            <p className="m-0 mt-3 text-[11px] text-brand-muted">
              The three columns use different bases — gross cash, ex-GST source value, and informational
              exposure — and are never added together.
            </p>
          </Card>

          {/* ── Stale forecast lines ─────────────────────────────────────── */}
          {staleLines.length > 0 && (
            <Card className="mb-3.5">
              <p className="text-[13px] font-bold text-brand-amber m-0 mb-1.5">
                Forecast in past months — not counted: {money(roundMoney(staleLines.reduce((s, l) => s + l.amount, 0)))}
              </p>
              <p className="m-0 mb-3 text-[11.5px] text-brand-muted">
                These active lines sit in months that have passed — cash that was expected and is not recorded.
                Past months are actual-only, so they count nowhere. Retime each to the current month or later,
                or void it with a reason. Nothing is moved or deleted silently.
              </p>
              <div className="space-y-2">
                {staleLines.map(l => (
                  <div key={l.id} className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between border border-brand-border rounded-lg px-3 py-2">
                    <p className="m-0 text-[12px] text-brand-text">
                      {monthLabel(l.monthKey)} · {CFL_SOURCE_TYPE_LABELS[l.sourceType] ?? l.sourceType} · {l.description} ·{' '}
                      <span className="font-semibold tabular-nums">{money(l.amount)}</span> {l.direction}
                    </p>
                    <div className="flex gap-2 shrink-0">
                      <Btn sm variant="ghost" onClick={() => setEditing(l)}>Retime</Btn>
                      <Btn sm variant="danger" onClick={() => setVoiding(l)}>Void</Btn>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* ── Manual timing register ───────────────────────────────────── */}
          <Card padding={false} className="mb-3.5">
            <div className="flex items-center justify-between gap-3 px-3.5 py-3 border-b border-brand-border">
              <p className="text-[13px] font-bold text-brand-text m-0">Manual timing lines</p>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11.5px] text-brand-muted cursor-pointer">
                  <input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />
                  Show voided
                </label>
                <Btn sm onClick={() => setEditing('new')} disabled={cashFlowLinesError}>+ Add timing line</Btn>
              </div>
            </div>
            {cashFlowLinesError ? (
              <p className="px-3.5 py-4 m-0 text-[12px] text-brand-amber">
                Timing lines failed to load — the manual forecast is unavailable, not empty.
              </p>
            ) : activeLines.length === 0 && (!showVoided || voidedLines.length === 0) ? (
              <p className="px-3.5 py-4 m-0 text-[12px] text-brand-muted">
                No timing lines yet. Time the remaining contract value and cost to complete into months to
                build the longer-term forecast — nothing is ever spread automatically.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse">
                  <thead>
                    <tr className="bg-brand-card">
                      <th className={thCls}>Month</th>
                      <th className={thCls}>Direction</th>
                      <th className={thCls}>Source</th>
                      <th className={thCls}>Description</th>
                      <th className={`${thCls} text-right`}>Gross cash</th>
                      <th className={`${thCls} text-right`}>Source (ex-GST)</th>
                      <th className={thCls}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...activeLines].sort((a, b) => (a.monthKey || '').localeCompare(b.monthKey || '')).map(l => (
                      <tr key={l.id} className="border-b border-brand-border hover:bg-brand-card">
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-text whitespace-nowrap">
                          {monthLabel(l.monthKey)}
                          {l.monthKey < nowMonth && <span className="ml-2 text-[10px] font-semibold text-brand-amber">Stale</span>}
                        </td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-text">{l.direction === 'in' ? 'In' : 'Out'}</td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-text">
                          {CFL_SOURCE_TYPE_LABELS[l.sourceType] ?? l.sourceType}
                          {l.costCodeName && <span className="block text-[10.5px] text-brand-muted">{l.costCodeName}</span>}
                        </td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-text">
                          {l.description}
                          {l.sourceRef && <span className="block text-[10.5px] text-brand-muted">{l.sourceRef}</span>}
                        </td>
                        <td className={`${tdMoney} text-brand-text`}>{money(l.amount)}</td>
                        <td className={`${tdMoney} text-brand-text-soft`}>{l.sourceAmountExGst == null ? '—' : money(l.sourceAmountExGst)}</td>
                        <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                          <Btn sm variant="ghost" onClick={() => setEditing(l)}>Edit</Btn>{' '}
                          <Btn sm variant="ghost" onClick={() => setVoiding(l)}>Void</Btn>
                        </td>
                      </tr>
                    ))}
                    {showVoided && voidedLines.map(l => (
                      <tr key={l.id} className="border-b border-brand-border opacity-50">
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted whitespace-nowrap">{monthLabel(l.monthKey)}</td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">{l.direction === 'in' ? 'In' : 'Out'}</td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">{CFL_SOURCE_TYPE_LABELS[l.sourceType] ?? l.sourceType}</td>
                        <td className="px-3.5 py-2.5 text-[12px] text-brand-muted">
                          {l.description}
                          <span className="block text-[10.5px]">Voided — {l.voidReason}</span>
                        </td>
                        <td className={`${tdMoney} text-brand-muted line-through`}>{money(l.amount)}</td>
                        <td className={`${tdMoney} text-brand-muted`}>{l.sourceAmountExGst == null ? '—' : money(l.sourceAmountExGst)}</td>
                        <td></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* ── Unallocated cash ─────────────────────────────────────────── */}
          <Card className="mb-3.5">
            <p className="text-[13px] font-bold text-brand-text m-0 mb-3">Unallocated cash — on account</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <Metric label="Unallocated Cash In — on account" value={money(receiptTotals.unallocated)} />
                <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
                  Already received and counted in Actual Cash In. It reduces no Client Invoice balance. It may
                  represent an advance, overpayment or cash awaiting allocation.
                </p>
              </div>
              <div>
                <Metric label="Unallocated Cash Out — on account" value={money(paymentTotals.unallocated)} />
                <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
                  Already paid and counted in Actual Cash Out. It reduces no Supplier Invoice balance. It may
                  represent an advance, deposit, overpayment or cash awaiting allocation.
                </p>
              </div>
            </div>
            {(receiptTotals.unallocated > 0 || paymentTotals.unallocated > 0) && (
              <p className="m-0 mt-3 text-[11.5px] text-brand-amber">
                ⚠ If unallocated cash is an advance against work still to be invoiced, the open invoice balances
                in the forecast may overstate future cash movement by up to these amounts. Nothing is netted
                automatically — allocate the cash to an invoice, or add a manual adjustment line.
              </p>
            )}
          </Card>
        </>
      ) : (
        /* ── Empty state ──────────────────────────────────────────────────── */
        <Card className="mb-3.5">
          <div className="text-center py-8">
            <p className="text-[14px] font-bold text-brand-text m-0">No recorded or projected cash movement yet</p>
            <p className="text-[12.5px] text-brand-muted m-0 mt-1.5">
              Post a <Link to="../receipts" className="text-brand-accent hover:underline">Client Receipt</Link> or{' '}
              <Link to="../supplier-payments" className="text-brand-accent hover:underline">Supplier Payment</Link>,{' '}
              issue a <Link to="../client-invoices" className="text-brand-accent hover:underline">Client Invoice</Link>{' '}
              with a due date, or add a timing line to begin building the project&apos;s Cash Flow.
            </p>
            <div className="mt-4">
              <Btn sm onClick={() => setEditing('new')} disabled={cashFlowLinesError}>+ Add timing line</Btn>
            </div>
          </div>
        </Card>
      )}

      {/* ── Commercial context (accrual, ex-GST) — visually separate ──────── */}
      <Card className="mb-3.5">
        <p className="text-[13px] font-bold text-brand-text m-0 mb-3">Commercial context — accrual, ex-GST</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
          <Metric label="Current Contract Sum" value={established && !variationsError ? money(m.currentContractSum) : '—'} />
          <Metric label="Forecast Revenue" value={established && !variationsError ? money(m.forecastRevenue) : '—'} />
          <Metric label="Forecast Final Cost" value={costBasisSourceError ? '—' : money(m.forecastFinalCost)} />
          <Metric label="Forecast Gross Profit" value={established && !variationsError && !costBasisSourceError ? money(m.forecastGrossProfit) : '—'} danger={established && m.forecastGrossProfit < 0} />
          <Metric label="Forecast Margin %" value={established && !variationsError && !costBasisSourceError ? pct(m.forecastMarginPct) : '—'} danger={established && m.forecastMarginPct !== null && m.forecastMarginPct < 0} />
        </div>
        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          These are accrual figures, ex-GST. Cash figures on this page are gross and are recorded when money moves.
          A profitable project can still experience negative cash movement.
        </p>
        {!established && (
          <p className="m-0 mt-1.5 text-[11px] text-brand-amber">
            Revenue-side figures appear once a commercial baseline is set on the{' '}
            <Link to=".." className="underline">Margin</Link> view.
          </p>
        )}
        {baselineError && (
          <p className="m-0 mt-1.5 text-[11px] text-brand-amber">
            The commercial baseline could not be loaded, so revenue-side context is unavailable — not zero.
          </p>
        )}
      </Card>

      {/* ── Limitations ───────────────────────────────────────────────────── */}
      <Card>
        <p className="text-[13px] font-bold text-brand-text m-0 mb-2">Limitations</p>
        <ul className="m-0 pl-4 space-y-1.5">
          <li className="text-[11.5px] text-brand-muted">
            Cash Flow records cash entered in Constrapp. It is not a bank balance and does not include
            financing, bank feeds, bank reconciliation or an opening cash position.
          </li>
          <li className="text-[11.5px] text-brand-muted">
            Cash figures are gross. Budget, Forecast and Margin figures are primarily ex-GST and are shown separately —
            manual timing lines carry a gross cash amount and, separately, the ex-GST source value they represent.
          </li>
          <li className="text-[11.5px] text-brand-muted">
            GST or BAS payments to or refunds from the tax authority are not modelled. Actual bank movement may
            therefore differ from the net shown here.
          </li>
          <li className="text-[11.5px] text-brand-muted">
            Retention withheld ({supplierInvoicesError ? 'unavailable' : money(retentionWithheld)}) is excluded from Forecast Cash Out. Retention release is not
            modelled and no release date is invented — add a manual Cash Out line if you expect release in a
            known month.
          </li>
          <li className="text-[11.5px] text-brand-muted">
            Forecast timing is authored, not enforced: an active line can be edited after being reported, and
            Constrapp keeps no period locks or immutable snapshots. Date filtering is a later branch — the
            chart and table always show the project&apos;s full month range.
          </li>
        </ul>
      </Card>

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      {editing && (
        <LineEditorModal
          line={editing === 'new' ? null : editing}
          nowMonth={nowMonth}
          currencyCode={currencyCode}
          cashFlowLines={cashFlowLines}
          balances={editorBalances}
          baselineEstablished={established && !variationsError}
          onSave={async (fields) => {
            if (editing === 'new') await createCashFlowLine(fields)
            else await updateCashFlowLine(editing, fields)
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {voiding && (
        <LineVoidModal
          line={voiding}
          currencyCode={currencyCode}
          onConfirm={(reason) => voidCashFlowLine(voiding, reason)}
          onClose={() => setVoiding(null)}
        />
      )}
    </div>
  )
}
