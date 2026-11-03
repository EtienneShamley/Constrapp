import { useMemo, useState } from 'react'
import Btn from '../../../components/Btn'
import ActivityDialog from '../timeline/ActivityDialog'
import { formatCurrency } from '../../../lib/formatters'
import {
  BUDGET_APPROVAL_LIMITS, buildBudgetCapturePayload, validateBudgetApprovalDraft,
} from '../../../lib/budgetApproval'
import { BUDGET_APPROVAL_ERROR } from '../../../lib/budgetApprovalActions'

// ── Prepare a budget approval — preview, then a DRAFT (ADR-70) ───────────────
//
// Step one of the workflow: Prepare approval → PREVIEW → Capture draft →
// Review → Approve or Withdraw. The preview is computed from the working
// budget lines AS LOADED (the page's listeners) so the user sees what will be
// captured — how many lines, how many cost codes, the total, the estimated
// size — and every line that would REFUSE the capture, named with its
// reason. Nothing is excluded or truncated silently: an invalid line blocks
// the capture until it is corrected on the Budget tab.
//
// The capture itself (useBudgetApprovals → lib/budgetApprovalActions.js)
// re-reads the lines and the cost codes FROM THE SERVER and writes the header
// + snapshot pair in one transaction; this dialog only collects the reason
// and shows the outcome. A draft is NOT an approved budget.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const hintCls  = 'm-0 mt-1 text-[10.5px] text-brand-muted'

function Fact({ label, value }) {
  return (
    <div className="rounded-lg bg-brand-bg/60 px-3 py-2">
      <p className="m-0 text-[10px] font-bold uppercase tracking-[0.4px] text-brand-muted">{label}</p>
      <p className="m-0 mt-0.5 text-[15px] font-black tabular-nums text-brand-text">{value}</p>
    </div>
  )
}

export default function BudgetApprovalCaptureModal({ budgetLines, costCodes, currencyCode, approvedCount = 0, onCapture, onClose }) {
  const money = (n) => formatCurrency(n, currencyCode)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)
  const [problems, setProblems] = useState([])   // the lines a refused capture named

  // The preview — from the loaded register; the capture re-reads the server.
  const preview = useMemo(
    () => buildBudgetCapturePayload(budgetLines, costCodes, { currency: currencyCode }),
    [budgetLines, costCodes, currencyCode],
  )

  async function handleSubmit(e) {
    e.preventDefault()
    const draftError = validateBudgetApprovalDraft({ reason })
    if (draftError) { setError(draftError); return }
    if (!preview.ok) { setError(preview.refusal); return }
    setSaving(true); setError(null); setProblems([])
    try {
      const result = await onCapture({ reason })
      onClose(result)
    } catch (err) {
      setError(err?.message || 'The budget approval could not be captured. Nothing was written.')
      if (err?.kind === BUDGET_APPROVAL_ERROR.INVALID && Array.isArray(err?.details?.errors)) setProblems(err.details.errors)
      setSaving(false)
    }
  }

  const kb = Math.max(1, Math.round(preview.bytes / 1024))

  return (
    <ActivityDialog title="Prepare budget approval" titleId="budget-capture-title" onClose={() => onClose(null)} busy={saving} panelClassName="max-w-[620px]">
      <form onSubmit={handleSubmit} className="p-5">
        <p className="m-0 mb-3 text-[12px] text-brand-text-soft">
          A budget approval is a copy of every working budget line as it stands <strong className="text-brand-text">now</strong>,
          saved as a draft for approval. Once approved it never changes and becomes the project&apos;s Approved Budget
          {approvedCount > 0 ? ` (version ${approvedCount + 1})` : ' (version 1 — the original)'}; the working lines
          stay editable and are compared against it. Approving a budget moves no actual cost, commitment, forecast or
          cash figure.
        </p>

        {/* ── Preview ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
          <Fact label="Budget lines" value={preview.counts.captured} />
          <Fact label="Cost codes" value={preview.counts.costCodes} />
          <Fact label="Total (ex-GST)" value={money(preview.total)} />
          <Fact label="Estimated size" value={`${kb} KB`} />
        </div>
        <p className={hintCls}>
          Every line is captured as stored — including lines on inactive cost codes
          {preview.counts.inactive > 0 ? ` (${preview.counts.inactive} here)` : ''}. Preview from the register as loaded —
          the capture re-reads it from the server. A single approval may hold up to {BUDGET_APPROVAL_LIMITS.entries} lines
          within {Math.round(preview.byteCeiling / 1024)} KB.
        </p>

        {!preview.ok && (
          <div className="border border-brand-amber/40 rounded-lg p-3 mt-3" role="alert">
            <p className="m-0 text-[12px] text-brand-amber font-semibold">{preview.refusal}</p>
            {preview.errors.length > 0 && (
              <ul className="m-0 mt-1.5 pl-4 text-[11.5px] text-brand-amber space-y-0.5">
                {preview.errors.slice(0, 20).map(p => <li key={`${p.lineId}-${p.reason}`}>{p.reason}</li>)}
                {preview.errors.length > 20 && <li>… and {preview.errors.length - 20} more</li>}
              </ul>
            )}
          </div>
        )}

        {/* ── Reason ────────────────────────────────────────────────── */}
        <div className="mt-4">
          <label className={labelCls} htmlFor="budget-approval-reason">Reason *</label>
          <textarea
            id="budget-approval-reason"
            className={`${inputCls} min-h-[72px]`}
            autoFocus
            maxLength={BUDGET_APPROVAL_LIMITS.reason}
            placeholder={approvedCount === 0
              ? 'e.g. Initial approved budget as agreed at award'
              : 'e.g. Re-approved after the approved client variation CV-0004 and the revised scope'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className={hintCls}>
            Recorded with the draft, with your name and the server time. {approvedCount > 0 && 'Approving a new version keeps every earlier approved version unchanged.'}
          </p>
        </div>

        {error && (
          <div className="mt-3" role="alert">
            <p className="m-0 text-[12px] text-brand-red">{error}</p>
            {problems.length > 0 && (
              <ul className="m-0 mt-1 pl-4 text-[11.5px] text-brand-red space-y-0.5">
                {problems.slice(0, 20).map(p => <li key={`${p.lineId}-${p.reason}`}>{p.reason}</li>)}
              </ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={() => onClose(null)} disabled={saving}>Cancel</Btn>
          <Btn type="submit" disabled={saving || !preview.ok}>
            {saving ? 'Capturing…' : 'Capture draft for approval'}
          </Btn>
        </div>
      </form>
    </ActivityDialog>
  )
}
