import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatCurrency, formatDate } from '../../lib/formatters'
import { useAuth } from '../../hooks/useAuth'
import { useProfile } from '../../hooks/useProfile'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { useCostCodes } from '../../hooks/useCostCodes'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useSupplierCreditNotes } from '../../hooks/useSupplierCreditNotes'
import { useVariations } from '../../hooks/useVariations'
import { useForecastLines } from '../../hooks/useForecastLines'
import {
  buildForecastRows, composeForecastRow, forecastRollups, remainingBudgetSuggestion,
} from '../../lib/forecast'
import { isFinancialRole } from '../../lib/margin'
import {
  availableFigure, displayFigure, figureState, FIGURE_DEPENDENCIES, FIGURE_STATE, SNAPSHOT_SOURCE_LABELS,
} from '../../lib/projectSnapshot'
import { CREDIT_READ_UNAVAILABLE_NOTICE } from '../../lib/supplierCreditNotes'

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-2.5 py-1.5 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const thCls    = 'text-left px-3 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px] whitespace-nowrap'
const tdCls    = 'px-3 py-3 text-[13px] text-brand-text whitespace-nowrap'

const FILTERS = [
  ['all',          'All'],
  ['not_forecast', 'Not forecast'],
  ['over_budget',  'Forecast over budget'],
  ['unbudgeted',   'Unbudgeted'],
]

const storedCtcString = (v) => (v === null || v === undefined ? '' : String(v))

const failedLabel = (failedSources) =>
  failedSources.map(src => SNAPSHOT_SOURCE_LABELS[src] ?? src).join(', ')

// One summary figure. Loading renders "—", a failed source "Unavailable" (and
// names it), and only a READY figure prints money — a settled 0 is a real $0.
function Figure({ label, figure, money, help, dangerWhenNegative = false }) {
  const unavailable = figure.state === FIGURE_STATE.UNAVAILABLE
  const danger = dangerWhenNegative && figure.state === FIGURE_STATE.READY && figure.value < 0
  return (
    <div>
      <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">{label}</p>
      <p className={`text-lg font-bold ${unavailable ? 'text-brand-amber' : danger ? 'text-brand-red' : 'text-brand-text'}`}>
        {displayFigure(figure, money)}
      </p>
      {unavailable
        ? <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">Could not load: {failedLabel(figure.failedSources)}</p>
        : help && <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">{help}</p>}
    </div>
  )
}

// `figures` come from lib/projectSnapshot.js → availableFigure, each gated on
// the sources its selector actually reads (FIGURE_DEPENDENCIES) — so one failed
// source never hides an unrelated card.
function SummaryCards({ figures, currencyCode }) {
  const money = (n) => formatCurrency(n, currencyCode)

  const core = [
    { label: 'Approved Budget',     figure: figures.budgeted },
    { label: 'Actual',              figure: figures.actual,             help: 'Cost to Date' },
    { label: 'Remaining Committed', figure: figures.remainingCommitted },
    { label: 'Forecast Final Cost', figure: figures.forecastFinalCost,  help: 'Estimate at Completion (EAC)' },
    { label: 'Variance to Budget',  figure: figures.varianceToBudget,   help: 'Variance at Completion (VAC)', dangerWhenNegative: true },
  ]
  return (
    <>
      <Card className="mb-3.5">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3.5">
          {core.map(c => (
            <Figure key={c.label} label={c.label} figure={c.figure} money={money} help={c.help} dangerWhenNegative={c.dangerWhenNegative} />
          ))}
        </div>
        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          Forecast Final Cost = Actual + Remaining Committed + Uncommitted Cost to Complete. Variance to Budget =
          Budgeted − Forecast Final Cost — positive is under budget, negative is over budget. All figures ex-GST and
          derived at read time.
        </p>
      </Card>

      <Card className="mb-3.5">
        <div className="grid grid-cols-2 gap-3.5">
          <Figure label="Approved Supplier Variation Exposure" figure={figures.approvedSupplierVariations} money={money} />
          <Figure label="Pending Supplier Variation Exposure" figure={figures.pendingSupplierVariationExposure} money={money} />
        </div>
        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          Supplier variation exposure is shown separately because variations do not yet mature against claims or
          invoices and may overlap Actual or manually forecast cost. It is <span className="font-semibold">not</span> added
          to Forecast Final Cost — account for the remaining expected variation cost within Uncommitted Cost to Complete.
        </p>
      </Card>
    </>
  )
}

// ── Role gate ────────────────────────────────────────────────────────────────
//
// The Forecast reads supplier invoices, credit notes, variations and forecast
// lines — all financial-role-only under Firestore Security Rules — alongside
// budget lines, POs and claims, which rules let every company member read. A
// non-financial user would therefore see a forecast built from PARTIAL records.
// This wrapper renders the workspace (and so MOUNTS its subscriptions) only for
// financial roles: subcontractor and client users never open them. This is the
// UX mirror; Firestore rules remain the enforced boundary.
export default function ProjectForecast() {
  const { projectId, currencyCode } = useOutletContext()
  const { profile, profileLoading } = useProfile()

  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!isFinancialRole(profile?.role)) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Forecast data is restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          Forecast cost, commitments and actual cost are visible to Company Admin, Project Manager, and QS roles only.
          Firestore Security Rules restrict the supplier invoice, credit note, variation and forecast records a
          forecast needs to those roles.
        </p>
      </Card>
    )
  }
  return <ForecastWorkspace projectId={projectId} currencyCode={currencyCode} />
}

function ForecastWorkspace({ projectId, currencyCode }) {
  const money = (n) => formatCurrency(n, currencyCode)

  const { user }    = useAuth()
  const { profile } = useProfile()
  const { budgetLines, budgetLinesLoading, budgetLinesError }                         = useBudgetLines(projectId)
  const { costCodes, costCodesLoading }                                               = useCostCodes()
  const { purchaseOrders, purchaseOrdersLoading, purchaseOrdersError }                = usePurchaseOrders(projectId)
  const { progressClaims, progressClaimsLoading, progressClaimsError }                = useProgressClaims(projectId)
  const { supplierInvoices, supplierInvoicesLoading, supplierInvoicesError }          = useSupplierInvoices(projectId)
  const { supplierCreditNotes, supplierCreditNotesLoading, supplierCreditNotesError } = useSupplierCreditNotes(projectId)
  const { variations, variationsLoading, variationsError }                            = useVariations(projectId)
  const { forecastLines, forecastLinesLoading, forecastLinesError, upsertForecastLine } = useForecastLines(projectId)

  // The loading / error flags of every source, in the Dashboard snapshot's
  // shape (ADR-42), so availability is decided by the same figureState.
  const sourceStates = {
    budgetLines:         { loading: budgetLinesLoading,         error: budgetLinesError },
    purchaseOrders:      { loading: purchaseOrdersLoading,      error: purchaseOrdersError },
    progressClaims:      { loading: progressClaimsLoading,      error: progressClaimsError },
    supplierInvoices:    { loading: supplierInvoicesLoading,    error: supplierInvoicesError },
    supplierCreditNotes: { loading: supplierCreditNotesLoading, error: supplierCreditNotesError },
    variations:          { loading: variationsLoading,          error: variationsError },
    forecastLines:       { loading: forecastLinesLoading,       error: forecastLinesError },
  }
  // The table, its counts and every row figure depend on the full cost-code
  // union. Cost codes add no row and no amount, but supply the live name a
  // save stores — so editing also waits for them. (useCostCodes exposes no
  // error flag: a failed read is indistinguishable from an empty list, and
  // names then fall back to the stored snapshot — ADR-44 limitation.)
  const rows = figureState(FIGURE_DEPENDENCIES.forecastRows, sourceStates)
  const rowsReady = rows.state === FIGURE_STATE.READY
  const editable = rowsReady && !costCodesLoading

  const [edits, setEdits]         = useState({})   // costCodeId → { ctc: string, notes: string }
  const [savingId, setSavingId]   = useState(null) // costCodeId | 'all' | null
  const [rowErrors, setRowErrors] = useState({})   // costCodeId → message
  const [search, setSearch]       = useState('')
  const [filter, setFilter]       = useState('all')

  const baseRows = useMemo(
    () => buildForecastRows({ costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines }),
    [costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines],
  )

  // Overlay unsaved edits and compute the input-dependent outputs from the
  // effective value, so the UI updates immediately as the user types.
  const effectiveRows = useMemo(() => baseRows.map(row => {
    const edit = edits[row.costCodeId]
    const ctcStr = edit ? edit.ctc : storedCtcString(row.storedUncommittedCostToComplete)
    const notesStr = edit ? edit.notes : (row.notes || '')

    const trimmed = ctcStr.trim()
    const parsed = trimmed === '' ? null : Number(trimmed)
    const ctcInvalid  = parsed !== null && !Number.isFinite(parsed)
    const ctcNegative = parsed !== null && Number.isFinite(parsed) && parsed < 0
    const ctcForCalc  = ctcInvalid ? null : parsed // junk contributes zero for display

    const dirty = ctcStr !== storedCtcString(row.storedUncommittedCostToComplete) || notesStr !== (row.notes || '')

    // The shared composer supplies every figure and flag (the same one
    // projectForecastTotals uses with the SAVED input). Only the input-specific
    // overlay lives here: an invalid entry is "invalid", never "Not forecast".
    const composed = composeForecastRow(row, ctcForCalc)
    return {
      ...composed,
      ctcStr, notesStr,
      unforecasted: composed.unforecasted && trimmed === '',
      ctcInvalid, ctcNegative, dirty,
    }
  }), [baseRows, edits])

  const rollups   = useMemo(() => forecastRollups(effectiveRows), [effectiveRows])
  const dirtyRows = effectiveRows.filter(r => r.dirty)

  const fig = (key, value) => availableFigure(key, value, sourceStates)
  const figures = {
    budgeted:                         fig('approvedBudget', rollups.budgeted),
    actual:                           fig('actual', rollups.actual),
    remainingCommitted:               fig('remainingCommitted', rollups.remainingCommitted),
    forecastFinalCost:                fig('forecastFinalCost', rollups.forecastFinalCost),
    varianceToBudget:                 fig('varianceToBudget', rollups.varianceToBudget),
    approvedSupplierVariations:       fig('supplierVariationExposure', rollups.approvedSupplierVariations),
    pendingSupplierVariationExposure: fig('supplierVariationExposure', rollups.pendingSupplierVariationExposure),
  }

  const visibleRows = effectiveRows.filter(r => {
    if (search.trim() && !(r.costCodeName || '').toLowerCase().includes(search.trim().toLowerCase())) return false
    if (filter === 'not_forecast' && !r.unforecasted) return false
    if (filter === 'over_budget'  && !r.overBudget) return false
    if (filter === 'unbudgeted'   && r.hasBudgetLine) return false
    return true
  })

  const liveNameFor = (id) => {
    const cc = costCodes.find(c => c.id === id)
    return cc ? `${cc.code} — ${cc.name}` : '' // '' ⇒ hook keeps the stored name
  }

  const setCtc = (row, value) =>
    setEdits(e => ({ ...e, [row.costCodeId]: { ctc: value, notes: row.notesStr } }))
  const setNotes = (row, value) =>
    setEdits(e => ({ ...e, [row.costCodeId]: { ctc: row.ctcStr, notes: value } }))
  const applyRemainingBudget = (row) => editable &&
    setEdits(e => ({ ...e, [row.costCodeId]: { ctc: String(remainingBudgetSuggestion(row.remainingBudgetRef)), notes: row.notesStr } }))

  const clearError = (id) => setRowErrors(e => { const n = { ...e }; delete n[id]; return n })
  const clearEdit  = (id) => setEdits(e => { const n = { ...e }; delete n[id]; return n })

  async function persist(row) {
    // Defence in depth — every save control is already disabled until then.
    if (!editable) throw new Error('Forecast records are still loading or could not be loaded. Nothing was saved.')
    if (row.ctcInvalid)  throw new Error('Enter a valid number, or clear it to mark as not forecast')
    if (row.ctcNegative) throw new Error('Uncommitted Cost to Complete cannot be negative')
    const ctcValue = row.ctcStr.trim() === '' ? null : Number(row.ctcStr)
    await upsertForecastLine(row.costCodeId, {
      costCodeName: liveNameFor(row.costCodeId),
      uncommittedCostToComplete: ctcValue,
      notes: row.notesStr,
    })
    clearEdit(row.costCodeId) // fall back to the refreshed stored value
  }

  async function saveRow(row) {
    setSavingId(row.costCodeId)
    clearError(row.costCodeId)
    try {
      await persist(row)
    } catch (err) {
      setRowErrors(e => ({ ...e, [row.costCodeId]: err?.message || 'Failed to save. Check your connection and try again.' }))
    } finally {
      setSavingId(null)
    }
  }

  async function saveAll() {
    if (!editable) return
    // Validate every dirty row up front — never partially save past an invalid one.
    for (const r of dirtyRows) {
      if (r.ctcInvalid || r.ctcNegative) {
        setRowErrors(e => ({ ...e, [r.costCodeId]: r.ctcNegative ? 'Uncommitted Cost to Complete cannot be negative' : 'Enter a valid number, or clear it to mark as not forecast' }))
        return
      }
    }
    setSavingId('all')
    try {
      for (const r of dirtyRows) {
        clearError(r.costCodeId)
        try {
          await persist(r)
        } catch (err) {
          setRowErrors(e => ({ ...e, [r.costCodeId]: err?.message || 'Failed to save.' }))
        }
      }
    } finally {
      setSavingId(null)
    }
  }

  const updatedByLabel = (uid) => {
    if (!uid) return ''
    if (uid === user?.uid) return profile?.name || 'You'
    return 'Another user'
  }

  const rowSaving = (id) => savingId === id || savingId === 'all'

  return (
    <div>
      {rows.state === FIGURE_STATE.UNAVAILABLE && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-amber m-0">Some forecast records could not be loaded</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            Could not load: {failedLabel(rows.failedSources)}. Figures that depend on them show Unavailable, and the
            cost-code table and editing are disabled because every row depends on the full set of records. Unsaved
            changes are kept. Reload the page, and check your connection and permissions if this persists.
          </p>
          {supplierCreditNotesError && (
            <p className="m-0 mt-1 text-[12px] text-brand-muted">{CREDIT_READ_UNAVAILABLE_NOTICE}</p>
          )}
        </Card>
      )}
      <SummaryCards figures={figures} currencyCode={currencyCode} />

      {/* Toolbar: unforecasted count + save-all */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          {rows.state === FIGURE_STATE.LOADING
            ? 'Loading forecast…'
            : !rowsReady
              ? 'Forecast coverage unavailable.'
              : rollups.unforecastedCount > 0
                ? `${rollups.unforecastedCount} of ${rollups.lineCount} cost code${rollups.lineCount === 1 ? '' : 's'} not yet forecast.`
                : rollups.lineCount > 0
                  ? 'Every cost code has been forecast.'
                  : 'No cost codes or commercial activity yet.'}
        </p>
        <Btn sm onClick={saveAll} disabled={!editable || dirtyRows.length === 0 || savingId !== null}>
          {savingId === 'all' ? 'Saving…' : `Save all changes${dirtyRows.length ? ` (${dirtyRows.length})` : ''}`}
        </Btn>
      </div>

      {/* Search + filters */}
      {editable && baseRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3.5">
          <input
            className={`${inputCls} max-w-[260px]`}
            placeholder="Search cost code…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(([val, label]) => (
              <button
                key={val}
                onClick={() => setFilter(val)}
                className={`px-3 py-1.5 text-[12.5px] font-semibold rounded-lg transition-colors ${filter === val ? 'bg-brand-accent/15 text-brand-accent' : 'text-brand-muted hover:text-brand-text'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <Card padding={false}>
        {rows.state === FIGURE_STATE.UNAVAILABLE ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-amber">
            Forecast unavailable — could not load: {failedLabel(rows.failedSources)}.
          </div>
        ) : !editable ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading forecast…</div>
        ) : baseRows.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">
            No cost codes with budget, commitment, actual cost, or variations yet. Add budget lines or raise a purchase
            order, then forecast each cost code here.
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">No cost codes match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['Cost Code', 'Budgeted', 'Actual', 'Rem. Committed', 'Appr. Supplier Var.', 'Pending Supplier Exp.', 'Rem. Budget Ref.', 'Uncommitted CTC', 'Cost to Complete', 'Forecast Final Cost', 'Variance', 'Notes', 'Last Updated', ''].map((h, i) => (
                    <th key={i} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(row => {
                  const err = rowErrors[row.costCodeId]
                  return (
                    <tr
                      key={row.costCodeId}
                      className={`border-b border-brand-border align-top ${row.hasBudgetLine ? 'hover:bg-brand-card' : 'bg-brand-amber/5'} transition-colors`}
                    >
                      {/* Cost Code */}
                      <td className={`${tdCls} whitespace-normal min-w-[180px]`}>
                        <span className={`font-semibold ${row.hasBudgetLine ? 'text-brand-text' : 'text-brand-amber'}`}>{row.costCodeName}</span>
                        {!row.hasBudgetLine && (
                          <span className="block text-[11px] font-normal text-brand-amber">Cost against a code with no budget line</span>
                        )}
                        {row.isInactive && (
                          <span className="block text-[11px] font-normal text-brand-muted">Inactive cost code</span>
                        )}
                      </td>

                      {/* Budgeted */}
                      <td className={tdCls}>{row.hasBudgetLine ? money(row.budgeted || 0) : '—'}</td>

                      {/* Actual */}
                      <td className={tdCls}>{money(row.actual || 0)}</td>

                      {/* Remaining Committed (+ closed-PO residual flag) */}
                      <td className={tdCls}>
                        {money(row.remainingCommitted || 0)}
                        {row.closedResidual > 0 && (
                          <span
                            className="block text-[11px] text-brand-amber"
                            title="A closed purchase order still holds uninvoiced commitment. Left visible for QS judgement — not removed from the forecast."
                          >
                            ⚠ incl. {money(row.closedResidual)} on closed PO
                          </span>
                        )}
                      </td>

                      {/* Approved Supplier Variations (context) */}
                      <td className={tdCls}>{row.approvedSupplierVariations ? money(row.approvedSupplierVariations) : '—'}</td>

                      {/* Pending Supplier Variation Exposure (context) */}
                      <td className={tdCls}>{row.pendingSupplierVariationExposure ? money(row.pendingSupplierVariationExposure) : '—'}</td>

                      {/* Remaining Budget Reference (informational) */}
                      <td className={tdCls}>{row.hasBudgetLine ? money(row.remainingBudgetRef) : '—'}</td>

                      {/* Uncommitted Cost to Complete (editable) */}
                      <td className={`${tdCls} min-w-[150px]`}>
                        <input
                          type="number" min="0" step="any"
                          className={`${inputCls} ${row.ctcNegative || row.ctcInvalid ? 'border-brand-red' : ''} ${row.unforecasted ? 'italic' : ''}`}
                          placeholder="Not forecast"
                          value={row.ctcStr}
                          onChange={e => setCtc(row, e.target.value)}
                        />
                        <button
                          type="button"
                          onClick={() => applyRemainingBudget(row)}
                          disabled={!editable}
                          className="mt-1 text-[11px] text-brand-accent hover:underline cursor-pointer disabled:text-brand-muted disabled:no-underline disabled:cursor-not-allowed"
                          title="Copy the Remaining Budget Reference into this input (0 if it is zero or negative). You can edit it afterward."
                        >
                          Use remaining budget
                        </button>
                        {row.unforecasted && <span className="block text-[11px] text-brand-muted mt-0.5">Not forecast</span>}
                      </td>

                      {/* Cost to Complete (derived) */}
                      <td className={tdCls}>{money(row.costToComplete)}</td>

                      {/* Forecast Final Cost (derived) */}
                      <td className={`${tdCls} font-semibold`}>{money(row.forecastFinalCost)}</td>

                      {/* Variance to Budget (derived) */}
                      <td className={`${tdCls} font-semibold ${row.hasBudgetLine && row.overBudget ? 'text-brand-red' : 'text-brand-text'}`}>
                        {row.hasBudgetLine ? money(row.varianceToBudget) : '—'}
                      </td>

                      {/* Notes (editable) */}
                      <td className={`${tdCls} min-w-[160px] whitespace-normal`}>
                        <input
                          className={inputCls}
                          placeholder="Optional"
                          value={row.notesStr}
                          onChange={e => setNotes(row, e.target.value)}
                        />
                      </td>

                      {/* Last Updated */}
                      <td className={`${tdCls} text-brand-muted text-[12px]`}>
                        {row.updatedAt ? (
                          <>
                            {formatDate(row.updatedAt)}
                            <span className="block text-[11px]">{updatedByLabel(row.updatedBy)}</span>
                          </>
                        ) : '—'}
                      </td>

                      {/* Save action */}
                      <td className={`${tdCls} min-w-[92px]`}>
                        {row.dirty ? (
                          <Btn sm variant="success" onClick={() => saveRow(row)} disabled={!editable || rowSaving(row.costCodeId)}>
                            {savingId === row.costCodeId ? 'Saving…' : 'Save'}
                          </Btn>
                        ) : row.hasForecastLine ? (
                          <Badge label="Saved" variant="completed" sm />
                        ) : null}
                        {err && <span className="block text-[11px] text-brand-red mt-1">{err}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="m-0 mt-3 text-[11px] text-brand-muted">
        Uncommitted Cost to Complete is the only stored input — the Estimate to Complete for work not already represented
        by Actual or Remaining Committed. Blank means the cost code has not been forecast; 0 means reviewed with no further
        uncommitted cost expected. The current forecast is a living editable input, not an immutable financial record;
        reporting periods, approvals, and historical snapshots are future work.
      </p>
    </div>
  )
}
