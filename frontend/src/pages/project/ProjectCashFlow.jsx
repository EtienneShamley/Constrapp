import { useMemo } from 'react'
import { useOutletContext, Link } from 'react-router-dom'
import Card from '../../components/Card'
import { formatCurrency, percent } from '../../lib/formatters'
import { useProfile } from '../../hooks/useProfile'
import { useClientReceipts } from '../../hooks/useClientReceipts'
import { useSupplierPayments } from '../../hooks/useSupplierPayments'
import { useProjectCommercial } from '../../hooks/useProjectCommercial'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { useCostCodes } from '../../hooks/useCostCodes'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useVariations } from '../../hooks/useVariations'
import { useForecastLines } from '../../hooks/useForecastLines'
import {
  isFinancialRole, isBaselineEstablished, projectForecastTotals, computeMargin,
} from '../../lib/margin'
import { cashInRows, receiptSummary } from '../../lib/clientReceipts'
import { cashOutRows, paymentSummary } from '../../lib/supplierPayments'
import {
  buildMonthlyActualRows, totalActualCashIn, totalActualCashOut, actualNetCash,
  monthLabel, currentMonthKey,
} from '../../lib/cashFlow'

// ── Cash Flow — ACTUAL cash foundation ───────────────────────────────────────
//
// Recorded cash movement only: posted Client Receipts (cash in, by receiptDate)
// and posted Supplier Payments (cash out, by paymentDate), grouped monthly with
// a cumulative position that starts at ZERO — net project cash movement, not a
// bank balance. Forecast Cash Flow (invoice due-date collections, manual
// monthly timing, peak funding) and charts are later foundations.
//
// This page WRITES NOTHING. It reads existing collections through existing
// hooks and derives every figure at render time (ADR-3/ADR-4). It never
// mutates a receipt, payment, invoice, PO, claim, variation, forecast line, or
// the commercial baseline, and it adds no Firestore rules — the existing
// financial-role rules on the collections it reads are the security boundary.

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

  // The two cash subscriptions this page is about.
  const { clientReceipts, clientReceiptsLoading, clientReceiptsError } = useClientReceipts(mid)
  const { supplierPayments, supplierPaymentsLoading, supplierPaymentsError } = useSupplierPayments(mid)

  // Commercial-context subscriptions — the SAME composition the Margin view and
  // Overview cards use (projectForecastTotals + computeMargin), so no margin
  // logic is duplicated. Ten live subscriptions in total on this page.
  const { baseline, baselineError } = useProjectCommercial(mid)
  const { budgetLines }      = useBudgetLines(mid)
  const { costCodes }        = useCostCodes()
  const { purchaseOrders }   = usePurchaseOrders(mid)
  const { progressClaims }   = useProgressClaims(mid)
  const { supplierInvoices } = useSupplierInvoices(mid)
  const { variations }       = useVariations(mid)
  const { forecastLines }    = useForecastLines(mid)

  // ── Actual cash derivation (read-time, nothing stored) ─────────────────────
  const inRows  = useMemo(() => cashInRows(clientReceipts, { projectId }), [clientReceipts, projectId])
  const outRows = useMemo(() => cashOutRows(supplierPayments, { projectId }), [supplierPayments, projectId])

  const monthlyRows = useMemo(() => buildMonthlyActualRows(inRows, outRows), [inRows, outRows])
  const cashIn  = useMemo(() => totalActualCashIn(inRows), [inRows])
  const cashOut = useMemo(() => totalActualCashOut(outRows), [outRows])
  const netCash = actualNetCash(cashIn, cashOut)

  // Unallocated cash — the EXISTING derivations, never re-implemented.
  const receiptTotals = useMemo(() => receiptSummary(clientReceipts), [clientReceipts])
  const paymentTotals = useMemo(() => paymentSummary(supplierPayments), [supplierPayments])

  // ── Commercial context (accrual, ex-GST — shared derivation) ───────────────
  const forecastTotals = useMemo(
    () => projectForecastTotals({ costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, variations, forecastLines }),
    [costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, variations, forecastLines],
  )
  const m = useMemo(
    () => computeMargin({ baseline, variations, forecastFinalCost: forecastTotals.forecastFinalCost }),
    [baseline, variations, forecastTotals.forecastFinalCost],
  )
  const established = isBaselineEstablished(baseline)

  const nowMonth = currentMonthKey()

  // ── Permission / loading / error gates ─────────────────────────────────────
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
  // No zero totals while the cash subscriptions are unresolved.
  if (clientReceiptsLoading || supplierPaymentsLoading) {
    return <div className="text-[13px] text-brand-muted">Loading cash records…</div>
  }
  // A failed subscription must never be presented as zero cash.
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

  const hasCash = monthlyRows.length > 0

  return (
    <div>
      {/* ── 1 · Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-3.5">
        <div>
          <h2 className="text-[16px] font-bold text-brand-text m-0">Cash Flow</h2>
          <p className="text-[12.5px] text-brand-muted m-0 mt-0.5">Recorded cash movement on this project.</p>
        </div>
        <p className="text-[12px] m-0">
          <Link to="../receipts" className="text-brand-accent hover:underline">Client Receipts</Link>
          <span className="text-brand-muted"> · </span>
          <Link to="../supplier-payments" className="text-brand-accent hover:underline">Supplier Payments</Link>
        </p>
      </div>

      {hasCash ? (
        <>
          {/* ── 2 · Actual summary ─────────────────────────────────────────── */}
          <Card className="mb-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              <Metric label="Actual Cash In" value={money(cashIn)} help={`${receiptTotals.postedCount} posted client receipt${receiptTotals.postedCount === 1 ? '' : 's'} · gross, full amounts`} />
              <Metric label="Actual Cash Out" value={money(cashOut)} help={`${paymentTotals.postedCount} posted supplier payment${paymentTotals.postedCount === 1 ? '' : 's'} · gross, full amounts`} />
              <Metric label="Actual Net Cash" value={money(netCash)} help="Cash In − Cash Out" danger={netCash < 0} />
            </div>
            <p className="m-0 mt-3 text-[11px] text-brand-muted">
              Posted transactions only — drafts and voids count nothing. Amounts are the full gross cash that moved,
              including money not yet allocated to an invoice, shown in this project&apos;s currency ({currencyCode}).
            </p>
          </Card>

          {/* ── 3 · Monthly actual table ───────────────────────────────────── */}
          <Card padding={false} className="mb-3.5">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse">
                <thead>
                  <tr className="bg-brand-card">
                    <th className={thCls}>Month</th>
                    <th className={`${thCls} text-right`}>Actual Cash In</th>
                    <th className={`${thCls} text-right`}>Actual Cash Out</th>
                    <th className={`${thCls} text-right`}>Actual Net</th>
                    <th className={`${thCls} text-right`}>Cumulative Position</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyRows.map((row) => (
                    <tr key={row.monthKey} className="border-b border-brand-border hover:bg-brand-card">
                      <td className="px-3.5 py-2.5 text-[12.5px] text-brand-text whitespace-nowrap">
                        {monthLabel(row.monthKey)}
                        {row.monthKey === nowMonth && (
                          <span className="ml-2 text-[10.5px] font-semibold text-brand-accent">Current</span>
                        )}
                      </td>
                      <td className={`${tdMoney} text-brand-text`}>{money(row.actualCashIn)}</td>
                      <td className={`${tdMoney} text-brand-text`}>{money(row.actualCashOut)}</td>
                      <td className={`${tdMoney} ${row.actualNet < 0 ? 'text-brand-red' : 'text-brand-text'}`}>{money(row.actualNet)}</td>
                      <td className={`${tdMoney} font-semibold ${row.cumulativePosition < 0 ? 'text-brand-red' : 'text-brand-text'}`}>{money(row.cumulativePosition)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-3.5 py-3 border-t border-brand-border">
              <p className="m-0 text-[11px] text-brand-muted">
                Cash is grouped by the date money moved. Receipt Date drives Cash In and Payment Date drives Cash Out.
              </p>
              <p className="m-0 mt-1 text-[11px] text-brand-muted">
                Cumulative net cash movement on this project. Not a bank balance. Constrapp does not model a bank
                account, an opening cash position or project financing. This shows cash recorded into and out of this
                project only.
              </p>
            </div>
          </Card>

          {/* ── 4 · Unallocated cash ───────────────────────────────────────── */}
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
          </Card>
        </>
      ) : (
        /* ── 7 · Empty state ──────────────────────────────────────────────── */
        <Card className="mb-3.5">
          <div className="text-center py-8">
            <p className="text-[14px] font-bold text-brand-text m-0">No recorded cash movement yet</p>
            <p className="text-[12.5px] text-brand-muted m-0 mt-1.5">
              Post a <Link to="../receipts" className="text-brand-accent hover:underline">Client Receipt</Link> or{' '}
              <Link to="../supplier-payments" className="text-brand-accent hover:underline">Supplier Payment</Link>{' '}
              to begin building the project&apos;s Actual Cash Flow.
            </p>
          </div>
        </Card>
      )}

      {/* ── 5 · Commercial context (accrual, ex-GST) ─────────────────────────
           Visually separate from every cash figure: read-time context from the
           SAME shared derivation the Margin view uses. Never added to a cash
           total, never plotted against cash, never modified here. */}
      <Card className="mb-3.5">
        <p className="text-[13px] font-bold text-brand-text m-0 mb-3">Commercial context — accrual, ex-GST</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
          <Metric label="Current Contract Sum" value={established ? money(m.currentContractSum) : '—'} />
          <Metric label="Forecast Revenue" value={established ? money(m.forecastRevenue) : '—'} />
          <Metric label="Forecast Final Cost" value={money(m.forecastFinalCost)} />
          <Metric label="Forecast Gross Profit" value={established ? money(m.forecastGrossProfit) : '—'} danger={established && m.forecastGrossProfit < 0} />
          <Metric label="Forecast Margin %" value={established ? pct(m.forecastMarginPct) : '—'} danger={established && m.forecastMarginPct !== null && m.forecastMarginPct < 0} />
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

      {/* ── 6 · Limitations ──────────────────────────────────────────────── */}
      <Card>
        <p className="text-[13px] font-bold text-brand-text m-0 mb-2">Limitations</p>
        <ul className="m-0 pl-4 space-y-1.5">
          <li className="text-[11.5px] text-brand-muted">
            Actual Cash Flow records cash entered in Constrapp. It is not a bank balance and does not include
            financing, bank feeds, bank reconciliation or an opening cash position.
          </li>
          <li className="text-[11.5px] text-brand-muted">
            Cash figures are gross. Budget, Forecast and Margin figures are primarily ex-GST and are shown separately.
          </li>
          <li className="text-[11.5px] text-brand-muted">
            GST or BAS payments to or refunds from the tax authority are not modelled. Actual bank movement may
            therefore differ from the net shown here.
          </li>
          <li className="text-[11.5px] text-brand-muted">
            Forecast Cash Flow, expected invoice collections, expected supplier payments, manual monthly timing and
            peak funding are not included in this Actual Cash Flow foundation.
          </li>
        </ul>
      </Card>
    </div>
  )
}
