import { useMemo, useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatCurrency } from '../../lib/formatters'
import { useProfile } from '../../hooks/useProfile'
import { useBoqItems } from '../../hooks/useBoqItems'
import { useCostCodes } from '../../hooks/useCostCodes'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { isFinancialRole } from '../../lib/margin'
import {
  BOQ_STATUS, BOQ_STATUS_LABELS, BOQ_BADGE_VARIANTS,
  isPriced, activeBoqItems, voidBoqItems,
  boqTotals, budgetedTotal, boqVarianceToBudget, boqVsBudgetRows,
  sortBoqItems, formatQuantity,
} from '../../lib/boq'
import BoqItemEditorModal from './boq/BoqItemEditorModal'
import BoqItemVoidModal from './boq/BoqItemVoidModal'

// ── Bill of Quantities ───────────────────────────────────────────────────────
//
// The project's measured schedule: cost-coded items with quantity, unit, and —
// once priced — a rate and a derived amount. The BOQ feeds NO financial figure
// (Budgeted, Committed, Actual, Invoiced, Forecast, Margin, and Cash Flow are
// untouched); the only derived output is the read-time BOQ-vs-Approved-Budget
// comparison on this page (lib/boq.js, ADR-32 Part 1). Estimating (margin /
// overheads) and BOQ → Budget transfer are later branches.

const thCls = 'text-left px-3 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px] whitespace-nowrap'
const tdCls = 'px-3 py-3 text-[13px] text-brand-text whitespace-nowrap'

function SummaryCards({ totals, budgetTotal, budgetUnavailable, variance, currencyCode }) {
  const money = (n) => formatCurrency(n, currencyCode)

  return (
    <Card className="mb-3.5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
        <div>
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">BOQ Total (priced)</p>
          <p className="text-lg font-bold text-brand-text">{money(totals.pricedTotal)}</p>
          <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">Ex-GST · {totals.pricedCount} of {totals.itemCount} items priced</p>
        </div>
        <div>
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Approved Budget</p>
          <p className="text-lg font-bold text-brand-text">{budgetUnavailable ? '—' : money(budgetTotal)}</p>
          {budgetUnavailable && <p className="m-0 mt-0.5 text-[10.5px] text-brand-red">Unavailable — budget failed to load</p>}
        </div>
        <div>
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Variance to Budget</p>
          <p className={`text-lg font-bold ${variance !== null && variance < 0 ? 'text-brand-red' : 'text-brand-text'}`}>
            {variance === null || budgetUnavailable ? '—' : money(variance)}
          </p>
          <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">
            {budgetUnavailable
              ? 'Needs the Approved Budget'
              : variance === null
                ? (totals.itemCount === 0 ? 'No BOQ items yet' : 'Suppressed while items are unpriced')
                : 'Budget − BOQ · positive = BOQ under budget'}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Unpriced Items</p>
          <p className={`text-lg font-bold ${totals.unpricedCount > 0 ? 'text-brand-amber' : 'text-brand-text'}`}>
            {totals.unpricedCount}
          </p>
        </div>
      </div>
      <p className="m-0 mt-3 text-[11px] text-brand-muted">
        Ex-GST, derived at read time. The BOQ is measurement provenance only — it never changes the Approved
        Budget or any committed, actual, forecast, margin, or cash-flow figure.
      </p>
    </Card>
  )
}

// Per-cost-code comparison — read-time only, never stored. Union of codes
// appearing in the BOQ or the budget; variance is suppressed (—) wherever
// either side is missing or the code still has unpriced items.
function BudgetComparison({ rows, budgetUnavailable, currencyCode }) {
  const money = (n) => formatCurrency(n, currencyCode)

  if (rows.length === 0) return null

  return (
    <Card padding={false} className="mt-3.5">
      <div className="px-5 pt-4 pb-1">
        <p className="text-[13px] font-bold text-brand-text m-0">BOQ vs Approved Budget by cost code</p>
        <p className="text-[11.5px] text-brand-muted m-0 mt-0.5">
          Read-time comparison only — nothing here is written back to the budget or anywhere else.
          {budgetUnavailable && <span className="text-brand-red"> The budget failed to load, so budget figures are unavailable.</span>}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-brand-card border-b border-brand-border">
              {['Cost Code', 'BOQ (ex-GST)', 'Budgeted', 'Variance', ''].map((h, i) => (
                <th key={i} className={thCls}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.costCodeId} className="border-b border-brand-border last:border-b-0">
                <td className={`${tdCls} font-semibold`}>
                  {row.costCodeName}
                  {row.isInactive && <span className="ml-1.5 text-[10.5px] font-normal text-brand-muted">(inactive)</span>}
                  {row.isMissing && <span className="ml-1.5 text-[10.5px] font-normal text-brand-amber">(unknown code)</span>}
                </td>
                <td className={tdCls}>{row.boqAmount === null ? '—' : money(row.boqAmount)}</td>
                <td className={tdCls}>{budgetUnavailable ? '—' : row.budgeted === null ? '—' : money(row.budgeted)}</td>
                <td className={`${tdCls} font-semibold ${row.variance !== null && row.variance < 0 ? 'text-brand-red' : ''}`}>
                  {budgetUnavailable || row.variance === null ? '—' : money(row.variance)}
                </td>
                <td className={`${tdCls} text-[11px] text-brand-muted`}>
                  {row.boqUnpricedCount > 0
                    ? `${row.boqUnpricedCount} unpriced — variance suppressed`
                    : row.boqItemCount === 0
                      ? 'No BOQ items'
                      : row.budgeted === null ? 'No budget line' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export default function ProjectBoq() {
  const navigate = useNavigate()
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)

  const { profile, profileLoading } = useProfile()
  const canView = isFinancialRole(profile?.role)
  // Non-financial roles never trigger the commercially-sensitive reads (rules
  // would deny them anyway — this is the UX mirror; rules are the boundary).
  const mid = canView ? projectId : null

  const {
    boqItems, boqItemsLoading, boqItemsError,
    createBoqItem, updateBoqItem, voidBoqItem,
  } = useBoqItems(mid)
  const { costCodes, costCodesLoading } = useCostCodes()
  const { budgetLines, budgetLinesError } = useBudgetLines(mid)

  const [editing, setEditing] = useState(null)      // item | 'new' | null
  const [voiding, setVoiding] = useState(null)      // item | null
  const [showVoided, setShowVoided] = useState(false)

  const active = useMemo(() => sortBoqItems(activeBoqItems(boqItems)), [boqItems])
  const voided = useMemo(() => sortBoqItems(voidBoqItems(boqItems)), [boqItems])

  const totals = useMemo(() => boqTotals(boqItems), [boqItems])
  const budgetTotal = useMemo(() => budgetedTotal(budgetLines), [budgetLines])
  const variance = boqVarianceToBudget(budgetTotal, totals)
  const comparisonRows = useMemo(
    () => boqVsBudgetRows({ costCodes, boqItems, budgetLines }),
    [costCodes, boqItems, budgetLines],
  )

  const noCostCodes = !costCodesLoading && costCodes.length === 0
  const goToCostCodes = () => navigate(`/projects/${projectId}/cost-codes`)

  // ── Gates ──────────────────────────────────────────────────────────────────
  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!canView) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">The BOQ is restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          The Bill of Quantities is the project&apos;s internal estimate and is visible to Company Admin,
          Project Manager, and QS roles only. Access is enforced by Firestore Security Rules.
        </p>
      </Card>
    )
  }

  const renderRow = (item) => {
    const isVoid = item.status === BOQ_STATUS.VOID
    return (
      <tr key={item.id} className={`border-b border-brand-border last:border-b-0 ${isVoid ? 'opacity-60' : 'hover:bg-brand-card transition-colors'}`}>
        <td className={tdCls}>{item.itemNumber || '—'}</td>
        <td className={tdCls}>{item.section || '—'}</td>
        <td className={`${tdCls} !whitespace-normal min-w-[180px] font-semibold`}>{item.description}</td>
        <td className={tdCls}>{item.costCodeName || '—'}</td>
        <td className={`${tdCls} text-right`}>{formatQuantity(item.quantity)}</td>
        <td className={tdCls}>{item.unit}</td>
        <td className={`${tdCls} text-right`}>
          {isPriced(item.rate)
            ? formatCurrency(item.rate, currencyCode, { precise: true })
            : <span className="text-brand-amber font-semibold">Unpriced</span>}
        </td>
        <td className={`${tdCls} text-right font-semibold`}>
          {isPriced(item.rate) ? money(item.amount) : '—'}
        </td>
        <td className={tdCls}>
          <Badge label={BOQ_STATUS_LABELS[item.status] ?? item.status} variant={BOQ_BADGE_VARIANTS[item.status]} sm />
        </td>
        <td className={`${tdCls} text-right`}>
          {!isVoid && (
            <span className="inline-flex gap-1.5">
              <Btn variant="ghost" sm onClick={() => setEditing(item)}>Edit</Btn>
              <Btn variant="ghost" sm onClick={() => setVoiding(item)}>Void</Btn>
            </span>
          )}
        </td>
      </tr>
    )
  }

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-3.5">
        <div>
          <h2 className="text-[16px] font-bold text-brand-text m-0">Bill of Quantities</h2>
          <p className="text-[12.5px] text-brand-muted m-0 mt-0.5">
            Measured quantities by cost code — leave the rate blank until an item is priced.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {noCostCodes && <Btn variant="ghost" sm onClick={goToCostCodes}>Go to Cost Codes</Btn>}
          <Btn sm onClick={() => setEditing('new')} disabled={costCodesLoading || costCodes.length === 0}>
            + Add BOQ Item
          </Btn>
        </div>
      </div>

      {/* ── Source-failure banner (never shown as zeros) ──────────────────── */}
      {boqItemsError && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-red m-0">The BOQ failed to load</p>
          <p className="text-[11.5px] text-brand-text m-0 mt-1">
            Totals and the budget comparison are unavailable — not zero. Check your connection and reload.
          </p>
        </Card>
      )}

      {!boqItemsError && (
        <SummaryCards
          totals={totals}
          budgetTotal={budgetTotal}
          budgetUnavailable={budgetLinesError}
          variance={variance}
          currencyCode={currencyCode}
        />
      )}

      {/* ── Register ──────────────────────────────────────────────────────── */}
      <Card padding={false}>
        {boqItemsLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading BOQ…</div>
        ) : boqItemsError ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">The BOQ is unavailable.</div>
        ) : active.length === 0 && voided.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {noCostCodes
                ? 'Create a cost code before adding BOQ items — every item is measured against one.'
                : 'No BOQ items yet. Add your first measured quantity.'}
            </p>
            {noCostCodes ? (
              <Btn variant="ghost" onClick={goToCostCodes}>Go to Cost Codes</Btn>
            ) : (
              <Btn onClick={() => setEditing('new')}>+ Add your first BOQ item</Btn>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['Item', 'Section', 'Description', 'Cost Code', 'Qty', 'Unit', 'Rate', 'Amount', 'Status', ''].map((h, i) => (
                    <th key={i} className={`${thCls} ${['Qty', 'Rate', 'Amount'].includes(h) ? 'text-right' : ''}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {active.map(renderRow)}
                {showVoided && voided.map(renderRow)}
              </tbody>
            </table>
          </div>
        )}
        {voided.length > 0 && !boqItemsLoading && !boqItemsError && (
          <div className="px-5 py-3 border-t border-brand-border">
            <button
              onClick={() => setShowVoided(v => !v)}
              className="text-[12px] text-brand-muted hover:text-brand-text cursor-pointer min-h-[44px]"
            >
              {showVoided ? 'Hide' : 'Show'} {voided.length} voided item{voided.length === 1 ? '' : 's'}
            </button>
          </div>
        )}
      </Card>

      {/* ── BOQ vs Budget ─────────────────────────────────────────────────── */}
      {!boqItemsError && (
        <BudgetComparison rows={comparisonRows} budgetUnavailable={budgetLinesError} currencyCode={currencyCode} />
      )}

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      {editing !== null && (
        <BoqItemEditorModal
          item={editing === 'new' ? null : editing}
          costCodes={costCodes}
          currencyCode={currencyCode}
          onClose={() => setEditing(null)}
          onSave={(draft) => editing === 'new' ? createBoqItem(draft) : updateBoqItem(editing, draft)}
        />
      )}
      {voiding !== null && (
        <BoqItemVoidModal
          item={voiding}
          currencyCode={currencyCode}
          onClose={() => setVoiding(null)}
          onConfirm={(reason) => voidBoqItem(voiding, reason)}
        />
      )}
    </div>
  )
}
