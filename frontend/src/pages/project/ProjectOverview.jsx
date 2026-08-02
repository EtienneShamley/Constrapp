import { useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import ProgBar from '../../components/ProgBar'
import { formatCurrency, percent, formatDate } from '../../lib/formatters'
import {
  CURRENCIES, currencyName, isProjectCurrencyLocked, monetaryLockReasons,
} from '../../lib/currency'
import { useProjects } from '../../hooks/useProjects'
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

const pct   = (n) => (n === null || n === undefined ? '—' : percent(n))

// Margin cards reuse the SAME lib/margin.js derivation as the Commercial tab —
// no duplicated business logic. Shown only to financial roles (commercially
// sensitive); the commercially-scoped reads are disabled for other roles so
// they never trigger a rules-denied fetch. Firestore rules are the boundary.
function MarginCards({ currencyCode, costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, variations, forecastLines, baseline, baselineLoading }) {
  const money = (n) => formatCurrency(n, currencyCode)

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

// ── Project currency ─────────────────────────────────────────────────────────
//
// The ONE place a project's currency can be changed. Shown only to the roles
// that may write the project document (company_admin / project_manager), which
// are also financial roles — so the commercially-scoped reads below are always
// permitted for this component's audience.
//
// The lock is evaluated from LIVE financial data (lib/currency.js →
// isProjectCurrencyLocked), not just the stored flag, because a project created
// before this foundation carries no flag yet but may hold years of records.
// Firestore rules cannot make this determination — they cannot enumerate
// random-id subcollections — so this check is CLIENT-enforced; the rules
// enforce the one-way ratchet once the flag is set.
function ProjectCurrencyCard({ project, projectId, currencyCode, sources }) {
  const { updateProjectCurrency, lockProjectCurrency } = useProjects()

  const [choice, setChoice] = useState(currencyCode)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  const [saved, setSaved]   = useState(false)
  const healedFor           = useRef(null)

  const reasons = useMemo(() => monetaryLockReasons({ ...sources, project }), [sources, project])
  const locked  = isProjectCurrencyLocked(project, sources)

  // Self-heal the ratchet: a project that already holds monetary data but has no
  // stored flag (created before this foundation, or a lock write that failed)
  // gets its flag engaged the first time an admin or project manager opens the
  // Overview. Idempotent and best-effort — the hook swallows failures.
  useEffect(() => {
    if (!projectId || project?.currencyLocked === true) return
    if (!reasons.length) return
    if (healedFor.current === projectId) return
    healedFor.current = projectId
    lockProjectCurrency(projectId)
  }, [projectId, project?.currencyLocked, reasons.length, lockProjectCurrency])

  async function onSave() {
    setSaving(true); setError(''); setSaved(false)
    try {
      await updateProjectCurrency(projectId, choice)
      setSaved(true)
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="mt-3.5">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Project currency</p>
          {locked ? (
            <>
              <p className="text-lg font-bold text-brand-text m-0">
                {currencyCode} <span className="text-[13px] font-normal text-brand-muted">{currencyName(currencyCode)}</span>
                <span className="ml-2 text-[13px]" aria-label="Locked">🔒</span>
              </p>
              <p className="m-0 mt-1 text-[11px] text-brand-muted max-w-[560px]">
                Locked because this project already has {reasons.join(', ')}. Changing currency now would relabel
                those amounts without converting them — Constrapp never converts. If the currency is wrong, raise a
                new project in the correct currency.
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px]"
                  value={choice}
                  onChange={(e) => { setChoice(e.target.value); setSaved(false); setError('') }}
                >
                  {CURRENCIES.map(c => (
                    <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                  ))}
                </select>
                <Btn sm onClick={onSave} disabled={saving || choice === currencyCode}>
                  {saving ? 'Saving…' : 'Save currency'}
                </Btn>
                {saved && !saving && <span className="text-[12px] text-brand-accent">Saved</span>}
              </div>
              <p className="m-0 mt-1.5 text-[11px] text-brand-muted max-w-[560px]">
                Inherited from your company. Editable only until this project has a headline budget, budget lines,
                orders, claims, invoices, variations, forecast inputs, or a commercial baseline — after that it locks,
                because changing it would relabel existing amounts without converting them.
              </p>
              {error && <p className="m-0 mt-1.5 text-[12px] text-brand-red">{error}</p>}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}

// Roles permitted to write the project document (and therefore its currency).
// UX mirror of the Firestore rules, which are the enforced boundary.
const canEditProjectCurrency = (role) => role === 'company_admin' || role === 'project_manager'

// Mounts the commercially-scoped subscriptions EXACTLY ONCE and shares them
// with both financial cards below (the currency card needs them to evaluate the
// lock; the margin cards need them to derive margin). Rendered only for
// financial roles, so non-financial roles never trigger a rules-denied fetch —
// Firestore rules remain the boundary.
function ProjectFinancialCards({ project, projectId, currencyCode, canEditCurrency }) {
  const { budgetLines }      = useBudgetLines(projectId)
  const { costCodes }        = useCostCodes()
  const { purchaseOrders }   = usePurchaseOrders(projectId)
  const { progressClaims }   = useProgressClaims(projectId)
  const { supplierInvoices } = useSupplierInvoices(projectId)
  const { variations }       = useVariations(projectId)
  const { forecastLines }    = useForecastLines(projectId)
  const { baseline, baselineLoading } = useProjectCommercial(projectId)

  const sources = useMemo(
    () => ({ budgetLines, purchaseOrders, progressClaims, supplierInvoices, variations, forecastLines, baseline }),
    [budgetLines, purchaseOrders, progressClaims, supplierInvoices, variations, forecastLines, baseline],
  )

  return (
    <>
      {canEditCurrency && (
        <ProjectCurrencyCard
          project={project}
          projectId={projectId}
          currencyCode={currencyCode}
          sources={sources}
        />
      )}
      <MarginCards
        currencyCode={currencyCode}
        costCodes={costCodes}
        budgetLines={budgetLines}
        purchaseOrders={purchaseOrders}
        progressClaims={progressClaims}
        supplierInvoices={supplierInvoices}
        variations={variations}
        forecastLines={forecastLines}
        baseline={baseline}
        baselineLoading={baselineLoading}
      />
    </>
  )
}

export default function ProjectOverview() {
  const { project, projectId, currencyCode } = useOutletContext()
  const { profile } = useProfile()
  const money = (n) => formatCurrency(n, currencyCode)

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <Card>
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">
            Budget <span className="font-normal normal-case tracking-normal">({currencyCode})</span>
          </p>
          <p className="text-lg font-bold text-brand-text">{project.budget ? money(project.budget) : '—'}</p>
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

      {isFinancialRole(profile?.role) && (
        <ProjectFinancialCards
          project={project}
          projectId={projectId}
          currencyCode={currencyCode}
          canEditCurrency={canEditProjectCurrency(profile?.role)}
        />
      )}
    </div>
  )
}
