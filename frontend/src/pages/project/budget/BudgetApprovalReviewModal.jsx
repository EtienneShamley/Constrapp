import { useEffect, useMemo, useState } from 'react'
import Btn from '../../../components/Btn'
import ActivityDialog from '../timeline/ActivityDialog'
import { formatCurrency, formatDate } from '../../../lib/formatters'
import {
  BUDGET_APPROVAL_LIMITS, isBudgetSnapshotUsable, validateBudgetWithdrawReason,
  approvedByCostCode, approvedTotalOf, snapshotDelta,
} from '../../../lib/budgetApproval'
import { BUDGET_APPROVAL_ERROR } from '../../../lib/budgetApprovalActions'

// ── Review a DRAFT budget approval — approve or withdraw (ADR-70) ────────────
//
// The approver sees what was captured (when, by whom, how many lines, the
// total and the per-cost-code allocation), the difference from the CURRENT
// approved version (when one exists), and — from a FRESH SERVER READ through
// `onCheckDrift` — exactly how the working register has changed since the
// capture: lines edited, added, or missing. Any drift must be reviewed
// explicitly (a checkbox bound to THAT drift) before Approve is enabled; the
// approve transaction re-reads the server and refuses when the drift changed
// again, or when another version was approved meanwhile (the pointer moved),
// so a stale capture is never approved silently.
//
// What approval means, stated on the dialog: the approver accepts the
// identified captured snapshot as the Approved Budget. It does not certify
// that the working register cannot change afterwards. Self-approval is
// permitted and shown. QS may prepare but not approve (the button is hidden;
// Firestore rules enforce it).
//
// Withdraw records a reason; approved versions can never be withdrawn.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const thCls = 'text-left px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted whitespace-nowrap'
const tdCls = 'px-2 py-1.5 text-[12px] text-brand-text whitespace-nowrap'

const whoText = (uid, currentUid) => (uid ? (uid === currentUid ? 'You' : 'Another user') : '—')

function DriftList({ title, items, money, withAmount = false }) {
  if (!items || items.length === 0) return null
  return (
    <div className="mt-2">
      <p className="m-0 text-[11.5px] font-bold text-brand-text">{title} · {items.length}</p>
      <ul className="m-0 mt-0.5 pl-4 text-[11.5px] text-brand-text-soft space-y-0.5">
        {items.slice(0, 12).map(x => (
          <li key={x.lineId}>
            {x.costCodeName || x.lineId}
            {withAmount && <span className="text-brand-muted"> · {money(x.from)} → {x.to === null ? 'invalid' : money(x.to)}</span>}
            {!withAmount && typeof x.amount === 'number' && <span className="text-brand-muted"> · {money(x.amount)}</span>}
          </li>
        ))}
        {items.length > 12 && <li className="text-brand-muted">… and {items.length - 12} more</li>}
      </ul>
    </div>
  )
}

export default function BudgetApprovalReviewModal({
  header, versionLabel, nextVersion, snapshot, snapshotLoading, snapshotError,
  currentSnapshot, currentVersion, seenVersionCount, currencyCode,
  currentUid, canApprove, canWithdraw, onCheckDrift, onApprove, onWithdraw, onClose,
}) {
  const money = (n) => formatCurrency(n, currencyCode)
  const [check, setCheck]           = useState({ key: null, drift: null, error: null })
  const [checkToken, setCheckToken] = useState(0)
  const [acknowledgedKey, setAcknowledgedKey] = useState(null)
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawReason, setWithdrawReason] = useState('')
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState(null)
  const [showAll, setShowAll]       = useState(false)

  const usable = isBudgetSnapshotUsable(snapshot)
  const selfApproval = Boolean(header?.createdBy) && header.createdBy === currentUid
  const checkKey = usable ? `${snapshot.id ?? ''}:${snapshot.entryCount}:${checkToken}` : null

  useEffect(() => {
    if (!checkKey) return undefined
    let cancelled = false
    const key = checkKey
    onCheckDrift(snapshot)
      .then((d) => { if (!cancelled) setCheck({ key, drift: d, error: null }) })
      .catch((err) => { if (!cancelled) setCheck({ key, drift: null, error: err?.message || 'The budget could not be read from the server.' }) })
    return () => { cancelled = true }
  }, [checkKey, snapshot, onCheckDrift])

  const settled = checkKey !== null && check.key === checkKey
  const checking = checkKey !== null && !settled
  const drift = settled ? check.drift : null
  const checkError = settled ? check.error : null

  // The captured allocation by cost code, and the delta against the current
  // approved version (when one exists).
  const byCode = useMemo(() => {
    if (!usable) return []
    const map = approvedByCostCode(snapshot)
    const names = {}
    for (const e of snapshot.entries) if (e?.costCodeId && e.costCodeName) names[e.costCodeId] = e.costCodeName
    return Object.keys(map).map(id => ({ costCodeId: id, costCodeName: names[id] ?? id, amount: map[id] }))
      .sort((a, b) => String(a.costCodeName).localeCompare(String(b.costCodeName)))
  }, [usable, snapshot])
  const delta = useMemo(() => (usable && currentSnapshot ? snapshotDelta(snapshot, currentSnapshot) : null), [usable, snapshot, currentSnapshot])

  const driftReviewed = drift ? (!drift.any || acknowledgedKey === drift.key) : false
  const approvable = canApprove && usable && !checking && !checkError && drift !== null && driftReviewed && !saving

  async function handleApprove() {
    if (!approvable) return
    setSaving(true); setError(null)
    try {
      const result = await onApprove(header, snapshot, drift.any ? drift.key : '', seenVersionCount)
      onClose({ approved: true, version: result?.version })
    } catch (err) {
      if (err?.kind === BUDGET_APPROVAL_ERROR.DRIFT && err?.details?.drift) {
        setCheck({ key: checkKey, drift: err.details.drift, error: null })
      }
      setError(err?.message || 'The budget approval could not be approved. Nothing was changed.')
      setSaving(false)
    }
  }

  async function handleWithdraw(e) {
    e.preventDefault()
    const reasonError = validateBudgetWithdrawReason(withdrawReason)
    if (reasonError) { setError(reasonError); return }
    setSaving(true); setError(null)
    try {
      await onWithdraw(header, withdrawReason)
      onClose({ withdrawn: true })
    } catch (err) {
      setError(err?.message || 'The draft could not be withdrawn. Nothing was changed.')
      setSaving(false)
    }
  }

  const visibleCodes = showAll ? byCode : byCode.slice(0, 8)

  return (
    <ActivityDialog title="Review draft budget approval" titleId="budget-review-title" onClose={() => onClose(null)} busy={saving} panelClassName="max-w-[680px]">
      <div className="p-5">
        <p className="m-0 text-[15px] font-bold text-brand-text">{versionLabel}</p>
        <p className="m-0 mt-2 text-[12px] text-brand-text-soft">{header?.reason}</p>
        <p className="m-0 mt-2 text-[11.5px] text-brand-muted">
          Captured {header?.createdAt ? formatDate(header.createdAt) : 'saving…'} by {whoText(header?.createdBy, currentUid)} ·{' '}
          {header?.entryCount ?? '—'} budget lines · total {typeof header?.total === 'number' ? money(header.total) : '—'} {header?.currency ?? ''}
        </p>

        {selfApproval && canApprove && (
          <p className="m-0 mt-3 text-[11.5px] text-brand-amber">
            You captured this draft. Approving it yourself is permitted, and the version will show it was captured
            and approved by the same person.
          </p>
        )}
        {!canApprove && (
          <p className="m-0 mt-3 text-[11.5px] text-brand-amber">
            Approval is reserved for Company Admin and Project Manager roles (enforced by Firestore Security Rules).
            You can review and withdraw this draft.
          </p>
        )}

        {/* ── Captured allocation ───────────────────────────────────── */}
        <div className="mt-4 rounded-lg border border-brand-border p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="m-0 text-[12.5px] font-bold text-brand-text">Captured allocation by cost code</p>
            {usable && <p className="m-0 text-[12px] font-bold tabular-nums text-brand-text">{money(approvedTotalOf(snapshot))}</p>}
          </div>
          {snapshotLoading && <p className="m-0 mt-1 text-[12px] text-brand-muted" role="status">Loading the captured snapshot…</p>}
          {snapshotError && <p className="m-0 mt-1 text-[12px] text-brand-amber">The captured snapshot could not be read — it is unavailable, not empty. Approval is disabled.</p>}
          {!snapshotLoading && !snapshotError && !usable && <p className="m-0 mt-1 text-[12px] text-brand-amber">The captured snapshot is missing or unreadable. Approval is disabled.</p>}
          {usable && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-brand-border">
                    <th className={thCls}>Cost code</th>
                    <th className={`${thCls} text-right`}>Captured</th>
                    {delta && <th className={`${thCls} text-right`}>Current v{currentVersion}</th>}
                    {delta && <th className={`${thCls} text-right`}>Change</th>}
                  </tr>
                </thead>
                <tbody>
                  {visibleCodes.map(row => {
                    const d = delta?.rows.find(r => r.costCodeId === row.costCodeId)
                    const prev = delta ? (d ? d.previous : row.amount) : null
                    const diff = delta ? (d ? d.difference : 0) : null
                    return (
                      <tr key={row.costCodeId} className="border-b border-brand-border">
                        <td className={`${tdCls} whitespace-normal`}>{row.costCodeName}</td>
                        <td className={`${tdCls} text-right tabular-nums`}>{money(row.amount)}</td>
                        {delta && <td className={`${tdCls} text-right tabular-nums text-brand-muted`}>{prev === null ? '—' : money(prev)}</td>}
                        {delta && (
                          <td className={`${tdCls} text-right tabular-nums ${diff !== 0 ? (diff > 0 ? 'text-brand-amber' : 'text-brand-accent') : 'text-brand-muted'}`}>
                            {diff === 0 ? '—' : `${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}`}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                  {delta && delta.rows.filter(r => r.next === null).slice(0, showAll ? undefined : 4).map(r => (
                    <tr key={`removed-${r.costCodeId}`} className="border-b border-brand-border">
                      <td className={`${tdCls} whitespace-normal text-brand-muted`}>{r.costCodeName} <span className="text-[10.5px]">(not in this capture)</span></td>
                      <td className={`${tdCls} text-right text-brand-muted`}>—</td>
                      <td className={`${tdCls} text-right tabular-nums text-brand-muted`}>{money(r.previous)}</td>
                      <td className={`${tdCls} text-right tabular-nums text-brand-accent`}>−{money(Math.abs(r.difference))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {byCode.length > 8 && (
                <button type="button" onClick={() => setShowAll(s => !s)} className="mt-1 inline-flex min-h-[44px] items-center text-[12px] font-semibold text-brand-accent hover:underline">
                  {showAll ? 'Show fewer' : `Show all ${byCode.length} cost codes`}
                </button>
              )}
              {delta && (
                <p className="m-0 mt-2 text-[11.5px] text-brand-text-soft">
                  Against the current approved version {currentVersion} ({money(delta.previousTotal)}): this draft would
                  {' '}{delta.difference === 0 ? 'leave the total unchanged' : `${delta.difference > 0 ? 'increase' : 'decrease'} the Approved Budget by ${money(Math.abs(delta.difference))}`}
                  {' '}to {money(delta.nextTotal)}. Version {nextVersion} would become current; version {currentVersion} stays as approved.
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── Drift since capture ───────────────────────────────────── */}
        <div className="mt-3 rounded-lg border border-brand-border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="m-0 text-[12.5px] font-bold text-brand-text">Working budget changes since capture</p>
            <button
              type="button"
              className="text-[11px] text-brand-accent hover:underline cursor-pointer min-h-[32px] px-1 disabled:opacity-50"
              onClick={() => setCheckToken(t => t + 1)}
              disabled={checking || !usable || saving}
            >
              Check again
            </button>
          </div>
          {usable && checking && <p className="m-0 mt-1 text-[12px] text-brand-muted" role="status">Reading the budget from the server…</p>}
          {usable && checkError && <p className="m-0 mt-1 text-[12px] text-brand-amber">{checkError} Approval is disabled until the check succeeds.</p>}
          {usable && !checking && !checkError && drift && !drift.any && (
            <p className="m-0 mt-1 text-[12px] text-brand-text-soft">No budget line has changed since this draft was captured.</p>
          )}
          {usable && !checking && !checkError && drift && drift.any && (
            <>
              <p className="m-0 mt-1 text-[12px] text-brand-amber">
                {drift.total} budget {drift.total === 1 ? 'line has' : 'lines have'} changed since the capture. The
                approved version will hold the amounts AS CAPTURED — these changes are not in it.
              </p>
              <DriftList title="Edited since capture" items={drift.changed} money={money} withAmount />
              <DriftList title="Added since capture" items={drift.added} money={money} />
              <DriftList title="In the capture but no longer in the register" items={drift.missing} money={money} />
              <label className="mt-3 flex items-start gap-2 text-[12px] text-brand-text cursor-pointer min-h-[44px]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={acknowledgedKey === drift.key}
                  onChange={(e) => setAcknowledgedKey(e.target.checked ? drift.key : null)}
                  disabled={saving}
                />
                <span>I have reviewed these changes and approve the budget <strong>as captured</strong>, not as the working register stands now.</span>
              </label>
            </>
          )}
        </div>

        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          Approval makes this captured snapshot the project&apos;s Approved Budget and immutable. It changes no actual
          cost, commitment, posted invoice, approved claim, forecast final cost or cash figure. An approved version
          cannot be withdrawn or deleted; a later version supersedes it without altering it.
        </p>

        {error && <p className="m-0 mt-3 text-[12px] text-brand-red" role="alert">{error}</p>}

        {withdrawing ? (
          <form onSubmit={handleWithdraw} className="mt-4 border border-brand-amber/40 rounded-lg p-3">
            <label className={labelCls} htmlFor="budget-withdraw-reason">Reason for withdrawing this draft *</label>
            <input
              id="budget-withdraw-reason"
              className={inputCls}
              autoFocus
              maxLength={BUDGET_APPROVAL_LIMITS.withdrawReason}
              placeholder="e.g. Captured before the revised allocations were entered"
              value={withdrawReason}
              onChange={(e) => setWithdrawReason(e.target.value)}
            />
            <div className="flex justify-end gap-2 mt-3">
              <Btn sm variant="ghost" type="button" onClick={() => setWithdrawing(false)} disabled={saving}>Keep draft</Btn>
              <Btn sm variant="danger" type="submit" disabled={saving}>{saving ? 'Withdrawing…' : 'Withdraw draft'}</Btn>
            </div>
          </form>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={() => onClose(null)} disabled={saving}>Close</Btn>
          {!withdrawing && canWithdraw && (
            <Btn variant="ghost" type="button" onClick={() => { setWithdrawing(true); setError(null) }} disabled={saving}>Withdraw…</Btn>
          )}
          {canApprove && (
            <Btn type="button" onClick={handleApprove} disabled={!approvable}>
              {saving && !withdrawing ? 'Approving…' : `Approve as version ${nextVersion}`}
            </Btn>
          )}
        </div>
      </div>
    </ActivityDialog>
  )
}
