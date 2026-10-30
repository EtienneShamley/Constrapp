import { useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import ProgBar from '../../components/ProgBar'
import { formatCurrency } from '../../lib/formatters'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { useCostCodes } from '../../hooks/useCostCodes'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useSupplierCreditNotes } from '../../hooks/useSupplierCreditNotes'
import { useVariations } from '../../hooks/useVariations'
import { remainingCommittedByCostCode, PO_STATUS } from '../../lib/purchaseOrders'
import { actualClaimsByCostCode, claimedPendingByCostCode, recognisedClaimsByPoLine } from '../../lib/progressClaims'
import { invoicedByCostCode, invoicedClaimIds, postedInvoicedByPoLine } from '../../lib/supplierInvoices'
import { creditedByCostCode, CREDIT_READ_ERROR_NOTICE } from '../../lib/supplierCreditNotes'
import { appliedSupplierVariationAdjustments, unappliedSupplierVariationsByCostCode } from '../../lib/variations'
import {
  availableFigure, displayFigure, figureState, FIGURE_STATE, SNAPSHOT_SOURCE_LABELS,
} from '../../lib/projectSnapshot'
import { useProfile } from '../../hooks/useProfile'
import { activeCostCodes, costCodeDisplayName, resolveCostCodeName } from '../../lib/costCodes'
import { budgetLineToForm } from '../../lib/budgetLines'

const EMPTY_FORM = { costCodeId: '', budgeted: '', notes: '' }

// Roles permitted to write budget lines — the UX mirror of the Firestore
// rules, which are the enforced boundary.
const canWriteBudget = (role) =>
  role === 'company_admin' || role === 'project_manager' || role === 'qs'

// One editor, two modes (the ADR-35/36 pattern): `line` null = CREATE,
// a live budget line = EDIT.
//
// EDIT writes `budgeted` and `notes` only. The COST CODE IS IMMUTABLE and
// renders read-only:
//   · Re-pointing a line would move an approved budget to a different cost code
//     underneath existing commitments and actuals, with no record that it moved.
//     Wrong cost code → add a line on the right one.
//   · `costCodeName` is not re-snapshotted either — that would rewrite the
//     line's recorded history during an edit made only to a number. The current
//     name is resolved at READ TIME instead (lib/costCodes.js).
// Firestore rules freeze `costCodeId` and `costCodeName` independently, so
// these are UX mirrors of an enforced boundary (ADR-39).
//
// CREATE offers ACTIVE cost codes only, matching the Tenders, RFI and Timeline
// pickers. EDIT shows the line's stored code whether or not it is still active,
// so a line whose code was retired can still have its budget corrected.
function BudgetLineEditorModal({ line = null, costCodes, currencyCode, onClose, onSave }) {
  const isEdit = line !== null

  const [form, setForm]     = useState(() => (
    isEdit
      ? { costCodeId: line.costCodeId ?? '', ...budgetLineToForm(line) }
      : EMPTY_FORM
  ))
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  // New authoring must not select a retired code; an existing line keeps its
  // own regardless.
  const selectableCostCodes = activeCostCodes(costCodes)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!isEdit && !form.costCodeId) return
    setSaving(true)
    setError(null)
    try {
      if (isEdit) {
        // Cost code and its snapshot are deliberately NOT passed — the hook
        // cannot write them either.
        await onSave({ budgeted: form.budgeted, notes: form.notes })
      } else {
        const costCode = costCodes.find(cc => cc.id === form.costCodeId)
        await onSave({
          costCodeId:   form.costCodeId,
          costCodeName: costCodeDisplayName(costCode),
          budgeted:     form.budgeted,
          notes:        form.notes,
        })
      }
      onClose()
    } catch (err) {
      // A validation message from lib/budgetLines.js is actionable and shown
      // verbatim; anything else is a transport or permission failure.
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[480px] bg-brand-surface border border-brand-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">{isEdit ? 'Edit Budget Line' : 'New Budget Line'}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">
              Cost Code {!isEdit && <span className="text-brand-red">*</span>}
            </label>
            {isEdit ? (
              <>
                <p className="m-0 text-[13px] font-semibold text-brand-text">
                  {resolveCostCodeName(line.costCodeId, costCodes, line.costCodeName)}
                </p>
                <p className="m-0 mt-1 text-[11px] text-brand-muted">
                  The cost code cannot be changed — moving an approved budget between codes would relocate it
                  underneath existing commitments and actuals. Add a line on the correct code instead.
                </p>
              </>
            ) : (
              <select
                className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none"
                value={form.costCodeId}
                onChange={set('costCodeId')}
                required
                autoFocus
              >
                <option value="" disabled>Select a cost code…</option>
                {selectableCostCodes.map(cc => (
                  <option key={cc.id} value={cc.id}>{costCodeDisplayName(cc)}</option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Budgeted ({currencyCode})</label>
            <input
              type="number"
              min="0"
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
              placeholder="0"
              value={form.budgeted}
              onChange={set('budgeted')}
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5">Notes</label>
            <input
              className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none"
              placeholder="Optional"
              value={form.notes}
              onChange={set('notes')}
            />
          </div>

          {error && <p className="text-[12px] text-brand-red">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn type="submit" sm disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Line'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function ProjectBudget() {
  const navigate = useNavigate()
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)

  const { budgetLines, budgetLinesLoading, budgetLinesError, createBudgetLine, updateBudgetLine } = useBudgetLines(projectId)
  const { costCodes, costCodesLoading, costCodesError } = useCostCodes()
  const { profile } = useProfile()
  const { purchaseOrders, purchaseOrdersLoading, purchaseOrdersError } = usePurchaseOrders(projectId)
  const { progressClaims, progressClaimsLoading, progressClaimsError } = useProgressClaims(projectId)
  const { supplierInvoices, supplierInvoicesLoading, supplierInvoicesError } = useSupplierInvoices(projectId)
  const { supplierCreditNotes, supplierCreditNotesLoading, supplierCreditNotesError } = useSupplierCreditNotes(projectId)
  const { variations, variationsLoading, variationsError } = useVariations(projectId)
  // null = closed · 'new' = create · a budget line = edit that line.
  const [editing, setEditing] = useState(null)

  const canWrite = canWriteBudget(profile?.role)
  // A budget line can only be ADDED against an ACTIVE cost code, so the
  // empty/disabled states track the selectable set, not the whole library. A
  // FAILED cost-code read is not "no cost codes" — it is reported separately
  // and authoring waits (ADR-55).
  const selectableCostCodes = activeCostCodes(costCodes)
  const noCostCodes = !costCodesLoading && !costCodesError && selectableCostCodes.length === 0
  const goToCostCodes = () => navigate(`/projects/${projectId}/cost-codes`)

  // Re-resolved by id at render time so the editor always holds the live
  // document even if the subscription updated underneath it.
  const editingLine = editing && editing !== 'new'
    ? (budgetLines.find(l => l.id === editing.id) ?? null)
    : null

  async function handleSave(form) {
    if (editing === 'new') {
      await createBudgetLine(form)
      return
    }
    await updateBudgetLine(editingLine, form)
  }

  // Every figure is derived at read time from source documents — never stored on
  // budget lines.
  //
  // Committed = REMAINING OPEN COMMITMENT (ADR-55): per PO line, the line total
  //   less what has been posted against it AND less the approved claim value
  //   Actual already recognises on it (until that claim's own invoice posts and
  //   takes its place). A dollar leaves Committed at the moment it enters
  //   Actual, so the two never overlap. ONE formula — lib/purchaseOrders.js →
  //   remainingCommittedByCostCode — shared with Forecast, Commercial, Cash
  //   Flow and PULSE. Committed is deliberately NOT restored by a credit note
  //   (ADR-31): credit lines carry no poLineIndex.
  const superseded = invoicedClaimIds(supplierInvoices)
  const invoicedByLine = postedInvoicedByPoLine(supplierInvoices)
  const recognisedByLine = recognisedClaimsByPoLine(progressClaims, superseded)
  // Applied approved supplier variations (M3-B1, ADR-62) revise the PO line
  // value the nets apply to — THE shared adjustment map, computed once here.
  const adjustments = appliedSupplierVariationAdjustments(variations, purchaseOrders)
  const committedMap = remainingCommittedByCostCode(purchaseOrders, invoicedByLine, recognisedByLine, adjustments.byPoLine)
  // Closed-PO residual — the same formula restricted to CLOSED POs: commitment
  // still open on an order marked complete. Left INSIDE Committed (a closed PO
  // is still a commitment) and flagged for QS judgement, exactly as the
  // Forecast tab does; never silently released.
  const closedResidualMap = remainingCommittedByCostCode(
    purchaseOrders.filter(po => po.status === PO_STATUS.CLOSED), invoicedByLine, recognisedByLine, adjustments.byPoLine,
  )
  // Invoiced = ex-GST posted/paid supplier invoice lines by cost code, NET of
  //   posted valid-target Supplier Credit Notes. Signed, never clamped — an
  //   over-credited cost code goes negative and stays visible.
  const creditedMap = creditedByCostCode(supplierCreditNotes, supplierInvoices)
  const grossInvoicedMap = invoicedByCostCode(supplierInvoices)
  const invoicedMap = {}
  for (const cc of new Set([...Object.keys(grossInvoicedMap), ...Object.keys(creditedMap)])) {
    invoicedMap[cc] = (grossInvoicedMap[cc] || 0) - (creditedMap[cc] || 0)
  }
  // Actual = approved claims NOT yet superseded by a posted/paid invoice (read-
  //   time exclusion — the claim is never mutated) PLUS posted/paid invoices,
  //   net of credit notes (already inside invoicedMap above).
  const claimActualMap = actualClaimsByCostCode(progressClaims, superseded)
  const actualMap = {}
  for (const cc of new Set([...Object.keys(claimActualMap), ...Object.keys(invoicedMap)])) {
    actualMap[cc] = (claimActualMap[cc] || 0) + (invoicedMap[cc] || 0)
  }
  // Claimed = uncertified exposure (submitted/under review claims). Unchanged.
  const claimedMap = claimedPendingByCostCode(progressClaims)

  // Supplier variations (ADR-62). APPLIED approved PO-linked variations are
  // already INSIDE Committed above (by the PO line's cost code) and are shown
  // for transparency; UNAPPLIED approved value — legacy variations not yet
  // applied, new-scope lines awaiting M3-B2, invalid links — is the SEPARATE
  // exposure figure, never added to Committed. Commitment Exposure = Committed
  // + unapplied, so no amount is in both. Ex-GST.
  const appliedVarMap  = adjustments.byCostCode
  const supplierVarMap = unappliedSupplierVariationsByCostCode(variations, purchaseOrders)

  // POs/invoices can hit cost codes that have no budget line yet — surface those
  // as warning rows rather than hiding the commitment or cost.
  const budgetedCostCodeIds = new Set(budgetLines.map(l => l.costCodeId))
  const unbudgetedRows = [...new Set([
    ...Object.keys(committedMap),
    ...Object.keys(invoicedMap),
    ...Object.keys(actualMap),
    ...Object.keys(supplierVarMap),
  ])]
    .filter(costCodeId => !budgetedCostCodeIds.has(costCodeId))
    .map(costCodeId => {
      return {
        costCodeId,
        committed: committedMap[costCodeId] || 0,
        closedResidual: closedResidualMap[costCodeId] || 0,
        invoiced:  invoicedMap[costCodeId] || 0,
        actual:    actualMap[costCodeId] || 0,
        supplierVar: supplierVarMap[costCodeId] || 0,
        costCodeName: resolveCostCodeName(costCodeId, costCodes, null),
      }
    })

  const totals = budgetLines.reduce((acc, l) => ({
    budgeted:  acc.budgeted  + (l.budgeted  || 0),
  }), { budgeted: 0 })
  totals.committed = Object.values(committedMap).reduce((sum, v) => sum + v, 0)
  totals.closedResidual = Object.values(closedResidualMap).reduce((sum, v) => sum + v, 0)
  totals.actual    = Object.values(actualMap).reduce((sum, v) => sum + v, 0)
  totals.claimed   = Object.values(claimedMap).reduce((sum, v) => sum + v, 0)
  totals.invoiced  = Object.values(invoicedMap).reduce((sum, v) => sum + v, 0)
  // Separate, non-canonical figures. `supplierVariations` is the UNAPPLIED
  // exposure; `appliedVariations` is already inside Committed (shown, not added).
  totals.supplierVariations = Object.values(supplierVarMap).reduce((sum, v) => sum + v, 0)
  totals.appliedVariations  = Object.values(appliedVarMap).reduce((sum, v) => sum + v, 0)
  const commitmentExposure  = totals.committed + totals.supplierVariations

  const remaining     = totals.budgeted - totals.actual
  const usagePercent  = totals.budgeted > 0 ? Math.min(100, (totals.actual / totals.budgeted) * 100) : 0

  // ── READINESS — loading is not a zero, and a FAILED read is not a zero ──────
  //
  // Every figure above is derived from source documents, and a subscription
  // that has not settled — or that was REJECTED — contributes nothing, so its
  // sum is arithmetically 0 while meaning "not known". Rendering that as
  // currency states a financial fact the app does not have. The flags of every
  // source sit in the Dashboard snapshot's shape (ADR-42) and each figure is
  // gated through the SAME figureState over the sources its selector actually
  // reads (lib/projectSnapshot.js → FIGURE_DEPENDENCIES), exactly as the
  // Forecast and Commercial tabs do (ADR-44; this page was aligned by ADR-55).
  //
  //   loading → "—"   ·   a source failed → "Unavailable"   ·   settled → value
  //
  // This gates DISPLAY ONLY — the maps above are untouched.
  const sourceStates = {
    budgetLines:         { loading: budgetLinesLoading,         error: budgetLinesError },
    purchaseOrders:      { loading: purchaseOrdersLoading,      error: purchaseOrdersError },
    progressClaims:      { loading: progressClaimsLoading,      error: progressClaimsError },
    supplierInvoices:    { loading: supplierInvoicesLoading,    error: supplierInvoicesError },
    supplierCreditNotes: { loading: supplierCreditNotesLoading, error: supplierCreditNotesError },
    variations:          { loading: variationsLoading,          error: variationsError },
  }
  const cell = (key, value, format = money) => displayFigure(availableFigure(key, value, sourceStates), format)
  const ready = (key) => availableFigure(key, 0, sourceStates).state === FIGURE_STATE.READY
  const pageSources = figureState(Object.keys(sourceStates), sourceStates)
  const failedLabel = (list) => (list ?? []).map(k => SNAPSHOT_SOURCE_LABELS[k] ?? k).join(', ')
  // "—" is correct for an EMPTY settled figure in a per-row cell only when the
  // row's own sources are ready; otherwise the cell says why.
  const rowCell = (key, value, { blankZero = false } = {}) => {
    if (!ready(key)) return cell(key, value)
    return blankZero && !value ? '—' : money(value)
  }

  return (
    <div>
      {pageSources.state === FIGURE_STATE.UNAVAILABLE && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-amber m-0">Some commercial records could not be loaded</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            Could not load: {failedLabel(pageSources.failedSources)}. Every figure that depends on them shows
            Unavailable rather than a partial or zero total. Reload the page, and check your connection and
            permissions if this persists.
          </p>
          {supplierCreditNotesError && (
            <p className="m-0 mt-1 text-[12px] text-brand-muted">{CREDIT_READ_ERROR_NOTICE}</p>
          )}
        </Card>
      )}
      {costCodesError && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-amber m-0">Cost codes could not be loaded</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            Cost-code names fall back to the stored snapshot on each line and new budget lines cannot be added
            until the library loads. No figure on this page depends on the cost-code list.
          </p>
        </Card>
      )}
      <Card className="mb-3.5">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3.5 mb-3">
          <div>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Budgeted</p>
            <p className="text-lg font-bold text-brand-text">{cell('approvedBudget', totals.budgeted)}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Committed</p>
            <p className="text-lg font-bold text-brand-text">{cell('remainingCommitted', totals.committed)}</p>
            {ready('closedResidual') && totals.closedResidual > 0 && (
              <p
                className="m-0 text-[11px] text-brand-amber"
                title="Purchase orders marked closed still hold commitment that no claim or invoice has recognised. Left inside Committed for QS judgement — never silently released."
              >
                ⚠ incl. {money(totals.closedResidual)} on closed POs
              </p>
            )}
          </div>
          <div>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Claimed</p>
            <p className="text-lg font-bold text-brand-text">{cell('claimedExposure', totals.claimed)}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Actual</p>
            <p className="text-lg font-bold text-brand-text">{cell('actual', totals.actual)}</p>
          </div>
          <div>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Remaining</p>
            <p className="text-lg font-bold text-brand-text">{cell('remainingBudget', remaining)}</p>
          </div>
        </div>
        <ProgBar value={ready('remainingBudget') ? usagePercent : 0} colour={usagePercent >= 100 ? 'brand-red' : 'brand-accent'} />

        {/* Read-time variation figures (ADR-62). Applied supplier variations
            are INSIDE Committed and shown for transparency; unapplied value is
            the separate exposure Commitment Exposure adds — never both. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 mt-3 pt-3 border-t border-brand-border">
          <div>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Applied Supplier Variations</p>
            <p className="text-lg font-bold text-brand-text">{cell('appliedSupplierVariations', totals.appliedVariations)}</p>
            <p className="m-0 text-[11px] text-brand-muted">already inside Committed</p>
          </div>
          <div>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Unapplied Supplier Variations</p>
            <p className="text-lg font-bold text-brand-text">{cell('supplierVariationExposure', totals.supplierVariations)}</p>
            <p className="m-0 text-[11px] text-brand-muted">exposure — not yet in Committed</p>
          </div>
          <div>
            <p className="text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1">Commitment Exposure</p>
            <p className="text-lg font-bold text-brand-text">{cell('commitmentExposure', commitmentExposure)}</p>
          </div>
        </div>
        <p className="m-0 mt-2 text-[11px] text-brand-muted">
          Committed is the remaining open commitment: each PO line (revised by approved supplier variations applied to
          it) less what has been invoiced and less any approved claim already counted in Actual, so a cost is never in
          both. Commitment Exposure = Committed + Unapplied Supplier Variations (ex-GST) — approved variations not yet
          applied to a purchase order, new-scope variation lines awaiting M3-B2, and variations whose PO link could not
          be incorporated. All figures are ex-GST and derived at read time.
        </p>
      </Card>

      <div className="flex items-center justify-between gap-3 mb-3.5">
        <p className="text-[13px] text-brand-muted m-0">
          {noCostCodes ? 'Create an active cost code before adding budget lines.' : 'Cost code breakdown for this project.'}
        </p>
        <div className="flex items-center gap-2">
          {noCostCodes && (
            <Btn variant="ghost" sm onClick={goToCostCodes}>Go to Cost Codes</Btn>
          )}
          {canWrite && (
            <Btn sm onClick={() => setEditing('new')} disabled={costCodesLoading || costCodesError || noCostCodes}>
              + Add Budget Line
            </Btn>
          )}
        </div>
      </div>

      <Card padding={false}>
        {budgetLinesLoading ? (
          <div className="px-5 py-12 text-center text-[13px] text-brand-muted">Loading budget…</div>
        ) : budgetLinesError ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] font-bold text-brand-amber mb-1">Budget lines unavailable</p>
            <p className="text-[12px] text-brand-muted m-0">
              The budget lines could not be read. This does not mean the project has no budget — reload the page,
              and check your connection and permissions if this persists.
            </p>
          </div>
        ) : budgetLines.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-[13px] text-brand-muted mb-3">
              {noCostCodes
                ? 'Create an active cost code before adding budget lines.'
                : 'No budget lines yet. Add your first cost code allocation.'}
            </p>
            {noCostCodes ? (
              <Btn variant="ghost" onClick={goToCostCodes}>Go to Cost Codes</Btn>
            ) : canWrite && (
              <Btn onClick={() => setEditing('new')} disabled={costCodesLoading || costCodesError}>+ Add your first budget line</Btn>
            )}
          </div>
        ) : (
          // `Card` carries `overflow-hidden` for its rounded corners, so a table
          // wider than the Card is CLIPPED rather than scrolled and the last
          // column becomes unreachable. Same wrapper every other register uses.
          <div className="overflow-x-auto">
            <table className="w-full border-collapse min-w-[980px]">
              <thead>
                <tr className="bg-brand-card border-b border-brand-border">
                  {['Cost Code', 'Budgeted', 'Committed', 'Unapplied Supplier Var.', 'Actual', 'Invoiced', 'Remaining', ''].map(h => (
                    <th key={h} className="text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {budgetLines.map(line => (
                  <tr key={line.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                    {/* The CURRENT cost-code code/name, resolved live by id with
                        the line's stored snapshot as fallback — the same
                        resolution lib/forecast.js and lib/boq.js already use, so
                        a rename shows consistently on every tab. Read-time only:
                        the stored snapshot is never rewritten (ADR-39). */}
                    <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text">
                      {resolveCostCodeName(line.costCodeId, costCodes, line.costCodeName)}
                    </td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text">{money(line.budgeted || 0)}</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text">
                      {rowCell('remainingCommitted', committedMap[line.costCodeId] || 0)}
                      {ready('closedResidual') && closedResidualMap[line.costCodeId] > 0 && (
                        <span
                          className="block text-[11px] text-brand-amber"
                          title="A closed purchase order still holds commitment no claim or invoice has recognised. Left visible for QS judgement — not removed from Committed."
                        >
                          ⚠ incl. {money(closedResidualMap[line.costCodeId])} on closed PO
                        </span>
                      )}
                    </td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text">{rowCell('supplierVariationExposure', supplierVarMap[line.costCodeId] || 0, { blankZero: true })}</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text">{rowCell('actual', actualMap[line.costCodeId] || 0)}</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-text">{rowCell('invoiced', invoicedMap[line.costCodeId] || 0)}</td>
                    <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-text">
                      {rowCell('remainingBudget', (line.budgeted || 0) - (actualMap[line.costCodeId] || 0))}
                    </td>
                    <td className="px-3.5 py-3">
                      {canWrite && <Btn variant="ghost" sm onClick={() => setEditing(line)}>Edit</Btn>}
                    </td>
                  </tr>
                ))}
                {unbudgetedRows.map(row => (
                  <tr key={row.costCodeId} className="border-b border-brand-border bg-brand-amber/5">
                    <td className="px-3.5 py-3 text-[13px] font-semibold text-brand-amber">
                      {row.costCodeName}
                      <span className="block text-[11px] font-normal">Cost against a code with no budget line</span>
                    </td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-muted">—</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-amber">
                      {rowCell('remainingCommitted', row.committed, { blankZero: true })}
                      {ready('closedResidual') && row.closedResidual > 0 && (
                        <span className="block text-[11px]">⚠ incl. {money(row.closedResidual)} on closed PO</span>
                      )}
                    </td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-amber">{rowCell('supplierVariationExposure', row.supplierVar, { blankZero: true })}</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-amber">{rowCell('actual', row.actual, { blankZero: true })}</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-amber">{rowCell('invoiced', row.invoiced, { blankZero: true })}</td>
                    <td className="px-3.5 py-3 text-[13px] text-brand-muted">—</td>
                    <td className="px-3.5 py-3" />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {(editing === 'new' || editingLine) && (
        <BudgetLineEditorModal
          key={editing === 'new' ? 'new' : editingLine.id}
          line={editing === 'new' ? null : editingLine}
          currencyCode={currencyCode}
          costCodes={costCodes}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
    </div>
  )
}
