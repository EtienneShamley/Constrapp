import { useState } from 'react'
import Btn from '../../../components/Btn'
import ActivityDialog from '../timeline/ActivityDialog'
import { segregationEnabled, SEGREGATION_EXPLANATION } from '../../../lib/approvalSegregation'
import {
  FINAL_ACCOUNT_LIMITS, FINAL_ACCOUNT_DISCLAIMER, validateFinalAccountInput, validateFinalAccountWithdrawReason,
  openItemsOf, finalAccountRevisionLabel,
} from '../../../lib/finalAccount'
import { figureText } from '../../../lib/finalAccountDisplay'

// ── Final Account dialogs — prepare, approve, withdraw (ADR-77) ──────────────
//
// Presentation and form state only, on the shared accessible dialog shell.
// Each dialog calls ONE callback the page wires to hooks/useFinalAccounts.jsx
// and shows the action's own message on refusal; nothing is written here.
//
// Every dialog lists the OUTSTANDING BALANCES with their amounts — a genuine
// zero included — and requires an explicit acknowledgement. An outstanding
// receivable, payable, retention or unallocated amount is legitimate at final
// account; it is shown and acknowledged, never hidden and never a zero.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'

function OpenItems({ figures, currencyCode, checked, onChange, disabled, id, verb }) {
  const items = openItemsOf(figures)
  return (
    <fieldset className="m-0 p-3 border border-brand-amber/30 rounded-lg bg-brand-amber/5">
      <legend className="px-1 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-amber">Outstanding balances</legend>
      <ul className="m-0 p-0 list-none flex flex-col gap-1">
        {items.map(item => (
          <li key={item.key} className="flex justify-between gap-3 text-[12.5px] text-brand-text">
            <span>{item.label} <span className="text-brand-muted">({item.basis === 'gross' ? 'gross' : 'ex-GST'})</span></span>
            <span className="font-bold tabular-nums">{figureText(item.value, item.basis, currencyCode)}</span>
          </li>
        ))}
      </ul>
      <label htmlFor={id} className="mt-3 flex items-start gap-2 min-h-[44px] text-[12.5px] text-brand-text cursor-pointer">
        <input id={id} type="checkbox" className="mt-1" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
        <span>I have reviewed these balances. They remain outstanding and are recorded as shown — {verb} does not settle, certify or write off any of them.</span>
      </label>
    </fieldset>
  )
}

export function PrepareFinalAccountModal({ number, figures, currencyCode, onPrepare, onClose }) {
  const [reason, setReason] = useState('')
  const [reference, setReference] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    const input = { reason, reference, acknowledged }
    const invalid = validateFinalAccountInput(input)
    if (invalid) { setError(invalid); return }
    setSaving(true); setError(null)
    try {
      await onPrepare(input)
      onClose()
    } catch (err) {
      setError(err?.message ?? 'The draft could not be prepared.')
      setSaving(false)
    }
  }

  return (
    <ActivityDialog title={`Prepare Final Account — ${finalAccountRevisionLabel({ number })}`} titleId="fa-prepare-title" onClose={onClose} busy={saving}>
      <form onSubmit={submit} className="p-5 flex flex-col gap-4">
        <p className="m-0 text-[12.5px] text-brand-text-soft">
          The draft is built from the project records as the server holds them now. It is a proposal: nothing is final until a Company Admin or
          Project Manager approves it, and approval recalculates every figure independently.
        </p>
        <div>
          <label htmlFor="fa-reason" className={labelCls}>Basis for this Final Account</label>
          <textarea id="fa-reason" autoFocus required rows={3} maxLength={FINAL_ACCOUNT_LIMITS.REASON} className={inputCls}
            value={reason} onChange={e => setReason(e.target.value)} disabled={saving}
            placeholder={number > 1 ? 'What this revision corrects' : 'For example: works complete, all subcontract accounts agreed'} />
        </div>
        <div>
          <label htmlFor="fa-reference" className={labelCls}>Reference (optional)</label>
          <input id="fa-reference" type="text" maxLength={FINAL_ACCOUNT_LIMITS.REFERENCE} className={inputCls}
            value={reference} onChange={e => setReference(e.target.value)} disabled={saving} placeholder="An internal or contract reference" />
        </div>
        <OpenItems figures={figures} currencyCode={currencyCode} checked={acknowledged} onChange={setAcknowledged} disabled={saving} id="fa-prepare-ack" verb="preparing this draft" />
        {error && <p className="m-0 text-[12.5px] text-brand-red" role="alert">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Btn type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn type="submit" disabled={saving}>{saving ? 'Preparing…' : 'Prepare draft'}</Btn>
        </div>
      </form>
    </ActivityDialog>
  )
}

export function ApproveFinalAccountModal({ account, currencyCode, selfApproval, approvalPolicy = null, approvalPolicyKnown = false, onApprove, onClose }) {
  // The server refuses a self-approval when the company's segregation policy is
  // on (ADR-96); the dialog says so instead of claiming it is permitted, and says
  // nothing either way until the policy is known.
  const segregated = approvalPolicyKnown && segregationEnabled(approvalPolicy)
  const selfBlocked = selfApproval && segregated
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function approve() {
    setSaving(true); setError(null)
    try {
      await onApprove(acknowledged)
      onClose()
    } catch (err) {
      setError(err?.message ?? 'The Final Account could not be approved.')
      setSaving(false)
    }
  }

  return (
    <ActivityDialog title={`Approve Final Account — ${finalAccountRevisionLabel(account)}`} titleId="fa-approve-title" onClose={onClose} busy={saving}>
      <div className="p-5 flex flex-col gap-4">
        <p className="m-0 text-[12.5px] text-brand-text-soft">
          Approval is final for this revision: its figures become a permanent record that cannot be edited, withdrawn or deleted. A later
          correction is a new revision. The server recalculates every figure from the project records and approves only if they match this draft.
        </p>
        <p className="m-0 text-[12.5px] font-semibold text-brand-text" role="note">{FINAL_ACCOUNT_DISCLAIMER}</p>
        {selfApproval && approvalPolicyKnown && !segregated && (
          <p className="m-0 text-[12.5px] text-brand-amber" role="note">
            You prepared this draft. Approving it yourself is permitted and is recorded on the revision as a self-approval.
          </p>
        )}
        {selfBlocked && (
          <p className="m-0 text-[12.5px] text-brand-amber" role="note">
            You prepared this draft, so you cannot approve it. {SEGREGATION_EXPLANATION} Another authorised member must approve it.
          </p>
        )}
        {!selfApproval && segregated && (
          <p className="m-0 text-[12.5px] text-brand-text-soft" role="note">
            You did not prepare this draft, so you can approve it. {SEGREGATION_EXPLANATION}
          </p>
        )}
        <OpenItems figures={account.figures} currencyCode={currencyCode} checked={acknowledged} onChange={setAcknowledged} disabled={saving} id="fa-approve-ack" verb="approval" />
        {error && <p className="m-0 text-[12.5px] text-brand-red" role="alert">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Btn type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn type="button" onClick={approve} disabled={saving || !acknowledged || selfBlocked}>{saving ? 'Approving…' : 'Approve revision'}</Btn>
        </div>
      </div>
    </ActivityDialog>
  )
}

export function WithdrawFinalAccountModal({ account, onWithdraw, onClose }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    const invalid = validateFinalAccountWithdrawReason(reason)
    if (invalid) { setError(invalid); return }
    setSaving(true); setError(null)
    try {
      await onWithdraw(reason)
      onClose()
    } catch (err) {
      setError(err?.message ?? 'The draft could not be withdrawn.')
      setSaving(false)
    }
  }

  return (
    <ActivityDialog title={`Withdraw draft — ${finalAccountRevisionLabel(account)}`} titleId="fa-withdraw-title" onClose={onClose} busy={saving} panelClassName="max-w-[520px]">
      <form onSubmit={submit} className="p-5 flex flex-col gap-4">
        <p className="m-0 text-[12.5px] text-brand-text-soft">
          The draft is kept in the revision history as withdrawn and can never be approved. A new draft takes the next revision number.
        </p>
        <div>
          <label htmlFor="fa-withdraw-reason" className={labelCls}>Reason</label>
          <textarea id="fa-withdraw-reason" autoFocus required rows={3} maxLength={FINAL_ACCOUNT_LIMITS.REASON} className={inputCls}
            value={reason} onChange={e => setReason(e.target.value)} disabled={saving} />
        </div>
        {error && <p className="m-0 text-[12.5px] text-brand-red" role="alert">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Btn type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn type="submit" variant="danger" disabled={saving}>{saving ? 'Withdrawing…' : 'Withdraw draft'}</Btn>
        </div>
      </form>
    </ActivityDialog>
  )
}
