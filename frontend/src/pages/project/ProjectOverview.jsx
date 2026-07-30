import { useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import ProgBar from '../../components/ProgBar'
import { currency, percent, formatDate } from '../../lib/formatters'
import { useProfile } from '../../hooks/useProfile'
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

const money = (n) => (n === null || n === undefined ? '—' : currency(n))
const pct   = (n) => (n === null || n === undefined ? '—' : percent(n))

// Margin cards reuse the SAME lib/margin.js derivation as the Commercial tab —
// no duplicated business logic. Shown only to financial roles (commercially
// sensitive); the commercially-scoped reads are disabled for other roles so
// they never trigger a rules-denied fetch. Firestore rules are the boundary.
function MarginCards({ projectId }) {
  const { budgetLines }      = useBudgetLines(projectId)
  const { costCodes }        = useCostCodes()
  const { purchaseOrders }   = usePurchaseOrders(projectId)
  const { progressClaims }   = useProgressClaims(projectId)
  const { supplierInvoices } = useSupplierInvoices(projectId)
  const { variations }       = useVariations(projectId)
  const { forecastLines }    = useForecastLines(projectId)
  const { baseline, baselineLoading } = useProjectCommercial(projectId)

  const forecastTotals = useMemo(
    () => projectForecastTotals({ costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, variations, forecastLines }),
    [costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, variations, forecastLines],
  )
  const m = useMemo(
    () => computeMargin({ baseline, variations, forecastFinalCost: forecastTotals.forecastFinalCost }),
    [baseline, variations, forecastTotals.forecastFinalCost],
  )

  if (baselineLoading || !isBaselineEstablished(baseline)) return null

  const cards = [
    { label: 'Current Contract Sum', value: money(m.currentContractSum) },
    { label: 'Forecast Final Cost',  value: money(m.forecastFinalCost) },
    { label: 'Forecast Gross Profit', value: money(m.forecastGrossProfit), danger: m.forecastGrossProfit < 0 },
    { label: 'Forecast Margin %',    value: pct(m.forecastMarginPct), danger: m.forecastMarginPct !== null && m.forecastMarginPct < 0 },
  ]

  return (
    <Card className="mt-3.5">
      <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-2.5">Commercial</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
        {cards.map(c => (
          <div key={c.label}>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">{c.label}</p>
            <p className={`text-lg font-bold ${c.danger ? 'text-brand-red' : 'text-brand-text'}`}>{c.value}</p>
          </div>
        ))}
      </div>
      <p className="m-0 mt-3 text-[11px] text-brand-muted">Ex-GST, derived at read time. Full detail on the Commercial tab.</p>
    </Card>
  )
}

export default function ProjectOverview() {
  const { project, projectId } = useOutletContext()
  const { profile } = useProfile()

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <Card>
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Budget</p>
          <p className="text-lg font-bold text-brand-text">{project.budget ? currency(project.budget) : '—'}</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Start Date</p>
          <p className="text-lg font-bold text-brand-text">{formatDate(project.startDate)}</p>
        </Card>
        <Card>
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Progress</p>
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex-1"><ProgBar value={project.progress ?? 0} /></div>
            <span className="text-[11px] text-brand-muted w-8 text-right">{project.progress ?? 0}%</span>
          </div>
        </Card>
      </div>

      {isFinancialRole(profile?.role) && <MarginCards projectId={projectId} />}
    </div>
  )
}
