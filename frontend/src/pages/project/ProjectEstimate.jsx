import { useMemo, useState } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Badge from '../../components/Badge'
import WriteFeedback from '../../components/WriteFeedback'
import { formatCurrency, formatDate } from '../../lib/formatters'
import { useProfile } from '../../hooks/useProfile'
import { useBoqItems } from '../../hooks/useBoqItems'
import { useCostCodes } from '../../hooks/useCostCodes'
import { useBudgetLines } from '../../hooks/useBudgetLines'
import { useEstimates, useEstimateLines } from '../../hooks/useEstimates'
import { useBoqBudgetTransfer } from '../../hooks/useBoqBudgetTransfer'
import { useWriteAction } from '../../hooks/useWriteAction'
import { isFinancialRole } from '../../lib/margin'
import { formatQuantity } from '../../lib/boq'
import {
  ESTIMATE_STATE, ESTIMATE_STATE_LABELS, ESTIMATE_BADGE_VARIANTS,
  PRICING_POLICY, PRICING_POLICY_LABELS, ALLOWANCE_MODE, ALLOWANCE_MODE_LABELS,
  COST_CLASS, COST_CLASS_LABELS, ASSIGNABLE_COST_CLASSES, COMPONENT_KEYS, COMPONENT_LABELS,
  canPrepareEstimate, canApproveEstimate, defaultEstimateSettings, estimateSettingsProblem, normaliseEstimateSettings,
  buildEstimateLines, describeEstimateProblems, estimateTotals, estimateByCostCode, estimateDrift, achievedBps,
  currentApprovedEstimate, centsToAmount, percentTextToBps, bpsToPercentText, formatBps, componentsProblem,
  budgetHandoverCents, ESTIMATE_SETTINGS_KEYS,
} from '../../lib/estimating'
import BoqBudgetTransferModal from './boq/BoqBudgetTransferModal'
import { useCommercialActivation } from '../../hooks/useCommercialActivation'
import CommercialMaintenanceNotice from '../../components/CommercialMaintenanceNotice'

// ── Estimate (ADR-97 — Phase 2 step 7) ───────────────────────────────────────
//
// The commercial pricing layer over the BOQ. This page authors NO quantity and
// NO rate (those stay on the BOQ tab) and computes nothing of its own: every
// figure is lib/estimating.js — the same module the trusted `estimateOperation`
// callable runs on records it reads itself. The page's writes are that
// callable's four operations only; Firestore Rules refuse any client write to
// the estimate collections.
//
// TWO KINDS OF FIGURE, never mixed:
//   · a STORED REVISION — built by the server from the BOQ as it stood, kept
//     with its own lines; a draft can be rebuilt or approved, an approved
//     revision is permanent;
//   · the LIVE PREVIEW — the settings in the form applied to the BOQ as it is
//     now, labelled as a preview and never an estimate of record.
// "Source" says whether the live BOQ is still the BOQ a stored revision priced.

const thCls = 'text-left px-3 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px] whitespace-nowrap'
const tdCls = 'px-3 py-2.5 text-[12.5px] text-brand-text'
const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-2.5 py-1.5 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1'
const LINE_PAGE = 100

const settingsFrom = (estimate) => (estimate
  ? normaliseEstimateSettings(Object.fromEntries(ESTIMATE_SETTINGS_KEYS.map(k => [k, estimate[k] ?? defaultEstimateSettings()[k]])))
  : defaultEstimateSettings())

function Figure({ label, value, hint, strong = false, danger = false }) {
  return (
    <div>
      <p className={labelCls}>{label}</p>
      <p className={`m-0 tabular-nums ${strong ? 'text-lg font-black' : 'text-[15px] font-bold'} ${danger ? 'text-brand-red' : 'text-brand-text'}`}>{value}</p>
      {hint && <p className="m-0 mt-0.5 text-[10.5px] text-brand-muted">{hint}</p>}
    </div>
  )
}

// The cost build-up and the price — used for a stored revision and the preview.
function Totals({ totals, settings, currencyCode }) {
  const money = (cents) => formatCurrency(centsToAmount(cents), currencyCode, { precise: true })
  const achieved = achievedBps(totals.costTotalCents, totals.sellCents)
  const allowanceHint = (mode, bps) => (mode === ALLOWANCE_MODE.PERCENTAGE ? `${formatBps(bps)} of construction cost` : ALLOWANCE_MODE_LABELS[mode])
  const analysed = totals.boqTotalCents - totals.unanalysedCents
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3.5">
        <Figure label="Direct cost" value={money(totals.directCents)} hint="BOQ items not classified otherwise" />
        <Figure label="Preliminaries" value={money(totals.preliminariesCents)} hint="Cost-coded BOQ items" />
        <Figure label="Overheads" value={money(totals.overheadCents)} hint={allowanceHint(settings.overheadMode, settings.overheadBps)} />
        <Figure label="Contingency" value={money(totals.contingencyCents)} hint={allowanceHint(settings.contingencyMode, settings.contingencyBps)} />
        <Figure label="Cost total" value={money(totals.costTotalCents)} hint="Ex-GST" strong />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3.5 mt-3.5 pt-3.5 border-t border-brand-border">
        <Figure label="Selling price" value={money(totals.sellCents)} hint={`${PRICING_POLICY_LABELS[settings.pricingPolicy]} · ${formatBps(settings.pricingBps)}`} strong />
        <Figure label="Gross profit" value={money(totals.grossProfitCents)} hint="Selling price − cost total" />
        <Figure label="Markup" value={formatBps(achieved.markupBps)} hint="Gross profit ÷ cost total" />
        <Figure label="Margin" value={formatBps(achieved.marginBps)} hint="Gross profit ÷ selling price" />
        <Figure label="Rate breakdown" value={money(analysed)} hint={`of ${money(totals.boqTotalCents)} analysed`} />
      </div>
      {analysed > 0 && (
        <p className="m-0 mt-2 text-[11.5px] text-brand-muted">
          {COMPONENT_KEYS.map(k => `${COMPONENT_LABELS[k]} ${money(totals[`${k}Cents`])}`).join(' · ')} · Not analysed {money(totals.unanalysedCents)}
        </p>
      )}
    </>
  )
}

function SettingsForm({ form, setForm, codes, disabled }) {
  const set = (patch) => setForm(prev => ({ ...prev, ...patch }))
  const classOf = new Map(form.costCodeClasses.map(c => [c.costCodeId, c.costClass]))
  const setClass = (costCodeId, costClass) => set({
    costCodeClasses: [
      ...form.costCodeClasses.filter(c => c.costCodeId !== costCodeId),
      ...(costClass === COST_CLASS.DIRECT ? [] : [{ costCodeId, costClass }]),
    ],
  })
  const Percent = ({ field, label, off = false }) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        className={inputCls} inputMode="decimal" disabled={disabled || off} aria-label={label}
        value={form[`${field}Text`] ?? bpsToPercentText(form[field])}
        onChange={e => { const bps = percentTextToBps(e.target.value); set({ [`${field}Text`]: e.target.value, [field]: bps ?? NaN }) }}
      />
    </div>
  )
  const Mode = ({ field, bpsField, label }) => (
    <div>
      <label className={labelCls}>{label}</label>
      <select
        className={inputCls} disabled={disabled} value={form[field]} aria-label={label}
        onChange={e => set({ [field]: e.target.value, ...(e.target.value === ALLOWANCE_MODE.PERCENTAGE ? {} : { [bpsField]: 0, [`${bpsField}Text`]: '0' }) })}
      >
        {Object.values(ALLOWANCE_MODE).map(m => <option key={m} value={m}>{ALLOWANCE_MODE_LABELS[m]}</option>)}
      </select>
    </div>
  )
  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="sm:col-span-2">
          <label className={labelCls}>Title</label>
          <input className={inputCls} disabled={disabled} maxLength={120} value={form.title} onChange={e => set({ title: e.target.value })} placeholder="e.g. Tender submission" />
        </div>
        <div>
          <label className={labelCls}>Pricing policy</label>
          <select className={inputCls} disabled={disabled} value={form.pricingPolicy} aria-label="Pricing policy" onChange={e => set({ pricingPolicy: e.target.value })}>
            {Object.values(PRICING_POLICY).map(p => <option key={p} value={p}>{PRICING_POLICY_LABELS[p]}</option>)}
          </select>
        </div>
        {Percent({ field: 'pricingBps', label: form.pricingPolicy === PRICING_POLICY.MARGIN_ON_SELL ? 'Margin % (of selling price)' : 'Markup % (on cost)' })}
        {Mode({ field: 'overheadMode', bpsField: 'overheadBps', label: 'Overheads' })}
        {Percent({ field: 'overheadBps', label: 'Overheads %', off: form.overheadMode !== ALLOWANCE_MODE.PERCENTAGE })}
        {Mode({ field: 'contingencyMode', bpsField: 'contingencyBps', label: 'Contingency' })}
        {Percent({ field: 'contingencyBps', label: 'Contingency %', off: form.contingencyMode !== ALLOWANCE_MODE.PERCENTAGE })}
        <div className="sm:col-span-4">
          <label className={labelCls}>Notes</label>
          <input className={inputCls} disabled={disabled} maxLength={2000} value={form.notes} onChange={e => set({ notes: e.target.value })} placeholder="Assumptions, exclusions" />
        </div>
      </div>
      <p className="m-0 mt-3 mb-1.5 text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px]">Cost code classification</p>
      <p className="m-0 mb-2 text-[11.5px] text-brand-muted">
        Every BOQ item is a direct cost unless its cost code is classified here. A cost-coded overhead or contingency and a percentage of the
        same kind cannot both apply — that would count it twice. Percentages apply to construction cost (direct + preliminaries).
      </p>
      {codes.length === 0 ? <p className="m-0 text-[12px] text-brand-muted">No cost codes on the BOQ yet.</p> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
          {codes.map(c => (
            <label key={c.costCodeId} className="flex items-center justify-between gap-2 text-[12.5px] text-brand-text">
              <span className="truncate">{c.costCodeName}</span>
              <select
                className="bg-brand-bg border border-brand-border rounded-lg px-2 py-1 text-[12px] text-brand-text" disabled={disabled}
                value={classOf.get(c.costCodeId) ?? COST_CLASS.DIRECT} aria-label={`Class of ${c.costCodeName}`}
                onChange={e => setClass(c.costCodeId, e.target.value)}
              >
                {[COST_CLASS.DIRECT, ...ASSIGNABLE_COST_CLASSES].map(k => <option key={k} value={k}>{COST_CLASS_LABELS[k]}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// The optional rate breakdown of ONE BOQ item.
function BreakdownEditor({ item, stored, currencyCode, onSave, onClose }) {
  const write = useWriteAction('Rate breakdown')
  const [form, setForm] = useState(() => Object.fromEntries(COMPONENT_KEYS.map(k => [k, stored?.components?.[k] != null ? String(stored.components[k]) : ''])))
  const components = Object.fromEntries(COMPONENT_KEYS.map(k => [k, form[k].trim() === '' ? 0 : Number(form[k])]))
  const problem = componentsProblem(components, item.rate)
  return (
    <Card className="mb-3.5" >
      <p className="m-0 text-[13px] font-bold text-brand-text">Rate breakdown — {item.itemNumber} {item.description}</p>
      <p className="m-0 mt-0.5 mb-3 text-[11.5px] text-brand-muted">
        Unit rate {formatCurrency(item.rate, currencyCode, { precise: true })} per {item.unit} (set on the BOQ tab). The breakdown analyses that rate — it must add up to it exactly and never changes the cost.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {COMPONENT_KEYS.map(k => (
          <div key={k}>
            <label className={labelCls}>{COMPONENT_LABELS[k]}</label>
            <input className={inputCls} inputMode="decimal" aria-label={`${COMPONENT_LABELS[k]} rate`} value={form[k]} disabled={write.locked} onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))} placeholder="0" />
          </div>
        ))}
      </div>
      {problem && <p className="m-0 mt-2 text-[12px] text-brand-amber">{problem}</p>}
      <div className="mt-2"><WriteFeedback write={write} /></div>
      <div className="flex gap-2 mt-3">
        <Btn sm disabled={write.locked || Boolean(problem)} onClick={() => write.run(() => onSave([{ boqItemId: item.id, components }]), { onConfirmed: onClose })}>
          {write.busy ? 'Saving…' : 'Save breakdown'}
        </Btn>
        {stored && <Btn sm variant="ghost" disabled={write.locked} onClick={() => write.run(() => onSave([{ boqItemId: item.id, components: null }]), { onConfirmed: onClose })}>Clear breakdown</Btn>}
        <Btn sm variant="ghost" disabled={write.busy} onClick={onClose}>Close</Btn>
      </div>
    </Card>
  )
}

export default function ProjectEstimate() {
  const { projectId, currencyCode } = useOutletContext()
  const { profile, profileLoading } = useProfile()
  if (profileLoading) return <div className="text-[13px] text-brand-muted">Loading…</div>
  if (!isFinancialRole(profile?.role)) {
    return (
      <Card>
        <p className="text-[13px] text-brand-text font-semibold m-0">Estimates are restricted</p>
        <p className="text-[12.5px] text-brand-muted m-0 mt-1">
          Estimated cost and selling price are visible to Company Admin, Project Manager, and QS roles only. Access is enforced by Firestore Security Rules.
        </p>
      </Card>
    )
  }
  return <EstimateWorkspace projectId={projectId} currencyCode={currencyCode} role={profile.role} />
}

function EstimateWorkspace({ projectId, currencyCode, role }) {
  const navigate = useNavigate()
  const money = (cents) => formatCurrency(centsToAmount(cents), currencyCode, { precise: true })
  const { boqItems, boqItemsLoading, boqItemsError } = useBoqItems(projectId)
  const { costCodes, costCodesLoading, costCodesError } = useCostCodes()
  const { budgetLines, budgetLinesLoading, budgetLinesError } = useBudgetLines(projectId)
  const {
    estimates, estimatesLoading, estimatesError, itemInputs, itemInputsError,
    newEstimateId, buildEstimate, approveEstimate, discardEstimate, setComponents,
  } = useEstimates(projectId)
  const { transferBoqToBudget } = useBoqBudgetTransfer(projectId)

  const ordered = useMemo(() => [...estimates].sort((a, b) => (b.revisionNumber ?? 0) - (a.revisionNumber ?? 0)), [estimates])
  const approved = useMemo(() => currentApprovedEstimate(estimates), [estimates])
  const [selectedId, setSelectedId] = useState(null)
  const selected = ordered.find(e => e.id === selectedId) ?? approved ?? ordered.find(e => e.state !== ESTIMATE_STATE.DISCARDED) ?? null
  const { lines, linesLoading, linesError } = useEstimateLines(projectId, selected?.id ?? null)

  // The settings form: seeded from the revision it edits (keyed by id and revision).
  const editable = selected?.state === ESTIMATE_STATE.DRAFT || selected?.state === ESTIMATE_STATE.BUILDING
  const formSeed = `${selected?.id ?? 'new'}:${selected?.revision ?? 0}`
  const [formState, setFormState] = useState({ seed: null, form: defaultEstimateSettings() })
  if (formState.seed !== formSeed) setFormState({ seed: formSeed, form: settingsFrom(selected) })
  const form = formState.form
  const setForm = (update) => setFormState(prev => ({ ...prev, form: typeof update === 'function' ? update(prev.form) : update }))
  const settings = useMemo(() => Object.fromEntries(ESTIMATE_SETTINGS_KEYS.map(k => [k, form[k]])), [form])
  const settingsProblem = estimateSettingsProblem(settings)

  const inputMap = useMemo(() => new Map(itemInputs.map(i => [i.id, i])), [itemInputs])
  const sourcesReady = !boqItemsLoading && !boqItemsError && !itemInputsError

  // LIVE PREVIEW — the form's settings over the BOQ as it is now.
  const preview = useMemo(() => {
    if (!sourcesReady || settingsProblem) return null
    const normal = normaliseEstimateSettings(settings)
    const built = buildEstimateLines({ boqItems, itemInputs: inputMap, settings: normal, currencyCode })
    if (built.problems.length > 0) return { problem: describeEstimateProblems(built) }
    const priced = estimateTotals(built.lines, normal)
    return priced.problem ? { problem: priced.problem } : { totals: priced.totals, settings: normal, lineCount: built.lines.length }
  }, [sourcesReady, settingsProblem, settings, boqItems, inputMap, currencyCode])

  // The cost codes the live BOQ uses (for classification).
  const liveCodes = useMemo(() => {
    const map = new Map()
    for (const item of boqItems) if (item.status === 'active' && item.costCodeId) map.set(item.costCodeId, { costCodeId: item.costCodeId, costCodeName: item.costCodeName || item.costCodeId })
    return [...map.values()].sort((a, b) => a.costCodeName.localeCompare(b.costCodeName))
  }, [boqItems])

  // SOURCE — is the live BOQ still the BOQ the selected revision priced?
  const stored = selected && selected.state !== ESTIMATE_STATE.BUILDING && selected.totals ? selected : null
  const drift = useMemo(
    () => (stored && sourcesReady ? estimateDrift(linesLoading || linesError ? [] : lines, boqItems, stored.sourceKey) : null),
    [stored, sourcesReady, lines, linesLoading, linesError, boqItems],
  )
  const approvedDrift = useMemo(
    () => (approved && sourcesReady ? estimateDrift([], boqItems, approved.sourceKey) : null),
    [approved, sourcesReady, boqItems],
  )

  const write = useWriteAction('Estimate')
  // The id of a NEW revision is kept until its request is answered, so a
  // repeat after an uncertain outcome is the SAME request.
  const [pendingId, setPendingId] = useState(null)
  const [shown, setShown] = useState(LINE_PAGE)
  const [breakdownFor, setBreakdownFor] = useState(null)
  const [search, setSearch] = useState('')
  const [transferring, setTransferring] = useState(false)

  // Phase 2 activation (lib/commercialActivation.js): estimating is READ-ONLY
  // until the company is switched over — build, rebuild, approve, discard,
  // rate breakdowns, the handover transfer and the contract-value prefill are
  // withheld; stored revisions stay visible. The BOQ tab's own transfer
  // (ADR-81) is unaffected. UX only; the server refuses regardless.
  const activation = useCommercialActivation()
  const writable = activation.writable
  const canPrepare = writable && canPrepareEstimate(role)
  const canApprove = writable && canApproveEstimate(role)

  function buildNew() {
    const estimateId = pendingId ?? newEstimateId()
    setPendingId(estimateId)
    write.run(() => buildEstimate({ estimateId, expectedRevision: null, settings }), {
      onConfirmed: () => { setPendingId(null); setSelectedId(estimateId) },
    })
  }
  const rebuild = () => write.run(() => (selected.revision > 0
    ? buildEstimate({ estimateId: selected.id, expectedRevision: selected.revision, settings })
    : buildEstimate({ estimateId: selected.id, expectedRevision: null, settings: settingsFrom(selected) })))
  const approve = () => write.run(() => approveEstimate({ estimateId: selected.id, expectedRevision: selected.revision, contentSha256: selected.contentSha256 }))
  const discard = () => write.run(() => discardEstimate({ estimateId: selected.id, expectedRevision: selected.revision ?? 0, reason: 'Discarded from the Estimate page' }))

  const byCode = useMemo(() => estimateByCostCode(lines), [lines])
  const activeItems = useMemo(() => {
    const q = search.trim().toLowerCase()
    return boqItems.filter(i => i.status === 'active' && (q === '' || `${i.itemNumber} ${i.description} ${i.costCodeName}`.toLowerCase().includes(q))).slice(0, 25)
  }, [boqItems, search])

  if (estimatesLoading) return <div className="text-[13px] text-brand-muted">Loading…</div>

  const isCurrentApproved = Boolean(selected && approved && selected.id === approved.id)

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-3.5">
        <div>
          <h2 className="text-[16px] font-bold text-brand-text m-0">Estimate</h2>
          <p className="text-[12.5px] text-brand-muted m-0 mt-0.5">
            Cost and selling price over the Bill of Quantities. Quantities and unit rates are set on the BOQ tab; an estimate revision is a
            stored copy of them, priced.
          </p>
        </div>
        <Btn variant="ghost" sm onClick={() => navigate('../boq')}>Open BOQ</Btn>
      </div>

      <CommercialMaintenanceNotice activation={activation} />

      {(estimatesError || boqItemsError || itemInputsError) && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-red m-0">Estimate data is unavailable</p>
          <p className="text-[12px] text-brand-muted m-0 mt-1">
            {estimatesError ? 'The estimate revisions' : boqItemsError ? 'The BOQ' : 'The rate breakdowns'} could not be loaded — this is not “no estimate”. Reload the page.
          </p>
        </Card>
      )}

      {/* ── Revisions ─────────────────────────────────────────────────────── */}
      <Card className="mb-3.5" padding={false}>
        <div className="px-5 pt-4 pb-2 flex items-center justify-between">
          <p className="text-[13px] font-bold text-brand-text m-0">Revisions</p>
          <p className="m-0 text-[11px] text-brand-muted">{approved ? `Current approved estimate: ${approved.number}` : 'No approved estimate yet'}</p>
        </div>
        {ordered.length === 0 ? (
          <p className="px-5 pb-4 m-0 text-[12.5px] text-brand-muted">No estimate revision yet. Set the pricing below and build the first draft from the BOQ.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead><tr className="border-b border-brand-border">
                <th className={thCls}>Revision</th><th className={thCls}>Title</th><th className={thCls}>Status</th>
                <th className={`${thCls} text-right`}>Cost total</th><th className={`${thCls} text-right`}>Selling price</th>
                <th className={thCls}>Built / approved</th><th className={thCls} />
              </tr></thead>
              <tbody>
                {ordered.map(e => (
                  <tr key={e.id} className={`border-b border-brand-border/60 ${selected?.id === e.id ? 'bg-brand-accent/5' : ''}`}>
                    <td className={`${tdCls} font-semibold whitespace-nowrap`}>{e.number}</td>
                    <td className={tdCls}>{e.title || '—'}</td>
                    <td className={tdCls}>
                      <Badge label={approved?.id === e.id ? 'Approved · current' : (ESTIMATE_STATE_LABELS[e.state] ?? e.state)} variant={ESTIMATE_BADGE_VARIANTS[e.state]} sm />
                    </td>
                    <td className={`${tdCls} text-right tabular-nums`}>{e.totals ? money(e.totals.costTotalCents) : '—'}</td>
                    <td className={`${tdCls} text-right tabular-nums`}>{e.totals ? money(e.totals.sellCents) : '—'}</td>
                    <td className={`${tdCls} whitespace-nowrap`}>{e.state === ESTIMATE_STATE.APPROVED ? `Approved ${formatDate(e.approvedAt)}` : formatDate(e.updatedAt)}</td>
                    <td className={`${tdCls} text-right`}><Btn variant="ghost" sm onClick={() => { setSelectedId(e.id); setShown(LINE_PAGE) }}>{selected?.id === e.id ? 'Open' : 'View'}</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── The selected stored revision ──────────────────────────────────── */}
      {selected && (
        <Card className="mb-3.5" >
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <p className="text-[14px] font-bold text-brand-text m-0">{selected.number}{selected.title ? ` — ${selected.title}` : ''}</p>
              <Badge label={ESTIMATE_STATE_LABELS[selected.state] ?? selected.state} variant={ESTIMATE_BADGE_VARIANTS[selected.state]} sm />
              <span className="text-[11px] text-brand-muted">{selected.state === ESTIMATE_STATE.APPROVED ? 'Approved revision — stored figures, permanent' : selected.state === ESTIMATE_STATE.DRAFT ? 'Draft revision — stored figures, not approved' : ''}</span>
            </div>
            <div className="flex gap-2">
              {selected.state === ESTIMATE_STATE.DRAFT && canApprove && (
                <Btn sm variant="success" disabled={write.locked} onClick={approve}>Approve revision</Btn>
              )}
              {editable && canPrepare && <Btn sm variant="ghost" disabled={write.locked} onClick={discard}>Discard</Btn>}
            </div>
          </div>

          {selected.state === ESTIMATE_STATE.BUILDING && (
            <p className="m-0 mb-2 text-[12.5px] text-brand-amber" data-estimate-state="building">
              This revision is being built or its build was interrupted. It cannot be approved. If it does not finish within a few minutes, rebuild it
              below — nothing partly written is ever treated as an estimate.
            </p>
          )}
          {selected.state === ESTIMATE_STATE.DISCARDED && <p className="m-0 mb-2 text-[12.5px] text-brand-muted">Discarded{selected.discardReason ? ` — ${selected.discardReason}` : ''}. Kept for the record; it can no longer be approved.</p>}

          {stored && <Totals totals={stored.totals} settings={settingsFrom(stored)} currencyCode={currencyCode} />}

          {stored && drift && (
            <div className={`mt-3.5 rounded-lg border px-3 py-2 ${drift.matches ? 'border-brand-accent/25 bg-brand-accent/5' : 'border-brand-amber/30 bg-brand-amber/5'}`} data-estimate-source={drift.matches ? 'matches' : 'changed'}>
              <p className="m-0 text-[12.5px] font-semibold text-brand-text">
                Source: {drift.matches ? 'the live BOQ matches this revision' : 'the live BOQ has changed since this revision'}
              </p>
              <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">
                {drift.matches
                  ? `${stored.lineCount} BOQ items, read ${formatDate(stored.sourceReadAt)}. The figures above are this revision’s stored figures.`
                  : `The figures above are this revision’s STORED figures, not the live BOQ. ${drift.added.length} item${drift.added.length === 1 ? '' : 's'} added, ${drift.removed.length} removed or voided, ${drift.changed.length} changed${linesLoading ? ' (loading detail…)' : ''}.`}
              </p>
              {!drift.matches && [...drift.changed, ...drift.added, ...drift.removed].slice(0, 5).map(d => (
                <p key={d.itemId} className="m-0 text-[11.5px] text-brand-text">· {d.itemNumber} {d.description}{d.fromCents != null && d.toCents !== undefined ? ` — ${money(d.fromCents)} → ${d.toCents === null ? 'unpriced' : money(d.toCents)}` : ''}</p>
              ))}
            </div>
          )}

          {/* Handover — the CURRENT approved revision only. */}
          {isCurrentApproved && stored && (
            <div className="mt-3.5 pt-3.5 border-t border-brand-border" data-estimate-handover-status={approvedDrift?.matches ? 'ready' : 'drifted'}>
              <p className="m-0 text-[12.5px] font-semibold text-brand-text">Commercial handover</p>
              <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">
                Budget: a transfer carries the BOQ’s cost-coded costs ({money(budgetHandoverCents(stored.totals))}) into WORKING budget lines — never the selling price,
                and never an approved budget version. Percentage overheads and contingency are not BOQ items and are not transferred.
                {approvedDrift?.matches
                  ? ' The live BOQ matches this revision, so the transfer can be recorded as its handover.'
                  : ' The live BOQ has changed since this revision: a transfer from here is not available. You can still transfer the BOQ as it stands from the BOQ tab — it will not be recorded as a transfer of this estimate.'}
              </p>
              <div className="flex flex-wrap gap-2 mt-2">
                {canPrepare && (
                  <Btn sm variant="ghost" disabled={!approvedDrift?.matches || budgetLinesLoading || budgetLinesError || costCodesLoading || costCodesError} onClick={() => setTransferring(true)}>
                    Transfer costs to working budget
                  </Btn>
                )}
                {writable && (
                  <Btn sm variant="ghost" onClick={() => navigate('../commercial', { state: { estimatePrefill: { value: centsToAmount(stored.totals.sellCents), number: stored.number } } })}>
                    Use selling price as a contract value prefill
                  </Btn>
                )}
              </div>
              <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
                The prefill opens the Commercial tab with {money(stored.totals.sellCents)} entered for review. Approving an estimate approves no budget and
                establishes no contract value.
              </p>
            </div>
          )}

          <div className="mt-2"><WriteFeedback write={write} /></div>

          {/* Stored lines */}
          {stored && (
            <div className="mt-3.5">
              <p className="m-0 mb-1.5 text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px]">By cost code (stored)</p>
              {linesError ? <p className="m-0 text-[12px] text-brand-red">The stored lines could not be loaded.</p> : linesLoading ? <p className="m-0 text-[12px] text-brand-muted">Loading lines…</p> : (
                <>
                  <div className="overflow-x-auto mb-3">
                    <table className="w-full border-collapse">
                      <thead><tr className="border-b border-brand-border"><th className={thCls}>Cost code</th><th className={thCls}>Class</th><th className={`${thCls} text-right`}>Items</th><th className={`${thCls} text-right`}>Cost</th></tr></thead>
                      <tbody>{byCode.map(c => (
                        <tr key={c.costCodeId} className="border-b border-brand-border/60">
                          <td className={tdCls}>{c.costCodeName}</td><td className={tdCls}>{COST_CLASS_LABELS[c.costClass]}</td>
                          <td className={`${tdCls} text-right tabular-nums`}>{c.itemCount}</td><td className={`${tdCls} text-right tabular-nums`}>{money(c.amountCents)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <p className="m-0 mb-1.5 text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px]">Lines (stored) — {lines.length}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead><tr className="border-b border-brand-border">
                        <th className={thCls}>Item</th><th className={thCls}>Description</th><th className={`${thCls} text-right`}>Qty</th><th className={thCls}>Unit</th>
                        <th className={`${thCls} text-right`}>Rate</th><th className={`${thCls} text-right`}>Cost</th><th className={thCls}>Breakdown</th>
                      </tr></thead>
                      <tbody>{lines.slice(0, shown).map(l => (
                        <tr key={l.itemId} className="border-b border-brand-border/60">
                          <td className={`${tdCls} whitespace-nowrap`}>{l.itemNumber}</td><td className={tdCls}>{l.description}</td>
                          <td className={`${tdCls} text-right tabular-nums`}>{formatQuantity(l.quantity)}</td><td className={tdCls}>{l.unit}</td>
                          <td className={`${tdCls} text-right tabular-nums`}>{formatCurrency(l.rate, currencyCode, { precise: true })}</td>
                          <td className={`${tdCls} text-right tabular-nums`}>{money(l.amountCents)}</td>
                          <td className={`${tdCls} text-[11.5px] text-brand-muted`}>{l.components ? COMPONENT_KEYS.filter(k => l.components[k] > 0).map(k => `${COMPONENT_LABELS[k]} ${l.components[k]}`).join(' · ') : '—'}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                  {lines.length > shown && <Btn sm variant="ghost" className="mt-2" onClick={() => setShown(s => s + 500)}>Show more ({lines.length - shown} remaining)</Btn>}
                </>
              )}
            </div>
          )}
        </Card>
      )}

      {/* ── Pricing and build ─────────────────────────────────────────────── */}
      {canPrepare && (
        <Card className="mb-3.5">
          <p className="text-[13px] font-bold text-brand-text m-0 mb-1">{editable ? `Pricing — ${selected.number} (draft)` : 'Pricing — new draft revision'}</p>
          <p className="m-0 mb-3 text-[11.5px] text-brand-muted">
            {editable ? 'Rebuilding reads the BOQ again and replaces this draft’s stored lines and figures.' : 'Building creates a NEW draft revision from the BOQ as it stands. Earlier revisions are never changed.'}
          </p>
          <SettingsForm form={form} setForm={setForm} codes={liveCodes} disabled={write.locked} />
          {settingsProblem && <p className="m-0 mt-2 text-[12px] text-brand-amber">{Number.isNaN(form.pricingBps) || Number.isNaN(form.overheadBps) || Number.isNaN(form.contingencyBps) ? 'Enter each percentage as a number with at most two decimals.' : settingsProblem}</p>}

          <div className="mt-3.5 rounded-lg border border-brand-border bg-brand-bg/60 p-3" data-estimate-preview>
            <p className="m-0 mb-2 text-[11px] font-bold text-brand-amber uppercase tracking-[0.4px]">Live preview — the BOQ as it is now · not a stored revision</p>
            {!sourcesReady ? <p className="m-0 text-[12px] text-brand-muted">Loading the BOQ…</p>
              : !preview ? <p className="m-0 text-[12px] text-brand-muted">Complete the pricing above to preview.</p>
                : preview.problem ? <p className="m-0 text-[12px] text-brand-amber">{preview.problem}</p>
                  : <Totals totals={preview.totals} settings={preview.settings} currencyCode={currencyCode} />}
          </div>

          <div className="flex flex-wrap gap-2 mt-3">
            {editable && <Btn sm disabled={write.locked || Boolean(settingsProblem) || !preview || Boolean(preview.problem)} onClick={rebuild}>{write.busy ? 'Building…' : 'Rebuild this draft from the BOQ'}</Btn>}
            <Btn sm variant={editable ? 'ghost' : 'primary'} disabled={write.locked || Boolean(settingsProblem) || !preview || Boolean(preview.problem)} onClick={buildNew}>
              {write.busy ? 'Building…' : 'Build new draft revision'}
            </Btn>
          </div>
          {!selected && <div className="mt-2"><WriteFeedback write={write} /></div>}
        </Card>
      )}

      {/* ── Rate breakdowns ───────────────────────────────────────────────── */}
      {canPrepare && sourcesReady && (
        <>
          {breakdownFor && (
            <BreakdownEditor
              key={breakdownFor.id} item={breakdownFor} stored={inputMap.get(breakdownFor.id) ?? null} currencyCode={currencyCode}
              onSave={setComponents} onClose={() => setBreakdownFor(null)}
            />
          )}
          <Card padding={false}>
            <div className="px-5 pt-4 pb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[13px] font-bold text-brand-text m-0">Rate breakdowns (optional)</p>
                <p className="m-0 text-[11.5px] text-brand-muted">Labour, material, plant and subcontractor parts of a unit rate. Used by the next build; stored revisions keep their own.</p>
              </div>
              <input className={`${inputCls} max-w-[260px]`} placeholder="Search BOQ items" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search BOQ items" />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead><tr className="border-b border-brand-border"><th className={thCls}>Item</th><th className={thCls}>Description</th><th className={`${thCls} text-right`}>Unit rate</th><th className={thCls}>Breakdown</th><th className={thCls} /></tr></thead>
                <tbody>{activeItems.map(item => {
                  const input = inputMap.get(item.id)
                  const bad = input ? componentsProblem(input.components, item.rate) : null
                  return (
                    <tr key={item.id} className="border-b border-brand-border/60">
                      <td className={`${tdCls} whitespace-nowrap`}>{item.itemNumber}</td><td className={tdCls}>{item.description}</td>
                      <td className={`${tdCls} text-right tabular-nums`}>{item.rate == null ? '—' : formatCurrency(item.rate, currencyCode, { precise: true })}</td>
                      <td className={`${tdCls} text-[11.5px] ${bad ? 'text-brand-amber' : 'text-brand-muted'}`}>
                        {!input ? 'None' : bad ? 'No longer adds up to the unit rate' : COMPONENT_KEYS.filter(k => input.components[k] > 0).map(k => `${COMPONENT_LABELS[k]} ${input.components[k]}`).join(' · ')}
                      </td>
                      <td className={`${tdCls} text-right`}><Btn variant="ghost" sm disabled={item.rate == null} onClick={() => setBreakdownFor(item)}>{input ? 'Edit' : 'Add'}</Btn></td>
                    </tr>
                  )
                })}</tbody>
              </table>
            </div>
            <p className="px-5 py-2 m-0 text-[11px] text-brand-muted">Showing up to 25 items — search to find others.</p>
          </Card>
        </>
      )}

      <p className="m-0 mt-3 text-[11px] text-brand-muted">
        Ex-GST. Estimates are prepared by Company Admin, Project Manager and QS; a revision is approved by a Company Admin or Project Manager and, where the company requires independent approval, not by the person who prepared it.
      </p>

      {writable && transferring && approved && (
        <BoqBudgetTransferModal
          boqItems={boqItems} budgetLines={budgetLines} costCodes={costCodes} currencyCode={currencyCode}
          sourcesLoading={boqItemsLoading || budgetLinesLoading || costCodesLoading}
          sourcesError={boqItemsError || budgetLinesError || costCodesError}
          estimate={{ id: approved.id, number: approved.number }}
          onTransfer={transferBoqToBudget}
          onClose={() => setTransferring(false)}
        />
      )}
    </div>
  )
}
