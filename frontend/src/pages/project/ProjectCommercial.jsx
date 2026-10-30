import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import { formatCurrency, percent, formatDate } from '../../lib/formatters'
import { useAuth } from '../../hooks/useAuth'
import { useProfile } from '../../hooks/useProfile'
import { useProjectCommercial } from '../../hooks/useProjectCommercial'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { useCostCodes } from '../../hooks/useCostCodes'
import { usePurchaseOrders } from '../../hooks/usePurchaseOrders'
import { useProgressClaims } from '../../hooks/useProgressClaims'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useSupplierCreditNotes } from '../../hooks/useSupplierCreditNotes'
import { useVariations } from '../../hooks/useVariations'
import { useForecastLines } from '../../hooks/useForecastLines'
import { useContacts } from '../../hooks/useContacts'
import { CONTACT_TYPE } from '../../lib/contacts'
import { roundMoney } from '../../lib/purchaseOrders'
import {
  isFinancialRole, isBaselineEstablished, projectForecastTotals, computeMargin, resolveBaselineClient,
} from '../../lib/margin'
import {
  availableFigure, displayFigure, figureState, FIGURE_STATE, SNAPSHOT_SOURCE_LABELS,
} from '../../lib/projectSnapshot'
import { CREDIT_READ_UNAVAILABLE_NOTICE } from '../../lib/supplierCreditNotes'

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-2.5 py-1.5 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1'

const pct   = (n) => (n === null || n === undefined ? '—' : percent(n))

// Timestamp → 'YYYY-MM-DD' for a date input. Uses the Timestamp's own toDate()
// (no firebase import — hooks-only Firestore access is preserved).
function tsToInput(ts) {
  if (!ts || typeof ts.toDate !== 'function') return ''
  const d = ts.toDate()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const failedLabel = (failedSources) =>
  failedSources.map(src => SNAPSHOT_SOURCE_LABELS[src] ?? src).join(', ')

// `cell` is { text, unavailable } from the page's show() helper: loading "—",
// a failed source "Unavailable" (amber), otherwise the formatted value.
function Metric({ label, cell, help, danger }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <p className={`text-lg font-bold ${cell.unavailable ? 'text-brand-amber' : danger ? 'text-brand-red' : 'text-brand-text'}`}>{cell.text}</p>
      {help && <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">{help}</p>}
    </div>
  )
}

// One line of a simple reconciliation (label on the left, amount on the right).
function ReconRow({ label, cell, op, strong, danger, muted }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className={`text-[13px] ${muted ? 'text-brand-muted' : 'text-brand-text'}`}>
        {op && <span className="text-brand-muted mr-1.5">{op}</span>}{label}
      </span>
      <span className={`text-[13px] tabular-nums ${strong ? 'font-bold' : ''} ${cell.unavailable ? 'text-brand-amber' : danger ? 'text-brand-red' : muted ? 'text-brand-muted' : 'text-brand-text'}`}>
        {cell.text}
      </span>
    </div>
  )
}

// The editable baseline form. Its initial state is derived from the saved
// baseline via a useState initializer (no effect-based sync). The parent gives
// it a `key` tied to the baseline's last-saved time so a successful save (which
// updates the snapshot) remounts the form on the freshly-saved values, while
// unsaved edits persist as long as the baseline is unchanged.
//
// Save is disabled (ADR-44) while the saved baseline could not be read — the
// form would otherwise open blank and an upsert would overwrite the stored
// baseline with those blanks — and while contacts are still loading. The live
// Approved Budget is offered only once budget lines have settled cleanly.
function BaselineForm({ baseline, saveBaseline, clientContacts, contactsLoading, contactsError = false, currentApprovedBudget, budgetReady, budgetUnavailable, currencyCode, currentUserId, currentUserName, baselineError }) {
  const money = (n) => formatCurrency(n, currencyCode)

  const [form, setForm] = useState(() => ({
    ocv:        baseline?.originalContractValue != null ? String(baseline.originalContractValue) : '',
    oab:        baseline?.originalApprovedBudget != null ? String(baseline.originalApprovedBudget) : '',
    start:      tsToInput(baseline?.contractStartDate),
    completion: tsToInput(baseline?.contractCompletionDate),
    clientId:   baseline?.clientId || '',
    notes:      baseline?.notes || '',
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  const [saved, setSaved]   = useState(false)

  const ocvNum   = Number(form.ocv)
  const ocvValid = form.ocv.trim() !== '' && Number.isFinite(ocvNum) && ocvNum >= 0

  const setField = (k) => (e) => { setForm(f => ({ ...f, [k]: e.target.value })); setSaved(false); setError('') }
  const useCurrentBudget = () => {
    if (!budgetReady) return
    setForm(f => ({ ...f, oab: String(currentApprovedBudget) })); setSaved(false)
  }

  // The stored client when it is not among the loaded active client contacts —
  // contacts still loading, a failed contacts read (useContacts exposes no
  // error flag, so it looks empty), or a since-archived contact. Its stored
  // name snapshot is kept rather than erased (snapshots are never rewritten
  // from a lookup that did not resolve).
  const storedClientUnresolved = !!baseline?.clientId
    && !clientContacts.some(c => c.id === baseline.clientId)

  // A FAILED contacts read blocks the save exactly as a pending one does (D3):
  // the client picker is empty because the directory could not be read, and a
  // save now could never resolve the chosen client (ADR-55).
  const saveBlocked = baselineError || contactsLoading || contactsError

  async function onSave() {
    if (saveBlocked) return
    if (!ocvValid) { setError('Enter an Original Contract Value of 0 or more.'); return }
    // Never erases the stored client name because its contact did not resolve
    // (lib/margin.js → resolveBaselineClient).
    const client = resolveBaselineClient({ clientId: form.clientId, baseline, clientContacts })
    if (!client.ok) {
      setError('The selected client could not be found. Reload the page and select the client again.')
      return
    }
    setSaving(true); setError(''); setSaved(false)
    try {
      await saveBaseline({
        originalContractValue:  form.ocv,
        originalApprovedBudget: form.oab,
        contractStartDate:      form.start,
        contractCompletionDate: form.completion,
        clientId:               client.clientId,
        clientName:             client.clientName,
        notes:                  form.notes,
      })
      setSaved(true)
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  const updatedBy = baseline?.updatedBy
    ? (baseline.updatedBy === currentUserId ? (currentUserName || 'You') : 'Another user')
    : ''

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-[13px] font-bold text-brand-text m-0">Project commercial baseline</p>
        {baseline?.updatedAt && (
          <p className="m-0 text-[11px] text-brand-muted">
            Last updated {formatDate(baseline.updatedAt)}{updatedBy ? ` · ${updatedBy}` : ''}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <div>
          <label className={labelCls}>Original Contract Value (ex-GST) *</label>
          <input
            type="number" min="0" step="any"
            className={`${inputCls} ${form.ocv.trim() !== '' && !ocvValid ? 'border-brand-red' : ''}`}
            placeholder="0"
            value={form.ocv}
            onChange={setField('ocv')}
          />
          <p className="m-0 mt-1 text-[11px] text-brand-muted">The original head-contract sum. Required to calculate margin.</p>
        </div>

        <div>
          <label className={labelCls}>Original Approved Budget (ex-GST)</label>
          <input
            type="number" min="0" step="any"
            className={inputCls}
            placeholder="Not established"
            value={form.oab}
            onChange={setField('oab')}
          />
          <p className="m-0 mt-1 text-[11px] text-brand-muted">
            Current Approved Budget (live):{' '}
            <span className={`font-semibold ${budgetUnavailable ? 'text-brand-amber' : 'text-brand-text'}`}>
              {budgetReady ? money(currentApprovedBudget) : budgetUnavailable ? 'Unavailable' : '—'}
            </span>{' '}
            <button
              type="button"
              onClick={useCurrentBudget}
              disabled={!budgetReady}
              className="text-brand-accent hover:underline cursor-pointer disabled:text-brand-muted disabled:no-underline disabled:cursor-not-allowed"
            >
              Use current approved budget
            </button>
            . Blank leaves the original budget baseline not established. Stays editable (server-enforced immutability is deferred).
          </p>
        </div>

        <div>
          <label className={labelCls}>Contract Start Date</label>
          <input type="date" className={inputCls} value={form.start} onChange={setField('start')} />
        </div>

        <div>
          <label className={labelCls}>Contract Completion Date</label>
          <input type="date" className={inputCls} value={form.completion} onChange={setField('completion')} />
        </div>

        <div>
          <label className={labelCls}>Client</label>
          <select className={inputCls} value={form.clientId} onChange={setField('clientId')}>
            <option value="">— None —</option>
            {storedClientUnresolved && (
              <option value={baseline.clientId}>
                {baseline.clientName || 'Saved client'}{contactsLoading ? '' : ' (not an active client contact)'}
              </option>
            )}
            {clientContacts.map(c => (
              <option key={c.id} value={c.id}>{c.displayName}</option>
            ))}
          </select>
          <p className="m-0 mt-1 text-[11px] text-brand-muted">Client-type contacts only. The display name is snapshotted at save time.</p>
        </div>

        <div>
          <label className={labelCls}>Notes</label>
          <input className={inputCls} placeholder="Optional" value={form.notes} onChange={setField('notes')} />
        </div>
      </div>

      <div className="flex items-center gap-3 mt-4">
        <Btn onClick={onSave} disabled={saving || !ocvValid || saveBlocked}>
          {saving ? 'Saving…' : baseline ? 'Save baseline' : 'Create baseline'}
        </Btn>
        {saved && !saving && <Badge label="Saved" variant="completed" sm />}
        {error && <span className="text-[12px] text-brand-red">{error}</span>}
        {baselineError && !error && (
          <span className="text-[12px] text-brand-amber">
            Couldn’t load the saved baseline, so saving is disabled — a save could overwrite an existing baseline with
            blank values. Reload the page, and check your connection and permissions if this persists.
          </span>
        )}
        {!baselineError && contactsError && !error && (
          <p className="m-0 text-[11.5px] text-brand-amber">
            Contacts could not be loaded, so the client picker is empty and the baseline cannot be saved until they load.
            This does not mean there are no client contacts.
          </p>
        )}
        {!baselineError && contactsLoading && !error && (
          <span className="text-[12px] text-brand-muted">Loading client contacts…</span>
        )}
      </div>
    </Card>
  )
}

// ── Role gate ────────────────────────────────────────────────────────────────
//
// The workspace (and so every commercially-sensitive subscription, including
// contacts) is MOUNTED only for financial roles — subcontractor and client
// users never open those reads. This is the UX mirror; Firestore rules remain
// the enforced boundary.
export default function ProjectCommercial() {
  const { projectId, currencyCode } = useOutletContext()
  const { profile, profileLoading } = useProfile()

  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!isFinancialRole(profile?.role)) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Commercial data is restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          Contract value and project margin are visible to Company Admin, Project Manager, and QS roles only.
          Access is enforced by Firestore Security Rules.
        </p>
      </Card>
    )
  }
  return <CommercialWorkspace projectId={projectId} currencyCode={currencyCode} />
}

function CommercialWorkspace({ projectId, currencyCode }) {
  const money = (n) => formatCurrency(n, currencyCode)

  const { user }    = useAuth()
  const { profile } = useProfile()

  const { baseline, baselineLoading, baselineError, saveBaseline }                    = useProjectCommercial(projectId)
  const { budgetLines, budgetLinesLoading, budgetLinesError }                         = useBudgetLines(projectId)
  const { costCodes }                                                                 = useCostCodes()
  const { purchaseOrders, purchaseOrdersLoading, purchaseOrdersError }                = usePurchaseOrders(projectId)
  const { progressClaims, progressClaimsLoading, progressClaimsError }                = useProgressClaims(projectId)
  const { supplierInvoices, supplierInvoicesLoading, supplierInvoicesError }          = useSupplierInvoices(projectId)
  const { supplierCreditNotes, supplierCreditNotesLoading, supplierCreditNotesError } = useSupplierCreditNotes(projectId)
  const { variations, variationsLoading, variationsError }                            = useVariations(projectId)
  const { forecastLines, forecastLinesLoading, forecastLinesError }                   = useForecastLines(projectId)
  const { contacts, contactsLoading, contactsError }                                  = useContacts()

  // Current (live) Approved Budget = Σ budget-line budgeted. Backs the explicit
  // "Use current approved budget" action; never auto-applied to the baseline.
  const currentApprovedBudget = useMemo(
    () => roundMoney(budgetLines.reduce((s, l) => s + (Number(l.budgeted) || 0), 0)),
    [budgetLines],
  )

  const forecastTotals = useMemo(
    () => projectForecastTotals({ costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines }),
    [costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, supplierCreditNotes, variations, forecastLines],
  )

  const m = useMemo(
    () => computeMargin({ baseline, variations, forecastFinalCost: forecastTotals.forecastFinalCost, purchaseOrders }),
    [baseline, variations, forecastTotals.forecastFinalCost, purchaseOrders],
  )

  const clientContacts = useMemo(
    () => contacts.filter(c => c.isActive !== false && (c.contactTypes ?? []).includes(CONTACT_TYPE.CLIENT)),
    [contacts],
  )

  if (baselineLoading) {
    return <div className="text-[13px] text-brand-muted">Loading commercial baseline…</div>
  }

  // Loading / error flags in the Dashboard snapshot's shape (ADR-42), so every
  // figure's availability is decided by the same figureState over the sources
  // its selector actually reads (lib/projectSnapshot.js → FIGURE_DEPENDENCIES).
  const sourceStates = {
    baseline:            { loading: baselineLoading,            error: baselineError },
    budgetLines:         { loading: budgetLinesLoading,         error: budgetLinesError },
    purchaseOrders:      { loading: purchaseOrdersLoading,      error: purchaseOrdersError },
    progressClaims:      { loading: progressClaimsLoading,      error: progressClaimsError },
    supplierInvoices:    { loading: supplierInvoicesLoading,    error: supplierInvoicesError },
    supplierCreditNotes: { loading: supplierCreditNotesLoading, error: supplierCreditNotesError },
    variations:          { loading: variationsLoading,          error: variationsError },
    forecastLines:       { loading: forecastLinesLoading,       error: forecastLinesError },
  }
  const established = isBaselineEstablished(baseline)

  // A figure's display: "—" while a dependency loads, "Unavailable" when one
  // failed, otherwise the value. `needsBaseline` figures additionally render
  // "—" when the baseline has settled cleanly but carries no Original Contract
  // Value (not established) — a failed baseline read is Unavailable, never that.
  const show = (key, value, { format = money, needsBaseline = false } = {}) => {
    const f = availableFigure(key, value, sourceStates)
    if (f.state !== FIGURE_STATE.READY) {
      return { text: displayFigure(f, format), unavailable: f.state === FIGURE_STATE.UNAVAILABLE, ready: false }
    }
    if (needsBaseline && !established) return { text: '—', unavailable: false, ready: false }
    return { text: format(value), unavailable: false, ready: true }
  }
  const negative = (c, value) => c.ready && value !== null && value < 0

  const ocvCell      = show('contractBaseline', m.originalContractValue, { needsBaseline: true })
  const ccsCell      = show('currentContractSum', m.currentContractSum, { needsBaseline: true })
  const revenueCell  = show('currentContractSum', m.forecastRevenue, { needsBaseline: true })
  const ffcCell      = show('forecastFinalCost', m.forecastFinalCost)
  const profitCell   = show('margin', m.forecastGrossProfit, { needsBaseline: true })
  const marginCell   = show('margin', m.forecastMarginPct, { format: pct, needsBaseline: true })
  const oabCell      = show('contractBaseline', m.originalApprovedBudget)
  const oppCell      = show('contractBaseline', m.originalPlannedProfit)
  const opmCell      = show('contractBaseline', m.originalPlannedMarginPct, { format: pct })
  const movementCell = show('marginMovement', m.marginMovement)
  const acvCell      = show('clientVariations', m.approvedClientVariations)
  const pcvCell      = show('clientVariations', m.pendingClientVariationExposure)
  const applSvCell   = show('appliedSupplierVariations', m.appliedSupplierVariations)
  const asvCell      = show('supplierVariationExposure', m.unappliedSupplierVariations)
  const psvCell      = show('supplierVariationExposure', m.pendingSupplierVariationExposure)

  const pageSources = figureState(Object.keys(sourceStates), sourceStates)
  const budgetState = figureState(['budgetLines'], sourceStates)

  // A key tied to the last-saved time remounts the form on a fresh save while
  // preserving unsaved edits between saves.
  const formKey = baseline?.updatedAt?.toMillis ? String(baseline.updatedAt.toMillis()) : 'new'

  return (
    <div>
      {pageSources.state === FIGURE_STATE.UNAVAILABLE && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-amber m-0">Some commercial records could not be loaded</p>
          <p className="m-0 mt-1 text-[12px] text-brand-muted">
            Could not load: {failedLabel(pageSources.failedSources)}. Figures that depend on them show Unavailable
            rather than a partial total. Reload the page, and check your connection and permissions if this persists.
          </p>
          {supplierCreditNotesError && (
            <p className="m-0 mt-1 text-[12px] text-brand-muted">{CREDIT_READ_UNAVAILABLE_NOTICE}</p>
          )}
        </Card>
      )}
      {/* ── Margin summary ─────────────────────────────────────────────────── */}
      <Card className="mb-3.5">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
          <Metric label="Original Contract Value" cell={ocvCell} help="Ex-GST" />
          <Metric label="Current Contract Sum" cell={ccsCell} help="Original + approved client variations" />
          <Metric label="Forecast Revenue" cell={revenueCell} help="= Current Contract Sum" />
          <Metric label="Forecast Final Cost" cell={ffcCell} help="Estimate at Completion (EAC)" />
          <Metric label="Forecast Gross Profit" cell={profitCell} danger={negative(profitCell, m.forecastGrossProfit)} />
          <Metric label="Forecast Margin %" cell={marginCell} danger={negative(marginCell, m.forecastMarginPct)} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5 mt-4 pt-4 border-t border-brand-border">
          <Metric label="Original Approved Budget" cell={oabCell} help="Baseline (blank = not established)" />
          <Metric label="Original Planned Profit" cell={oppCell} danger={negative(oppCell, m.originalPlannedProfit)} />
          <Metric label="Original Planned Margin %" cell={opmCell} danger={negative(opmCell, m.originalPlannedMarginPct)} />
          <Metric label="Margin Movement" cell={movementCell} help="Forecast vs original planned profit" danger={negative(movementCell, m.marginMovement)} />
        </div>
        {baselineError && (
          <p className="m-0 mt-3 text-[11px] text-brand-amber">
            The commercial baseline could not be loaded, so contract value, revenue, profit and margin are unavailable.
            This does not mean the contract value has not been set.
          </p>
        )}
        {!baselineError && !established && (
          <p className="m-0 mt-3 text-[11px] text-brand-amber">
            Set and save an Original Contract Value below to calculate forecast revenue, profit, and margin.
          </p>
        )}
        {ffcCell.ready && forecastTotals.closedResidual > 0 && (
          <p className="m-0 mt-3 text-[11px] text-brand-amber">
            Forecast Final Cost includes {money(forecastTotals.closedResidual)} of commitment still open on purchase orders
            marked closed. It is left in Remaining Committed for QS judgement — review it on the Forecast or Budget tab.
          </p>
        )}
        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          All figures are ex-GST, derived at read time, and shown in this project&apos;s currency ({currencyCode}). Forecast
          Final Cost is the same Estimate at Completion shown on the Forecast tab. Currency is a label, never a conversion —
          Constrapp performs no FX conversion. Tax calculations remain Australian GST regardless of currency.
        </p>
      </Card>

      {/* ── Reconciliations ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5 mb-3.5">
        <Card>
          <p className="text-[13px] font-bold text-brand-text m-0 mb-1.5">Contract value</p>
          <ReconRow label="Original Contract Value" cell={ocvCell} />
          <ReconRow op="+" label="Approved Client Variations" cell={acvCell} />
          <div className="border-t border-brand-border my-1" />
          <ReconRow op="=" label="Current Contract Sum" cell={ccsCell} strong />
          <div className="mt-2.5 pt-2.5 border-t border-brand-border">
            <ReconRow label="Pending Client Variation Exposure" cell={pcvCell} muted />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Shown separately — pending client variations are revenue exposure and are <span className="font-semibold">not</span> included in Forecast Revenue.
            </p>
          </div>
        </Card>

        <Card>
          <p className="text-[13px] font-bold text-brand-text m-0 mb-1.5">Margin</p>
          <ReconRow label="Forecast Revenue" cell={revenueCell} />
          <ReconRow op="−" label="Forecast Final Cost" cell={ffcCell} />
          <div className="border-t border-brand-border my-1" />
          <ReconRow op="=" label="Forecast Gross Profit" cell={profitCell} strong danger={negative(profitCell, m.forecastGrossProfit)} />
          <ReconRow label="Forecast Margin %" cell={marginCell} muted />
          <div className="mt-2.5 pt-2.5 border-t border-brand-border">
            <ReconRow label="Original Planned Profit" cell={oppCell} muted />
            <ReconRow label="Margin Movement" cell={movementCell} danger={negative(movementCell, m.marginMovement)} muted />
          </div>
        </Card>
      </div>

      {/* ── Supplier cost exposure (context) ───────────────────────────────── */}
      <Card className="mb-3.5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
          <Metric label="Applied Supplier Variations" cell={applSvCell} help="Inside Forecast Final Cost via Remaining Committed" />
          <Metric label="Unapplied Supplier Variation Exposure" cell={asvCell} />
          <Metric label="Pending Supplier Variation Exposure" cell={psvCell} />
        </div>
        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          Approved supplier variations applied to a purchase order are inside Forecast Final Cost through Remaining
          Committed, once. Unapplied and pending supplier variation exposure is shown separately and is
          <span className="font-semibold"> not</span> added to Forecast Final Cost. Remove from Uncommitted Cost to
          Complete any variation cost you folded in before it was applied.
        </p>
      </Card>

      {/* ── Baseline form ──────────────────────────────────────────────────── */}
      <BaselineForm
        currencyCode={currencyCode}
        key={formKey}
        baseline={baseline}
        saveBaseline={saveBaseline}
        clientContacts={clientContacts}
        contactsError={contactsError}
        contactsLoading={contactsLoading}
        currentApprovedBudget={currentApprovedBudget}
        budgetReady={budgetState.state === FIGURE_STATE.READY}
        budgetUnavailable={budgetState.state === FIGURE_STATE.UNAVAILABLE}
        currentUserId={user?.uid}
        currentUserName={profile?.name}
        baselineError={baselineError}
      />

      <p className="m-0 mt-3 text-[11px] text-brand-muted">
        Only the baseline fields above are stored; every margin figure is derived at read time from the baseline, approved
        client variations, and Forecast Final Cost, and is never written back. Cash-flow forecasting is a later foundation.
      </p>
    </div>
  )
}
