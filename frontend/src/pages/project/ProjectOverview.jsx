import { useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import ProgBar from '../../components/ProgBar'
import { formatCurrency, percent, formatDate } from '../../lib/formatters'
import {
  CURRENCIES, CURRENCY_LOCK_EVIDENCE_SOURCES, currencyName, isProjectCurrencyLocked, monetaryLockReasons,
} from '../../lib/currency'
import { useProjects } from '../../hooks/useProjects'
import { useProfile } from '../../hooks/useProfile'
import { useProjectCommercial } from '../../hooks/useProjectCommercial'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { useCostCodes } from '../../hooks/useCostCodes'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useSupplierCreditNotes } from '../../hooks/useSupplierCreditNotes'
import { useClientInvoices } from '../../hooks/useClientInvoices'
import { useClientReceipts } from '../../hooks/useClientReceipts'
import { useSupplierPayments } from '../../hooks/useSupplierPayments'
import { useVariations } from '../../hooks/useVariations'
import { useTenderBids } from '../../hooks/useTenderBids'
import { useForecastLines } from '../../hooks/useForecastLines'
import { useBoqItems } from '../../hooks/useBoqItems'
import { useCashFlowLines } from '../../hooks/useCashFlowLines'
import {
  isFinancialRole, isBaselineEstablished, projectForecastTotals, computeMargin,
} from '../../lib/margin'
import {
  availableFigure, displayFigure, figureState, FIGURE_STATE, SNAPSHOT_SOURCE_LABELS,
} from '../../lib/projectSnapshot'
import { CREDIT_READ_UNAVAILABLE_NOTICE } from '../../lib/supplierCreditNotes'

const pct   = (n) => (n === null || n === undefined ? '—' : percent(n))

// Labels for every source this page reads — the Dashboard's labels plus the
// currency-lock evidence the Dashboard never reads.
const SOURCE_LABELS = {
  ...SNAPSHOT_SOURCE_LABELS,
  clientInvoices: 'Client Invoices',
  clientReceipts: 'Client Receipts',
  tenderBids:     'Tender Bids',
  cashFlowLines:  'Cash Flow Lines',
  boqItems:       'BOQ Items',
}
const failedLabel = (failedSources) =>
  failedSources.map(src => SOURCE_LABELS[src] ?? src).join(', ')

// Margin cards reuse the SAME lib/margin.js derivation as the Commercial tab —
// no duplicated business logic. Shown only to financial roles (commercially
// sensitive); the commercially-scoped reads are disabled for other roles so
// they never trigger a rules-denied fetch. Firestore rules are the boundary.
//
// Each card is gated on the sources its selector reads (lib/projectSnapshot.js
// → FIGURE_DEPENDENCIES — ADR-44): loading "—", failed "Unavailable", else the
// value. A failed baseline read shows the card as unavailable rather than
// hiding it; a cleanly settled baseline with no contract value still hides it.
function MarginCards({ currencyCode, costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, supplierCreditNotesError, variations, forecastLines, baseline, baselineLoading, baselineError, sourceStates }) {
  const money = (n) => formatCurrency(n, currencyCode)

  const forecastTotals = useMemo(
    () => projectForecastTotals({ costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines }),
    [costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines],
  )
  const m = useMemo(
    () => computeMargin({ baseline, variations, forecastFinalCost: forecastTotals.forecastFinalCost, purchaseOrders }),
    [baseline, variations, forecastTotals.forecastFinalCost, purchaseOrders],
  )

  if (baselineLoading) return null
  if (!baselineError && !isBaselineEstablished(baseline)) return null

  const card = (label, key, value, format = money) => {
    const f = availableFigure(key, value, sourceStates)
    return {
      label,
      text: displayFigure(f, format),
      unavailable: f.state === FIGURE_STATE.UNAVAILABLE,
      danger: f.state === FIGURE_STATE.READY && value !== null && value < 0,
    }
  }
  const cards = [
    card('Current Contract Sum',  'currentContractSum', m.currentContractSum),
    card('Forecast Final Cost',   'forecastFinalCost',  m.forecastFinalCost),
    card('Forecast Gross Profit', 'margin',             m.forecastGrossProfit),
    card('Forecast Margin %',     'margin',             m.forecastMarginPct, pct),
  ]
  const failed = figureState(
    ['baseline', 'variations', 'purchaseOrders', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes', 'forecastLines'],
    sourceStates,
  )

  return (
    <Card className="mt-3.5">
      <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-2.5">Commercial</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
        {cards.map(c => (
          <div key={c.label}>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">{c.label}</p>
            <p className={`text-lg font-bold ${c.unavailable ? 'text-brand-amber' : c.danger ? 'text-brand-red' : 'text-brand-text'}`}>{c.text}</p>
          </div>
        ))}
      </div>
      <p className="m-0 mt-3 text-[11px] text-brand-muted">
        {failed.state === FIGURE_STATE.UNAVAILABLE
          ? `⚠ Could not load: ${failedLabel(failed.failedSources)}. Figures that depend on them are unavailable${baselineError ? ' — this does not mean the contract value has not been set' : ''}.${supplierCreditNotesError ? ` ${CREDIT_READ_UNAVAILABLE_NOTICE}` : ''}`
          : 'Ex-GST, derived at read time. Full detail on the Commercial tab.'}
      </p>
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
//
// The selector is offered only once EVERY lock-evidence source has settled
// without error (lib/currency.js → CURRENCY_LOCK_EVIDENCE_SOURCES — ADR-44):
// an unsettled or failed source is an empty array, which would read as "this
// project holds no money" and offer a relabel on a legacy project whose flag
// was never set. Cash Flow Lines are lock evidence too, and only this card
// needs them, so they are subscribed here (this card is rendered only for the
// roles that may write the project — all financial roles).
function ProjectCurrencyCard({ project, projectId, currencyCode, sources: sharedSources, sourceStates: sharedStates }) {
  const { updateProjectCurrency, lockProjectCurrency } = useProjects()
  const { cashFlowLines, cashFlowLinesLoading, cashFlowLinesError } = useCashFlowLines(projectId)
  const sources = useMemo(() => ({ ...sharedSources, cashFlowLines }), [sharedSources, cashFlowLines])
  const evidence = figureState(CURRENCY_LOCK_EVIDENCE_SOURCES, {
    ...sharedStates,
    cashFlowLines: { loading: cashFlowLinesLoading, error: cashFlowLinesError },
  })
  const evidenceReady = evidence.state === FIGURE_STATE.READY

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
    // Defence in depth — the selector and button are disabled until then.
    if (!evidenceReady) return
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
                {/* `locked` can be true from the rules-enforced flag alone while the
                    evidence list is empty (a subscription still loading or denied, or a
                    record written by direct SDK — Deferred Control 12). Never render
                    "already has ." — say the flag is set and name no evidence. */}
                {reasons.length > 0
                  ? <>Locked because this project already has {reasons.join(', ')}. </>
                  : <>Locked — the currency ratchet is set on this project (its monetary records may still be loading or unavailable). </>}
                Changing currency now would relabel
                those amounts without converting them — Constrapp never converts. If the currency is wrong, raise a
                new project in the correct currency.
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px] disabled:text-brand-muted disabled:cursor-not-allowed"
                  disabled={!evidenceReady}
                  value={choice}
                  onChange={(e) => { setChoice(e.target.value); setSaved(false); setError('') }}
                >
                  {CURRENCIES.map(c => (
                    <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                  ))}
                </select>
                <Btn sm onClick={onSave} disabled={!evidenceReady || saving || choice === currencyCode}>
                  {saving ? 'Saving…' : 'Save currency'}
                </Btn>
                {saved && !saving && <span className="text-[12px] text-brand-accent">Saved</span>}
              </div>
              <p className="m-0 mt-1.5 text-[11px] text-brand-muted max-w-[560px]">
                Inherited from your company. Editable only until this project has a headline budget, budget lines,
                orders, claims, invoices, receipts, payments, variations, forecast inputs, priced BOQ items, or a
                commercial baseline — after that it locks, because changing it would relabel existing amounts
                without converting them.
              </p>
              {evidence.state === FIGURE_STATE.LOADING && (
                <p className="m-0 mt-1.5 text-[12px] text-brand-muted">
                  Checking this project&apos;s financial records before the currency can be changed…
                </p>
              )}
              {evidence.state === FIGURE_STATE.UNAVAILABLE && (
                <p className="m-0 mt-1.5 text-[12px] text-brand-amber max-w-[560px]">
                  Currency cannot be changed right now: could not load {failedLabel(evidence.failedSources)}, so
                  Constrapp cannot confirm this project holds no monetary records. Reload the page, and check your
                  connection and permissions if this persists.
                </p>
              )}
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
  const { budgetLines, budgetLinesLoading, budgetLinesError }                         = useBudgetLines(projectId)
  const { costCodes }                                                                 = useCostCodes()
  const { purchaseOrders, purchaseOrdersLoading, purchaseOrdersError }                = usePurchaseOrders(projectId)
  const { progressClaims, progressClaimsLoading, progressClaimsError }                = useProgressClaims(projectId)
  const { supplierInvoices, supplierInvoicesLoading, supplierInvoicesError }          = useSupplierInvoices(projectId)
  const { supplierCreditNotes, supplierCreditNotesLoading, supplierCreditNotesError } = useSupplierCreditNotes(projectId)
  const { clientInvoices, clientInvoicesLoading, clientInvoicesError }                = useClientInvoices(projectId)
  const { clientReceipts, clientReceiptsLoading, clientReceiptsError }                = useClientReceipts(projectId)
  const { supplierPayments, supplierPaymentsLoading, supplierPaymentsError }          = useSupplierPayments(projectId)
  const { variations, variationsLoading, variationsError }                            = useVariations(projectId)
  const { tenderBids, tenderBidsLoading, tenderBidsError }                            = useTenderBids(projectId)
  const { forecastLines, forecastLinesLoading, forecastLinesError }                   = useForecastLines(projectId)
  const { boqItems, boqItemsLoading, boqItemsError }                                  = useBoqItems(projectId)
  const { baseline, baselineLoading, baselineError }                                  = useProjectCommercial(projectId)

  // Loading / error flags in the Dashboard snapshot's shape (ADR-42), shared by
  // the margin cards and the currency card.
  const sourceStates = {
    budgetLines:         { loading: budgetLinesLoading,         error: budgetLinesError },
    purchaseOrders:      { loading: purchaseOrdersLoading,      error: purchaseOrdersError },
    progressClaims:      { loading: progressClaimsLoading,      error: progressClaimsError },
    supplierInvoices:    { loading: supplierInvoicesLoading,    error: supplierInvoicesError },
    supplierCreditNotes: { loading: supplierCreditNotesLoading, error: supplierCreditNotesError },
    clientInvoices:      { loading: clientInvoicesLoading,      error: clientInvoicesError },
    clientReceipts:      { loading: clientReceiptsLoading,      error: clientReceiptsError },
    supplierPayments:    { loading: supplierPaymentsLoading,    error: supplierPaymentsError },
    variations:          { loading: variationsLoading,          error: variationsError },
    tenderBids:          { loading: tenderBidsLoading,          error: tenderBidsError },
    forecastLines:       { loading: forecastLinesLoading,       error: forecastLinesError },
    boqItems:            { loading: boqItemsLoading,            error: boqItemsError },
    baseline:            { loading: baselineLoading,            error: baselineError },
  }

  // Client invoices, client receipts, supplier payments, BOQ items and tender
  // bids are monetary data, so all of them are part of the currency-lock
  // evidence (lib/currency.js → monetaryLockReasons) alongside every other
  // financial record. None of them feeds margin — revenue recognition is not
  // modelled, cash in is not revenue, cash out is not cost (a payment settles
  // an Actual cost the posted supplier invoice already recognised), the BOQ is
  // measurement provenance and never a financial input (only PRICED items
  // count as lock evidence — lib/currency.js applies that rule; ADR-32 Part 1),
  // and a tender bid is a decision-trail price that commits nothing (ADR-32
  // Part 2) — so all of them are deliberately absent from MarginCards below.
  // Tender PACKAGES are not subscribed here at all: they hold scope and dates,
  // never amounts, and are not lock evidence.
  const sources = useMemo(
    () => ({ budgetLines, purchaseOrders, progressClaims, supplierInvoices, clientInvoices, clientReceipts, supplierPayments, variations, tenderBids, forecastLines, boqItems, baseline }),
    [budgetLines, purchaseOrders, progressClaims, supplierInvoices, clientInvoices, clientReceipts, supplierPayments, variations, tenderBids, forecastLines, boqItems, baseline],
  )

  return (
    <>
      {canEditCurrency && (
        <ProjectCurrencyCard
          project={project}
          projectId={projectId}
          currencyCode={currencyCode}
          sources={sources}
          sourceStates={sourceStates}
        />
      )}
      <MarginCards
        currencyCode={currencyCode}
        costCodes={costCodes}
        budgetLines={budgetLines}
        purchaseOrders={purchaseOrders}
        progressClaims={progressClaims}
        supplierInvoices={supplierInvoices}
        supplierCreditNotes={supplierCreditNotes}
        supplierCreditNotesError={supplierCreditNotesError}
        variations={variations}
        forecastLines={forecastLines}
        baseline={baseline}
        baselineLoading={baselineLoading}
        baselineError={baselineError}
        sourceStates={sourceStates}
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
          {/* The HEADLINE budget — captured at creation, reporting metadata
              only. It feeds no financial derivation; the current Approved
              Budget is Σ budget lines on the Budget tab (ADR-39). */}
          <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">
            Headline Budget <span className="font-normal normal-case tracking-normal">({currencyCode})</span>
          </p>
          <p className="text-lg font-bold text-brand-text">{project.budget ? money(project.budget) : '—'}</p>
          <p className="m-0 mt-1 text-[11px] text-brand-muted">
            Set at creation. The current Approved Budget is on the Budget tab.
          </p>
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
