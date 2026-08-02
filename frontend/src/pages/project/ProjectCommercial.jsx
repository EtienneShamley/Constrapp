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
import { useVariations } from '../../hooks/useVariations'
import { useForecastLines } from '../../hooks/useForecastLines'
import { useContacts } from '../../hooks/useContacts'
import { CONTACT_TYPE } from '../../lib/contacts'
import { roundMoney } from '../../lib/purchaseOrders'
import {
  isFinancialRole, isBaselineEstablished, projectForecastTotals, computeMargin,
} from '../../lib/margin'

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

function Metric({ label, value, help, danger }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <p className={`text-lg font-bold ${danger ? 'text-brand-red' : 'text-brand-text'}`}>{value}</p>
      {help && <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">{help}</p>}
    </div>
  )
}

// One line of a simple reconciliation (label on the left, amount on the right).
function ReconRow({ label, value, op, strong, danger, muted }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className={`text-[13px] ${muted ? 'text-brand-muted' : 'text-brand-text'}`}>
        {op && <span className="text-brand-muted mr-1.5">{op}</span>}{label}
      </span>
      <span className={`text-[13px] tabular-nums ${strong ? 'font-bold' : ''} ${danger ? 'text-brand-red' : muted ? 'text-brand-muted' : 'text-brand-text'}`}>
        {value}
      </span>
    </div>
  )
}

// The editable baseline form. Its initial state is derived from the saved
// baseline via a useState initializer (no effect-based sync). The parent gives
// it a `key` tied to the baseline's last-saved time so a successful save (which
// updates the snapshot) remounts the form on the freshly-saved values, while
// unsaved edits persist as long as the baseline is unchanged.
function BaselineForm({ baseline, saveBaseline, clientContacts, currentApprovedBudget, currencyCode, currentUserId, currentUserName, baselineError }) {
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
  const useCurrentBudget = () => { setForm(f => ({ ...f, oab: String(currentApprovedBudget) })); setSaved(false) }

  async function onSave() {
    if (!ocvValid) { setError('Enter an Original Contract Value of 0 or more.'); return }
    setSaving(true); setError(''); setSaved(false)
    try {
      const client = clientContacts.find(c => c.id === form.clientId)
      await saveBaseline({
        originalContractValue:  form.ocv,
        originalApprovedBudget: form.oab,
        contractStartDate:      form.start,
        contractCompletionDate: form.completion,
        clientId:               form.clientId || null,
        clientName:             client ? client.displayName : null,
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
            Current Approved Budget (live): <span className="text-brand-text font-semibold">{money(currentApprovedBudget)}</span>{' '}
            <button type="button" onClick={useCurrentBudget} className="text-brand-accent hover:underline cursor-pointer">Use current approved budget</button>
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
        <Btn onClick={onSave} disabled={saving || !ocvValid}>
          {saving ? 'Saving…' : baseline ? 'Save baseline' : 'Create baseline'}
        </Btn>
        {saved && !saving && <Badge label="Saved" variant="completed" sm />}
        {error && <span className="text-[12px] text-brand-red">{error}</span>}
        {baselineError && !error && (
          <span className="text-[12px] text-brand-amber">Couldn’t load the saved baseline — you can still enter one below.</span>
        )}
      </div>
    </Card>
  )
}

export default function ProjectCommercial() {
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)

  const { user }    = useAuth()
  const { profile, profileLoading } = useProfile()

  const canView = isFinancialRole(profile?.role)
  // Non-financial roles never trigger the commercially-sensitive reads (rules
  // would deny them anyway — this is the UX mirror; rules are the boundary).
  const mid = canView ? projectId : null

  const { baseline, baselineLoading, baselineError, saveBaseline } = useProjectCommercial(mid)
  const { budgetLines }      = useBudgetLines(mid)
  const { costCodes }        = useCostCodes()
  const { purchaseOrders }   = usePurchaseOrders(mid)
  const { progressClaims }   = useProgressClaims(mid)
  const { supplierInvoices } = useSupplierInvoices(mid)
  const { variations }       = useVariations(mid)
  const { forecastLines }    = useForecastLines(mid)
  const { contacts }         = useContacts()

  // Current (live) Approved Budget = Σ budget-line budgeted. Backs the explicit
  // "Use current approved budget" action; never auto-applied to the baseline.
  const currentApprovedBudget = useMemo(
    () => roundMoney(budgetLines.reduce((s, l) => s + (Number(l.budgeted) || 0), 0)),
    [budgetLines],
  )

  const forecastTotals = useMemo(
    () => projectForecastTotals({ costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, variations, forecastLines }),
    [costCodes, budgetLines, purchaseOrders, progressClaims, supplierInvoices, variations, forecastLines],
  )

  const m = useMemo(
    () => computeMargin({ baseline, variations, forecastFinalCost: forecastTotals.forecastFinalCost }),
    [baseline, variations, forecastTotals.forecastFinalCost],
  )

  const clientContacts = useMemo(
    () => contacts.filter(c => c.isActive !== false && (c.contactTypes ?? []).includes(CONTACT_TYPE.CLIENT)),
    [contacts],
  )

  const established = isBaselineEstablished(baseline)

  // ── Permission / loading gates ─────────────────────────────────────────────
  if (profileLoading) {
    return <div className="text-[13px] text-brand-muted">Loading…</div>
  }
  if (!canView) {
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
  if (baselineLoading) {
    return <div className="text-[13px] text-brand-muted">Loading commercial baseline…</div>
  }

  // A key tied to the last-saved time remounts the form on a fresh save while
  // preserving unsaved edits between saves.
  const formKey = baseline?.updatedAt?.toMillis ? String(baseline.updatedAt.toMillis()) : 'new'

  return (
    <div>
      {/* ── Margin summary ─────────────────────────────────────────────────── */}
      <Card className="mb-3.5">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
          <Metric label="Original Contract Value" value={established ? money(m.originalContractValue) : '—'} help="Ex-GST" />
          <Metric label="Current Contract Sum" value={established ? money(m.currentContractSum) : '—'} help="Original + approved client variations" />
          <Metric label="Forecast Revenue" value={established ? money(m.forecastRevenue) : '—'} help="= Current Contract Sum" />
          <Metric label="Forecast Final Cost" value={money(m.forecastFinalCost)} help="Estimate at Completion (EAC)" />
          <Metric label="Forecast Gross Profit" value={established ? money(m.forecastGrossProfit) : '—'} danger={established && m.forecastGrossProfit < 0} />
          <Metric label="Forecast Margin %" value={established ? pct(m.forecastMarginPct) : '—'} danger={established && m.forecastMarginPct !== null && m.forecastMarginPct < 0} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5 mt-4 pt-4 border-t border-brand-border">
          <Metric label="Original Approved Budget" value={money(m.originalApprovedBudget)} help="Baseline (blank = not established)" />
          <Metric label="Original Planned Profit" value={money(m.originalPlannedProfit)} danger={m.originalPlannedProfit !== null && m.originalPlannedProfit < 0} />
          <Metric label="Original Planned Margin %" value={pct(m.originalPlannedMarginPct)} danger={m.originalPlannedMarginPct !== null && m.originalPlannedMarginPct < 0} />
          <Metric label="Margin Movement" value={money(m.marginMovement)} help="Forecast vs original planned profit" danger={m.marginMovement !== null && m.marginMovement < 0} />
        </div>
        {!established && (
          <p className="m-0 mt-3 text-[11px] text-brand-amber">
            Set and save an Original Contract Value below to calculate forecast revenue, profit, and margin.
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
          <ReconRow label="Original Contract Value" value={established ? money(m.originalContractValue) : '—'} />
          <ReconRow op="+" label="Approved Client Variations" value={money(m.approvedClientVariations)} />
          <div className="border-t border-brand-border my-1" />
          <ReconRow op="=" label="Current Contract Sum" value={established ? money(m.currentContractSum) : '—'} strong />
          <div className="mt-2.5 pt-2.5 border-t border-brand-border">
            <ReconRow label="Pending Client Variation Exposure" value={money(m.pendingClientVariationExposure)} muted />
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              Shown separately — pending client variations are revenue exposure and are <span className="font-semibold">not</span> included in Forecast Revenue.
            </p>
          </div>
        </Card>

        <Card>
          <p className="text-[13px] font-bold text-brand-text m-0 mb-1.5">Margin</p>
          <ReconRow label="Forecast Revenue" value={established ? money(m.forecastRevenue) : '—'} />
          <ReconRow op="−" label="Forecast Final Cost" value={money(m.forecastFinalCost)} />
          <div className="border-t border-brand-border my-1" />
          <ReconRow op="=" label="Forecast Gross Profit" value={established ? money(m.forecastGrossProfit) : '—'} strong danger={established && m.forecastGrossProfit < 0} />
          <ReconRow label="Forecast Margin %" value={established ? pct(m.forecastMarginPct) : '—'} muted />
          <div className="mt-2.5 pt-2.5 border-t border-brand-border">
            <ReconRow label="Original Planned Profit" value={money(m.originalPlannedProfit)} muted />
            <ReconRow label="Margin Movement" value={money(m.marginMovement)} danger={m.marginMovement !== null && m.marginMovement < 0} muted />
          </div>
        </Card>
      </div>

      {/* ── Supplier cost exposure (context) ───────────────────────────────── */}
      <Card className="mb-3.5">
        <div className="grid grid-cols-2 gap-3.5">
          <Metric label="Approved Supplier Variation Exposure" value={money(m.approvedSupplierVariations)} />
          <Metric label="Pending Supplier Variation Exposure" value={money(m.pendingSupplierVariationExposure)} />
        </div>
        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          Supplier variation exposure is shown separately and is <span className="font-semibold">not</span> added to Forecast
          Final Cost — variations do not yet mature against claims or invoices. Fold the remaining expected variation cost into
          Uncommitted Cost to Complete on the Forecast tab.
        </p>
      </Card>

      {/* ── Baseline form ──────────────────────────────────────────────────── */}
      <BaselineForm
        currencyCode={currencyCode}
        key={formKey}
        baseline={baseline}
        saveBaseline={saveBaseline}
        clientContacts={clientContacts}
        currentApprovedBudget={currentApprovedBudget}
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
