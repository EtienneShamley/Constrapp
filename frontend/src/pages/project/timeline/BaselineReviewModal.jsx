import { useEffect, useState } from 'react'
import Btn from '../../../components/Btn'
import ActivityDialog from './ActivityDialog'
import { formatIsoDate } from '../../../lib/projectTimeline'
import { todayIso } from '../../../lib/payments'
import { BASELINE_LIMITS, isSnapshotUsable, validateWithdrawReason } from '../../../lib/ganttBaseline'
import { BASELINE_ERROR } from '../../../lib/programmeBaselineActions'

// ── Review a DRAFT baseline — approve or withdraw (ADR-66) ───────────────────
//
// The approver sees what was captured (when, by whom, how many activities),
// and — from a FRESH SERVER READ through `onCheckDrift` — exactly how the
// programme has changed since the capture: activities edited (revision
// moved), added, cancelled since, or missing. Any drift must be reviewed
// explicitly (a checkbox bound to THAT drift) before Approve is enabled; the
// approve transaction re-reads the server and refuses when the drift changed
// again, so a stale capture is never approved silently.
//
// What approval means, stated on the dialog: the approver accepts the
// identified captured snapshot. It does not certify that the live programme
// cannot change concurrently, and it is planning evidence, not a contractual
// programme acceptance. Self-approval is permitted and is shown.
//
// Withdraw records a reason; approved baselines can never be withdrawn.

const inputCls = 'w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'

const whenText = (ts) => (ts && typeof ts.toDate === 'function' ? formatIsoDate(todayIso(ts.toDate())) : 'saving…')
const whoText = (uid, currentUid) => (uid ? (uid === currentUid ? 'You' : 'Another user') : '—')

function DriftList({ title, items, withRevision = false }) {
  if (!items || items.length === 0) return null
  return (
    <div className="mt-2">
      <p className="m-0 text-[11.5px] font-bold text-brand-text">{title} · {items.length}</p>
      <ul className="m-0 mt-0.5 pl-4 text-[11.5px] text-brand-text-soft space-y-0.5">
        {items.slice(0, 12).map(x => (
          <li key={x.activityId}>
            {x.name || x.activityId}
            {withRevision && <span className="text-brand-muted"> · revision {x.from} → {x.to}</span>}
          </li>
        ))}
        {items.length > 12 && <li className="text-brand-muted">… and {items.length - 12} more</li>}
      </ul>
    </div>
  )
}

export default function BaselineReviewModal({
  header, versionLabel, snapshot, snapshotLoading, snapshotError,
  currentUid, onCheckDrift, onApprove, onWithdraw, onClose,
}) {
  // The drift check — a server read, re-run on demand ("Check again") and
  // after an approve refused for drift. The keyed-result pattern (ADR-41):
  // state is written ONLY from the read's callbacks, and "checking" is
  // DERIVED from whether the result belongs to the current request.
  const [check, setCheck]           = useState({ key: null, drift: null, error: null })
  const [checkToken, setCheckToken] = useState(0)
  const [acknowledgedKey, setAcknowledgedKey] = useState(null)
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawReason, setWithdrawReason] = useState('')
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState(null)

  const usable = isSnapshotUsable(snapshot)
  const selfApproval = Boolean(header?.createdBy) && header.createdBy === currentUid
  const checkKey = usable ? `${snapshot.id ?? ''}:${snapshot.activityCount}:${checkToken}` : null

  useEffect(() => {
    if (!checkKey) return undefined
    let cancelled = false
    const key = checkKey
    onCheckDrift(snapshot)
      .then((d) => { if (!cancelled) setCheck({ key, drift: d, error: null }) })
      .catch((err) => { if (!cancelled) setCheck({ key, drift: null, error: err?.message || 'The programme could not be read from the server.' }) })
    return () => { cancelled = true }
  }, [checkKey, snapshot, onCheckDrift])

  const settled = checkKey !== null && check.key === checkKey
  const checking = checkKey !== null && !settled
  const drift = settled ? check.drift : null
  const checkError = settled ? check.error : null

  // The acknowledgement is bound to ONE drift key: a new drift (a new key)
  // is never pre-acknowledged.
  const driftReviewed = drift ? (!drift.any || acknowledgedKey === drift.key) : false
  const canApprove = usable && !checking && !checkError && drift !== null && driftReviewed && !saving

  async function handleApprove() {
    if (!canApprove) return
    setSaving(true); setError(null)
    try {
      await onApprove(header, snapshot, drift.any ? drift.key : '')
      onClose({ approved: true })
    } catch (err) {
      if (err?.kind === BASELINE_ERROR.DRIFT && err?.details?.drift) {
        // The programme moved again: show the drift the server reported and
        // require a fresh review (its key differs, so nothing is pre-ticked).
        setCheck({ key: checkKey, drift: err.details.drift, error: null })
      }
      setError(err?.message || 'The baseline could not be approved. Nothing was changed.')
      setSaving(false)
    }
  }

  async function handleWithdraw(e) {
    e.preventDefault()
    const reasonError = validateWithdrawReason(withdrawReason)
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

  return (
    <ActivityDialog title="Review draft baseline" titleId="baseline-review-title" onClose={() => onClose(null)} busy={saving} panelClassName="max-w-[640px]">
      <div className="p-5">
        <p className="m-0 text-[15px] font-bold text-brand-text">{header?.name}</p>
        <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">{versionLabel}</p>
        <p className="m-0 mt-2 text-[12px] text-brand-text-soft">{header?.reason}</p>
        <p className="m-0 mt-2 text-[11.5px] text-brand-muted">
          Captured {whenText(header?.createdAt)} by {whoText(header?.createdBy, currentUid)} · {header?.activityCount ?? '—'} activities
        </p>

        {selfApproval && (
          <p className="m-0 mt-3 text-[11.5px] text-brand-amber">
            You captured this draft. Approving it yourself is permitted, and the baseline will show it was
            captured and approved by the same person.
          </p>
        )}

        {/* ── Drift since capture ───────────────────────────────────── */}
        <div className="mt-4 rounded-lg border border-brand-border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="m-0 text-[12.5px] font-bold text-brand-text">Programme changes since capture</p>
            <button
              type="button"
              className="text-[11px] text-brand-accent hover:underline cursor-pointer min-h-[32px] px-1 disabled:opacity-50"
              onClick={() => setCheckToken(t => t + 1)}
              disabled={checking || !usable || saving}
            >
              Check again
            </button>
          </div>
          {snapshotLoading && <p className="m-0 mt-1 text-[12px] text-brand-muted" role="status">Loading the captured snapshot…</p>}
          {snapshotError && <p className="m-0 mt-1 text-[12px] text-brand-amber">The captured snapshot could not be read — it is unavailable, not empty. Approval is disabled.</p>}
          {!snapshotLoading && !snapshotError && !usable && <p className="m-0 mt-1 text-[12px] text-brand-amber">The captured snapshot is missing or unreadable. Approval is disabled.</p>}
          {usable && checking && <p className="m-0 mt-1 text-[12px] text-brand-muted" role="status">Reading the programme from the server…</p>}
          {usable && checkError && <p className="m-0 mt-1 text-[12px] text-brand-amber">{checkError} Approval is disabled until the check succeeds.</p>}
          {usable && !checking && !checkError && drift && !drift.any && (
            <p className="m-0 mt-1 text-[12px] text-brand-text-soft">No activity has changed since this baseline was captured.</p>
          )}
          {usable && !checking && !checkError && drift && drift.any && (
            <>
              <p className="m-0 mt-1 text-[12px] text-brand-amber">
                {drift.total} {drift.total === 1 ? 'activity has' : 'activities have'} changed since the capture. The
                baseline will still hold the dates AS CAPTURED — these changes are not in it.
              </p>
              <DriftList title="Edited since capture" items={drift.changed} withRevision />
              <DriftList title="Added since capture" items={drift.added} />
              <DriftList title="Cancelled since capture" items={drift.cancelledAfter} withRevision />
              <DriftList title="In the capture but not in the programme" items={drift.missing} />
              <label className="mt-3 flex items-start gap-2 text-[12px] text-brand-text cursor-pointer min-h-[44px]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={acknowledgedKey === drift.key}
                  onChange={(e) => setAcknowledgedKey(e.target.checked ? drift.key : null)}
                  disabled={saving}
                />
                <span>I have reviewed these changes and approve the baseline <strong>as captured</strong>, not as the programme stands now.</span>
              </label>
            </>
          )}
        </div>

        <p className="m-0 mt-3 text-[11px] text-brand-muted">
          Approval accepts this captured snapshot and makes it immutable. It does not certify that the live
          programme cannot change afterwards, and it is planning evidence — not a contractual programme
          acceptance or an extension-of-time entitlement. An approved baseline cannot be withdrawn or deleted.
        </p>

        {error && <p className="m-0 mt-3 text-[12px] text-brand-red" role="alert">{error}</p>}

        {/* ── Withdraw ──────────────────────────────────────────────── */}
        {withdrawing ? (
          <form onSubmit={handleWithdraw} className="mt-4 border border-brand-amber/40 rounded-lg p-3">
            <label className={labelCls} htmlFor="baseline-withdraw-reason">Reason for withdrawing this draft *</label>
            <input
              id="baseline-withdraw-reason"
              className={inputCls}
              autoFocus
              maxLength={BASELINE_LIMITS.withdrawReason}
              placeholder="e.g. Captured before the revised access dates were entered"
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
          {!withdrawing && (
            <Btn variant="ghost" type="button" onClick={() => { setWithdrawing(true); setError(null) }} disabled={saving}>Withdraw…</Btn>
          )}
          <Btn type="button" onClick={handleApprove} disabled={!canApprove}>
            {saving && !withdrawing ? 'Approving…' : 'Approve baseline'}
          </Btn>
        </div>
      </div>
    </ActivityDialog>
  )
}
